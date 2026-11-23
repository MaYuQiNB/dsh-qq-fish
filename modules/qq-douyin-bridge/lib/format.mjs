/**
 * lib/format.mjs —— 文案与指纹（纯函数，可单测）。
 */

/** 抖音 → QQ 的消息前缀；也是「引用判定」的兜底识别标记。 */
export const MARK = '【抖音·'

/** 匹配以 MARK 开头的转发消息（昵称里可能有中文/字母/数字/下划线）。 */
export const QQ_MARK_RE = /^【抖音·([^】]{0,40})】\s?/

/**
 * 截断文本，绝不留半个代理对导致乱码。
 * @param {unknown} value 原文
 * @param {number} max 最大长度
 * @returns {string}
 */
export function clip(value, max = 500) {
  const text = String(value ?? '')
  if (!Number.isFinite(max) || max <= 0) return ''
  if (text.length <= max) return text
  let cut = text.slice(0, max)
  // 别把 emoji 的代理对切一半（否则 QQ / 抖音里会出现乱码方块）
  const last = cut.charCodeAt(cut.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
  return cut
}

/** ISO 时间（非法输入给空串）。 */
export function nowIso(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date)
  return Number.isNaN(value.getTime()) ? '' : value.toISOString()
}

/** 本地 HH:mm:ss（UI 日志用；纯展示，不参与逻辑）。 */
export function clockOf(iso) {
  const value = new Date(String(iso ?? ''))
  if (Number.isNaN(value.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`
}

/**
 * 抖音消息 → 发到 QQ 的一行文本。
 * 卡片消息如果带了 `item_id`，额外附一条可点的抖音链接（QQ 里能直接点开）。
 * @param {{ nick?: string, text?: string, kind?: string, item_id?: string }} input
 * @returns {string}
 */
export function formatDouyinForQQ(input = {}) {
  const nick = clip(String(input.nick ?? '').trim(), 40) || '抖音好友'
  const raw = String(input.text ?? '').trim()
  const kind = String(input.kind ?? 'text')
  const body = raw === ''
    ? (kind === 'card' ? '[分享卡片]' : '[非文字消息]')
    : (kind === 'card' ? `[卡片] ${raw}` : raw)
  const itemId = String(input.item_id ?? '').trim()
  const link = /^\d{6,25}$/.test(itemId) ? `\nhttps://www.douyin.com/video/${itemId}` : ''
  return `${MARK}${nick}】${clip(body, 1800)}${link}`
}

/**
 * 去掉 QQ 侧的转发前缀（`回：` / `回:` / 前后空格都算）。
 * @param {string} text 原文
 * @param {string} prefix 前缀；空串表示不剥
 * @returns {{ matched: boolean, text: string }}
 */
export function stripPrefix(text, prefix) {
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
 * 消息指纹：方向 + 文本前 60 字（抖音没有稳定消息 id，只能这样去重）。
 * @param {string} from `me` / `them` / `unknown`
 * @param {string} text 正文
 * @returns {string}
 */
export function dedupeKey(from, text) {
  return `${String(from ?? '')}|${String(text ?? '').slice(0, 60)}`
}

/** 统计文本里有几个「像中文/字母」的字符（空消息过滤用）。 */
export function hasContent(text) {
  return /[\p{L}\p{N}]/u.test(String(text ?? ''))
}
