/**
 * lib/onebot.mjs —— SnowLuma / OneBot v11 HTTP API 的最小客户端。
 *
 * 只走 HTTP path-style（`POST /<action>`），不占用 WS 连接、不依赖 QQ 桥接进程。
 * 所有调用统一规整成 `{ ok, data?, error? }`，绝不抛。
 */

/**
 * 把 OneBot v11 响应信封规整成 `{ ok, data }` / `{ ok:false, error }`。
 * 权威判据是 `status === 'ok' && retcode === 0`（HTTP 200 也可能是业务失败）。
 * @param {unknown} raw 响应 JSON
 * @returns {{ ok: true, data: unknown } | { ok: false, error: string, retcode?: number }}
 */
export function normalizeOneBotResponse(raw) {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, error: 'OneBot 返回不是 JSON 对象（QQ 侧未启动？）' }
  }
  const body = /** @type {Record<string, any>} */ (raw)
  const retcode = Number(body.retcode)
  if (body.status === 'ok' && (retcode === 0 || body.retcode === undefined)) {
    return { ok: true, data: body.data ?? null }
  }
  const error = String(body.wording || body.message || body.msg || `OneBot 返回 status=${body.status} retcode=${body.retcode}`)
  return { ok: false, error, retcode: Number.isFinite(retcode) ? retcode : undefined }
}

/**
 * 建一个 OneBot HTTP 客户端。
 * @param {{ baseUrl?: string, token?: string, timeoutMs?: number, fetchImpl?: typeof fetch }} [options]
 */
export function createOneBot(options = {}) {
  const baseUrl = String(options.baseUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '')
  const token = String(options.token || '')
  const timeoutMs = Math.max(1_000, Math.min(Number(options.timeoutMs) || 15_000, 60_000))
  const fetchImpl = options.fetchImpl || globalThis.fetch

  /**
   * 调一个 OneBot action。
   * @param {string} action
   * @param {Record<string, unknown>} [params]
   * @param {number} [timeoutOverride]
   * @returns {Promise<{ ok: boolean, data?: unknown, error?: string }>}
   */
  async function call(action, params = {}, timeoutOverride) {
    const url = `${baseUrl}/${heroAction(action)}`
    const headers = { 'content-type': 'application/json' }
    if (token !== '') headers.authorization = `Bearer ${token}`
    const timeout = Math.max(1_000, Math.min(Number(timeoutOverride) || timeoutMs, 60_000))
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(params || {}),
        signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(timeout)
          : undefined,
      })
      const text = await response.text()
      let parsed = null
      try {
        parsed = JSON.parse(text)
      } catch {
        return { ok: false, error: `QQ 返回的不是 JSON（HTTP ${response.status}）` }
      }
      if (!response.ok) {
        const normalized = normalizeOneBotResponse(parsed)
        return normalized.ok ? normalized : { ok: false, error: `HTTP ${response.status}：${normalized.error}` }
      }
      return normalizeOneBotResponse(parsed)
    } catch (error) {
      const name = String((error && error.name) || '')
      if (name === 'TimeoutError' || name === 'AbortError') {
        return { ok: false, error: `QQ 侧超时（${Math.round(timeout / 1000)}s）` }
      }
      return { ok: false, error: `连不上 QQ 侧（${baseUrl}）：${String((error && error.message) || error)}` }
    }
  }

  return {
    baseUrl,
    call,
    /** 机器人自己的身份（uin + 昵称）。 */
    loginInfo: () => call('get_login_info'),
    /** 好友私聊最近消息（旧 → 新）。 */
    friendHistory: (userId, count = 20) => call('get_friend_msg_history', { user_id: numericId(userId), count: clampCount(count) }),
    /** 群最近消息（旧 → 新）。 */
    groupHistory: (groupId, count = 20) => call('get_group_msg_history', { group_id: numericId(groupId), count: clampCount(count) }),
    /** 发私聊（文本段数组，避免 CQ 码解析）。 */
    sendPrivate: (userId, text) => call('send_private_msg', { user_id: numericId(userId), message: textSegments(text), auto_escape: false }),
    /** 发群聊。 */
    sendGroup: (groupId, text) => call('send_group_msg', { group_id: numericId(groupId), message: textSegments(text), auto_escape: false }),
    /** 发一张图（file 支持 http(s) URL / base64:// / 本地绝对路径，由 OneBot 实现决定）。 */
    sendPrivateImage: (userId, file) => call('send_private_msg', {
      user_id: numericId(userId),
      message: [{ type: 'image', data: { file: String(file ?? '') } }],
      auto_escape: false,
    }),
    /** 发一张图到群。 */
    sendGroupImage: (groupId, file) => call('send_group_msg', {
      group_id: numericId(groupId),
      message: [{ type: 'image', data: { file: String(file ?? '') } }],
      auto_escape: false,
    }),
    /** 发一条视频消息（file 一般是本地 mp4 绝对路径；视频必须是整条消息里唯一的段）。 */
    sendPrivateVideo: (userId, file) => call('send_private_msg', {
      user_id: numericId(userId),
      message: [{ type: 'video', data: { file: String(file ?? '') } }],
      auto_escape: false,
    }),
    /** 发视频消息到群。 */
    sendGroupVideo: (groupId, file) => call('send_group_msg', {
      group_id: numericId(groupId),
      message: [{ type: 'video', data: { file: String(file ?? '') } }],
      auto_escape: false,
    }),
    /** 发一条语音（record 段；本地 mp3/wav 由 OneBot 服务端转码成 QQ 语音）。 */
    sendPrivateVoice: (userId, file) => call('send_private_msg', {
      user_id: numericId(userId),
      message: [{ type: 'record', data: { file: String(file ?? '') } }],
      auto_escape: false,
    }),
    /** 发语音到群。 */
    sendGroupVoice: (groupId, file) => call('send_group_msg', {
      group_id: numericId(groupId),
      message: [{ type: 'record', data: { file: String(file ?? '') } }],
      auto_escape: false,
    }),
    /** 查单条消息（引用判定兜底用）。 */
    getMsg: (messageId) => {
      const id = Number(String(messageId).trim())
      if (!Number.isFinite(id) || id === 0) return Promise.resolve({ ok: false, error: `message_id 不合法：${messageId}` })
      return call('get_msg', { message_id: id })
    },
  }
}

/** 转成正整数 id；非法给 0（让服务端明确报错，而不是发错人）。 */
function numericId(value) {
  const num = Number(String(value).trim())
  return Number.isFinite(num) && num > 0 ? num : 0
}

/** 条数夹到 1..50。 */
function clampCount(value) {
  const num = Math.round(Number(value) || 20)
  return Math.max(1, Math.min(num, 50))
}

/** 文本 → OneBot 消息段数组。 */
function textSegments(text) {
  return [{ type: 'text', data: { text: String(text ?? '') } }]
}

/** 防御：action 只允许字母/下划线。 */
function heroAction(action) {
  return String(action || '').replace(/[^A-Za-z_]/g, '')
}
