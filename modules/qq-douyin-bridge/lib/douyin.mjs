/**
 * lib/douyin.mjs —— 对接同机 dsh-douyin-scroll 插件的 HTTP API（`/api/douyin-duty/*`）。
 *
 * 那个 API 全部是 HTTP 200 + `{ok:boolean}`（业务失败也是 200），所以这里统一按 `ok` 判。
 * 不直接 spawn 浏览器、不碰登录态：读私信走它的 HTTP 快路径（~1s），发私信走它的无头 Chrome（10–40s）。
 */

/** 路径只允许固定的子路径（防止拼出奇怪的东西）。 */
const ALLOWED_PATHS = Object.freeze([
  '/status',
  '/config',
  '/account',
  '/chat/read',
  '/chat/send',
  '/chat/watch',
  '/dm/people',
  '/inbox',
])

/**
 * 建一个抖音 API 客户端。
 * @param {{ baseUrl?: string, timeoutMs?: number, fetchImpl?: typeof fetch }} [options]
 */
export function createDouyin(options = {}) {
  const baseUrl = String(options.baseUrl || '').replace(/\/+$/, '')
  const timeoutMs = Math.max(2_000, Math.min(Number(options.timeoutMs) || 30_000, 280_000))
  const fetchImpl = options.fetchImpl || globalThis.fetch

  /**
   * @param {'GET'|'POST'} method
   * @param {string} path
   * @param {Record<string, unknown> | null} body
   * @param {number} [timeoutOverride]
   */
  async function request(method, path, body, timeoutOverride) {
    if (!ALLOWED_PATHS.includes(path)) {
      return { ok: false, error: `未支持的抖音接口：${path}` }
    }
    if (baseUrl === '') {
      return { ok: false, error: '抖音接口地址为空（宿主 origin 没取到）' }
    }
    const timeout = Math.max(2_000, Math.min(Number(timeoutOverride) || timeoutMs, 280_000))
    const init = {
      method,
      headers: { accept: 'application/json' },
      signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(timeout)
        : undefined,
    }
    if (method === 'POST') {
      init.headers['content-type'] = 'application/json'
      init.body = JSON.stringify(body || {})
    }
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, init)
      const text = await response.text()
      let parsed = null
      try {
        parsed = JSON.parse(text)
      } catch {
        return { ok: false, error: `抖音接口返回的不是 JSON（HTTP ${response.status}）` }
      }
      if (!response.ok) {
        return { ok: false, error: `抖音接口 HTTP ${response.status}` }
      }
      if (parsed === null || typeof parsed !== 'object' || parsed.ok !== true) {
        const reason = parsed && typeof parsed === 'object'
          ? String(parsed.error || parsed.hint || parsed.detail || '业务失败（ok != true）')
          : '业务失败（ok != true）'
        const needLogin = /登录|cookie|credential|凭证/i.test(reason)
        return { ok: false, error: reason, needLogin, raw: parsed }
      }
      return { ok: true, data: parsed }
    } catch (error) {
      const name = String((error && error.name) || '')
      if (name === 'TimeoutError' || name === 'AbortError') {
        return { ok: false, error: `抖音侧超时（${Math.round(timeout / 1000)}s）` }
      }
      return { ok: false, error: `连不上抖音插件：${String((error && error.message) || error)}` }
    }
  }

  return {
    baseUrl,
    request,
    /** 插件状态（登录、账号、配置）；快。 */
    status: () => request('GET', '/status', null),
    /** 只读配置（dmPeers 等）；快。 */
    config: () => request('GET', '/config', null),
    /** 抖音账号信息；可能慢（缓存命中则快）。 */
    account: () => request('GET', '/account', null),
    /** 读某人的私信（`to_id` 必填才会走 ~1s 的 HTTP 快路径）。 */
    read: (secUid, nick) => request('POST', '/chat/read', { to_id: String(secUid || ''), to: String(nick || '') }),
    /**
     * 发私信（串行调用，调用方负责排队）。
     * 只有 `ok === true && sent === true` 才算发出去（抖音没有 message id 可回读）。
     */
    async send(secUid, nick, text) {
      const result = await request('POST', '/chat/send', {
        to_id: String(secUid || ''),
        to: String(nick || ''),
        text: String(text || ''),
        confirm: true,
      }, 260_000)
      if (!result.ok) return result
      const data = result.data
      if (data.sent === true) return { ok: true, data }
      return { ok: false, error: String(data.error || '抖音没确认发出（sent != true）'), raw: data }
    },
    /** 列最近聊过的人（慢：抖音面板里会起无头浏览器，10–40s）。 */
    dmPeople: () => request('POST', '/dm/people', {}, 180_000),
    /** 抖音插件自己的「盯梢」状态（只读状态文件）；快。 */
    chatWatch: () => request('GET', '/chat/watch', null),
  }
}
