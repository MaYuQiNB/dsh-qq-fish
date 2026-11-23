/**
 * lib/filter.mjs —— 转发判定（纯函数，无 IO，自检重点）。
 *
 * 这里只做「哪些该转、哪些不该转」的判断；真正的发送在 index.js。
 */

/**
 * 把 OneBot 的 `message` 字段（字符串或消息段数组）拆成段数组。
 * @param {unknown} message
 * @returns {Array<{type?: string, data?: Record<string, unknown>}>}
 */
export function segmentsOf(message) {
  if (Array.isArray(message)) {
    return message.filter((seg) => seg !== null && typeof seg === 'object')
  }
  return []
}

/**
 * 取一条 OneBot 消息的纯文本（只拼 `text` 段，其它段留空）。
 * @param {unknown} message
 * @returns {string}
 */
export function textOf(message) {
  if (typeof message === 'string') return message
  const parts = []
  for (const seg of segmentsOf(message)) {
    if (seg.type !== 'text') continue
    const text = seg.data && typeof seg.data === 'object' ? seg.data.text : undefined
    if (typeof text === 'string' && text !== '') parts.push(text)
  }
  return parts.join('')
}

/**
 * 一条消息引用了哪条消息（`reply` 段的 id），没有就 null。
 * @param {unknown} message
 * @returns {string | null}
 */
export function replyToIdOf(message) {
  for (const seg of segmentsOf(message)) {
    if (seg.type !== 'reply') continue
    const id = seg.data && typeof seg.data === 'object' ? seg.data.id : undefined
    if (id !== undefined && id !== null && String(id).trim() !== '') return String(id).trim()
  }
  return null
}

/** 抖音消息指纹：真实时间 + 方向 + 正文前 60 字（没有稳定消息 id，只能这样）。 */
export function douyinFingerprint(message) {
  const at = String(message && message.at ? message.at : '')
  const from = String(message && message.from ? message.from : '')
  const text = String(message && message.text ? message.text : '')
  return `${at}|${from}|${text.slice(0, 60)}`
}

/**
 * 抖音侧：挑出这一轮新出现的「对方消息」。
 *
 * 首轮（`primed=false`）只对表、不返回任何消息 —— 避免刚绑定就把一屏旧消息刷到 QQ。
 * `skipCards=true` 时跳过「分享视频/作品」卡片（kind=card）：不往 QQ 发，但仍记指纹推进水位。
 *
 * @param {{ messages?: unknown[], primed?: boolean, lastAt?: string, keys?: string[],
 *   skipCards?: boolean }} input
 * @returns {{ fresh: Array<{from: string, text: string, at: string, kind: string,
 *   item_id: string, cover: string}>, baseline: boolean,
 *             next: { primed: boolean, lastAt: string, keys: string[] } }}
 */
export function pickNewDouyin(input = {}) {
  const messages = Array.isArray(input.messages) ? input.messages : []
  const primed = input.primed === true
  const lastAt = String(input.lastAt || '')
  const keys = Array.isArray(input.keys) ? input.keys.map(String) : []
  const skipCards = input.skipCards === true
  const seen = new Set(keys)

  /** @type {Array<{from: string, text: string, at: string, kind: string, item_id: string, cover: string}>} */
  const theirs = []
  /** 所有对方消息（含被 skipCards 跳过的卡片）：只用来推水位/记指纹，避免跳过的那条每轮重现。 */
  /** @type {Array<{from: string, text: string, at: string, kind: string, item_id: string, cover: string}>} */
  const allThem = []
  for (const raw of messages) {
    if (raw === null || typeof raw !== 'object') continue
    const msg = /** @type {Record<string, unknown>} */ (raw)
    if (String(msg.from || '') !== 'them') continue
    const text = String(msg.text || '').trim()
    if (text === '') continue
    const kind = String(msg.kind || 'text')
    const row = {
      from: 'them',
      text,
      at: String(msg.at || ''),
      kind,
      // v0.4：抖音卡片（分享的视频）带 itemId + 封面签名 URL（由 im-http.py 额外透出）
      item_id: String(msg.item_id || ''),
      cover: String(msg.cover || ''),
    }
    allThem.push(row)
    if (skipCards && kind === 'card') continue
    theirs.push(row)
  }

  const allKeys = allThem.map((msg) => douyinFingerprint(msg))
  /** 水位：取最大 at（ISO 字符串可直接比大小；空串排最前）。 */
  let maxAt = lastAt
  for (const msg of allThem) {
    if (msg.at !== '' && msg.at > maxAt) maxAt = msg.at
  }
  const nextKeys = [...new Set([...allKeys, ...keys])].slice(-200)
  const next = { primed: true, lastAt: maxAt, keys: nextKeys }

  if (!primed) return { fresh: [], baseline: true, next }

  const fresh = theirs.filter((msg) => {
    const key = douyinFingerprint(msg)
    // 未对过表的历史消息不算新；已见过的同一条也不算。
    if (seen.has(key)) return false
    if (lastAt !== '' && msg.at !== '' && msg.at < lastAt) return false
    return true
  })
  return { fresh, baseline: false, next }
}

/**
 * QQ 侧：挑出这一轮要转发到抖音的消息。
 *
 * 过滤顺序：
 *   1. 机器人自己发的（`user_id`/`sender.user_id` == selfUin）—— 桥接转发出去的那条也在内；
 *   2. 已经处理过的 `message_id`；
 *   3. `filter`：all 全转；prefix 只看前缀；quote 只看「引用/回复了转发消息」的发言；
 *   4. 空文本 / 超长 / 超出单轮上限。
 *
 * @param {{
 *   messages?: unknown[], selfUin?: string, primed?: boolean, lastTime?: number,
 *   ids?: string[], filter?: string, prefix?: string, forwardedIds?: string[],
 *   quotedOk?: string[], skipIds?: string[], limit?: number,
 * }} input
 * @returns {{
 *   items: Array<{ id: string, at: number, text: string, via: 'all'|'prefix'|'quote' }>,
 *   filtered: number, overLimit: number,
 *   next: { primed: boolean, lastTime: number, ids: string[] },
 * }}
 */
export function pickQqIngest(input = {}) {
  const messages = Array.isArray(input.messages) ? input.messages : []
  const selfUin = String(input.selfUin || '')
  const primed = input.primed === true
  const lastTime = Number(input.lastTime) || 0
  const ids = Array.isArray(input.ids) ? input.ids.map(String) : []
  const filter = ['all', 'quote', 'prefix'].includes(String(input.filter)) ? String(input.filter) : 'quote'
  const prefix = String(input.prefix ?? '回：')
  const forwarded = new Set((Array.isArray(input.forwardedIds) ? input.forwardedIds : []).map(String))
  const quoted = new Set((Array.isArray(input.quotedOk) ? input.quotedOk : []).map(String))
  const skip = new Set((Array.isArray(input.skipIds) ? input.skipIds : []).map(String))
  const limit = Math.max(1, Math.min(Number(input.limit) || 5, 20))

  const seen = new Set(ids)
  /** @type {Array<{ id: string, at: number, text: string, replyId: string | null }>} */
  const candidates = []
  const allIds = []
  let maxTime = lastTime

  for (const raw of messages) {
    if (raw === null || typeof raw !== 'object') continue
    const msg = /** @type {Record<string, unknown>} */ (raw)
    const messageId = msg.message_id ?? msg.real_id
    const id = messageId === undefined || messageId === null ? '' : String(messageId)
    if (id !== '') allIds.push(id)
    const sender = msg.sender && typeof msg.sender === 'object' ? msg.sender : {}
    const senderId = sender.user_id ?? msg.user_id
    const time = Number(msg.time) || 0
    if (time > maxTime) maxTime = time
    // ① 机器人自己发的
    if (selfUin !== '' && (String(senderId ?? '') === selfUin || String(msg.user_id ?? '') === selfUin)) continue
    if (id === '' || seen.has(id)) continue
    if (skip.has(id)) continue
    const text = textOf(msg.message).trim()
    if (text === '') continue
    candidates.push({ id, at: time, text, replyId: replyToIdOf(msg.message) })
  }

  // 水位 = 本轮见到的最新时间；ids 滚动保留最近 200 个。
  let nextIds = [...new Set([...ids, ...allIds])].slice(-200)
  const next = { primed: true, lastTime: maxTime, ids: nextIds }

  if (!primed) {
    return { items: [], filtered: 0, overLimit: 0, next }
  }

  /** @type {Array<{ id: string, at: number, text: string, via: 'all'|'prefix'|'quote' }>} */
  const picked = []
  let filtered = 0
  for (const cand of candidates) {
    if (cand.at !== 0 && lastTime !== 0 && cand.at < lastTime - 1) continue // 明显早于水位的旧消息
    if (filter === 'all') {
      picked.push({ id: cand.id, at: cand.at, text: cand.text, via: 'all' })
      continue
    }
    if (filter === 'prefix') {
      const stripped = stripPrefixLocal(cand.text, prefix)
      if (!stripped.matched || stripped.text === '') { filtered += 1; continue }
      picked.push({ id: cand.id, at: cand.at, text: stripped.text, via: 'prefix' })
      continue
    }
    // quote
    const replyId = cand.replyId
    const hit = replyId !== null && (forwarded.has(replyId) || quoted.has(replyId))
    if (!hit) { filtered += 1; continue }
    picked.push({ id: cand.id, at: cand.at, text: cand.text, via: 'quote' })
  }

  const items = picked.slice(0, limit)
  const overflowItems = picked.slice(limit)
  const overLimit = overflowItems.length
  return { items, filtered, overLimit, overflowItems, next }
}

/** 本地版 stripPrefix（避免 filter.mjs 反向依赖 format.mjs；行为与 format.stripPrefix 一致）。 */
function stripPrefixLocal(text, prefix) {
  const source = String(text ?? '')
  const mark = String(prefix ?? '')
  if (mark === '') return { matched: false, text: source }
  const normalized = mark.endsWith('：') || mark.endsWith(':') ? mark.slice(0, -1) : mark
  const trimmed = source.replace(/^\s+/, '')
  for (const candidate of [mark, `${normalized}：`, `${normalized}:`, normalized]) {
    if (candidate === '') continue
    if (trimmed.startsWith(candidate)) {
      return { matched: true, text: trimmed.slice(candidate.length).replace(/^\s+/, '') }
    }
  }
  return { matched: false, text: source }
}

/**
 * 被引用消息的原文是不是我们转过去的抖音消息（引用判定的兜底）。
 * @param {unknown} rawText 被引用消息的 raw_message / 拼出来的文本
 * @returns {boolean}
 */
export function looksLikeForwardedMark(rawText) {
  return String(rawText ?? '').trim().startsWith('【抖音·')
}
