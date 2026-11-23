/**
 * lib/links.mjs —— 抖音链接识别（纯函数 + 一个可注入 fetch 的短链解析）。
 *
 * 支持：
 *   · https://www.douyin.com/video/<19位id>
 *   · https://www.douyin.com/note/<19位id>
 *   · https://www.iesdouyin.com/share/video/<id>/?...
 *   · https://m.douyin.com/share/video/<id>
 *   · https://www.douyin.com/discover?modal_id=<id>
 *   · https://v.douyin.com/<短码>/           （短链，需要跟随 302 才能拿到 id）
 *   · 裸的 15–25 位纯数字（当 aweme_id）
 */

/** 文本里抓 URL（含中英文标点、弯引号截断）。 */
const URL_RE = /https?:\/\/[^\s"'“”‘’<>()[\]{}（）【】「」《》，。；：！？、]+/gi

/** URL 末尾常见标点，剔掉。 */
const TAIL_PUNCT = /[.,;:!?'"“”‘’)\]}>）】」》〉，。；：！？、]+$/

/** 只在用户明确要求时才打开的域名（防止打开任意网页）。 */
const ALLOWED_HOSTS = Object.freeze(['douyin.com', 'iesdouyin.com'])

/**
 * 从一段文字里抓所有链接（去重，按出现顺序）。
 * @param {unknown} text
 * @returns {string[]}
 */
export function extractUrls(text) {
  const source = String(text ?? '')
  const seen = new Set()
  const out = []
  for (const match of source.matchAll(URL_RE)) {
    const url = String(match[0]).replace(TAIL_PUNCT, '')
    if (url === '' || seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}

/**
 * 是不是抖音域名（douyin.com / iesdouyin.com 及其子域）。
 * @param {unknown} url
 * @returns {boolean}
 */
export function isDouyinUrl(url) {
  try {
    const parsed = new URL(String(url ?? ''))
    const host = parsed.hostname.toLowerCase()
    return ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
  } catch {
    return false
  }
}

/**
 * 单条 URL 分类。
 * @param {unknown} url
 * @returns {{ kind: 'video'|'note'|'short'|'unknown', aweme_id?: string, canonical?: string }}
 */
export function classifyDouyinUrl(url) {
  const value = String(url ?? '')
  if (!isDouyinUrl(value)) return { kind: 'unknown' }
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return { kind: 'unknown' }
  }
  const path = parsed.pathname
  const idMatch = /\/(?:share\/)?(?:video|note)\/(\d{6,25})/.exec(path)
  if (idMatch) {
    const awemeId = idMatch[1]
    return {
      kind: path.includes('/note/') ? 'note' : 'video',
      aweme_id: awemeId,
      canonical: canonicalVideoUrl(awemeId),
    }
  }
  const modal = parsed.searchParams.get('modal_id')
  if (modal && /^\d{6,25}$/.test(modal)) {
    return { kind: 'video', aweme_id: modal, canonical: canonicalVideoUrl(modal) }
  }
  const host = parsed.hostname.toLowerCase()
  if (host === 'v.douyin.com' && parsed.pathname.replace(/\//g, '').length >= 3) {
    return { kind: 'short' }
  }
  return { kind: 'unknown' }
}

/** 裸 id 判断。 */
export function isAwemeId(value) {
  return /^\d{15,25}$/.test(String(value ?? '').trim())
}

/**
 * 规范分享链接（永远用 www.douyin.com/video/<id>，点开就是那条视频）。
 * @param {unknown} awemeId
 * @returns {string}
 */
export function canonicalVideoUrl(awemeId) {
  const id = String(awemeId ?? '').trim()
  return id === '' ? '' : `https://www.douyin.com/video/${id}`
}

/**
 * 把一条输入（链接 / 短链 / 裸 id）解析成目标。
 * @param {unknown} input
 * @returns {{ kind: 'video'|'note'|'short', aweme_id?: string, canonical?: string, short_url?: string } | null}
 */
export function parseTarget(input) {
  const value = String(input ?? '').trim()
  if (value === '') return null
  if (isAwemeId(value)) {
    return { kind: 'video', aweme_id: value, canonical: canonicalVideoUrl(value) }
  }
  const urls = extractUrls(value)
  const first = urls.length > 0 ? urls[0] : (isDouyinUrl(value) ? value : '')
  if (first === '') return null
  const classified = classifyDouyinUrl(first)
  if (classified.kind === 'short') return { kind: 'short', short_url: first }
  if (classified.kind === 'video' || classified.kind === 'note') {
    return { kind: classified.kind, aweme_id: classified.aweme_id, canonical: classified.canonical, url: first }
  }
  return null
}

/**
 * 从一段文字里挑出所有抖音目标（去重；短链原样返回，等调用方异步解析）。
 * @param {unknown} text
 * @returns {Array<{ kind: 'video'|'note'|'short', aweme_id?: string, canonical?: string, short_url?: string }>}
 */
export function extractTargets(text) {
  const out = []
  const seen = new Set()
  const push = (target) => {
    if (target === null || target === undefined) return
    const key = target.aweme_id ? `id:${target.aweme_id}` : `url:${target.short_url || ''}`
    if (key === 'url:' || seen.has(key)) return
    seen.add(key)
    out.push(target)
  }
  for (const url of extractUrls(text)) {
    push(parseTarget(url))
  }
  const raw = String(text ?? '').trim()
  if (isAwemeId(raw)) push(parseTarget(raw))
  return out
}

/**
 * 去掉文字里的抖音链接（用于「只保留人话」的场景）。
 * @param {unknown} text
 * @returns {{ text: string, links: string[] }}
 */
export function stripDouyinLinks(text) {
  const source = String(text ?? '')
  const links = extractUrls(source).filter(isDouyinUrl)
  let rest = source
  for (const link of links) rest = rest.split(link).join(' ')
  return { text: rest.replace(/[ \t]{2,}/g, ' ').trim(), links }
}

/**
 * 跟随 302 把 v.douyin.com 短链解析成完整链接（拿 aweme_id）。
 * 抖音对无浏览器指纹的请求可能直接断连；失败时调用方要如实报错，别猜。
 * @param {string} shortUrl
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, url?: string, aweme_id?: string, error?: string }>}
 */
export async function resolveShortLink(shortUrl, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const timeout = Math.max(2_000, Math.min(Number(options.timeoutMs) || 10_000, 30_000))
  try {
    const response = await fetchImpl(shortUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml',
      },
      signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(timeout)
        : undefined,
    })
    const finalUrl = String(response.url || shortUrl)
    const direct = classifyDouyinUrl(finalUrl)
    if (direct.aweme_id) return { ok: true, url: finalUrl, aweme_id: direct.aweme_id }
    // 有些短链 302 到分享页，id 只在 HTML/查询里 —— 兜底再抓一次。
    let body = ''
    try {
      body = await response.text()
    } catch {
      body = ''
    }
    const hit = /(?:video|note)\/(\d{15,25})/.exec(body) || /modal_id=(\d{15,25})/.exec(body)
    if (hit) {
      return { ok: true, url: finalUrl, aweme_id: hit[1] }
    }
    return { ok: false, url: finalUrl, error: `短链跳到了不认识的地址：${finalUrl.slice(0, 120)}` }
  } catch (error) {
    const name = String((error && error.name) || '')
    const reason = name === 'TimeoutError' || name === 'AbortError' ? '解析超时' : String((error && error.message) || error)
    return { ok: false, error: `短链解析失败（${reason}）——把完整视频链接贴过来也行` }
  }
}

/**
 * 把用户/AI 给的 url / aweme_id / 一段文字解析成一个抖音视频 id。
 * 短链会在这里异步解析；解析不了返回 ok:false。
 * @param {{ url?: string, aweme_id?: string, text?: string, fetchImpl?: typeof fetch }} input
 * @returns {Promise<{ ok: true, aweme_id: string, canonical: string } | { ok: false, error: string }>}
 */
export async function resolveAwemeTarget(input = {}) {
  const direct = parseTarget(input.aweme_id) || parseTarget(input.url) || parseTarget(input.text)
  if (direct === null) {
    // 再宽容一点：从长文字里找第一个抖音链接
    const targets = extractTargets(input.text ?? '')
    const first = targets.find((target) => target.aweme_id) || targets[0]
    if (first === undefined) return { ok: false, error: '没找到抖音视频链接或 aweme_id' }
    if (first.aweme_id) return { ok: true, aweme_id: first.aweme_id, canonical: first.canonical || canonicalVideoUrl(first.aweme_id) }
    const resolved = await resolveShortLink(first.short_url, { fetchImpl: input.fetchImpl })
    if (!resolved.ok) return { ok: false, error: resolved.error || '短链解析失败' }
    return { ok: true, aweme_id: resolved.aweme_id, canonical: canonicalVideoUrl(resolved.aweme_id) }
  }
  if (direct.aweme_id) {
    return { ok: true, aweme_id: direct.aweme_id, canonical: direct.canonical || canonicalVideoUrl(direct.aweme_id) }
  }
  if (direct.kind === 'short' && direct.short_url) {
    const resolved = await resolveShortLink(direct.short_url, { fetchImpl: input.fetchImpl })
    if (!resolved.ok) return { ok: false, error: resolved.error || '短链解析失败' }
    return { ok: true, aweme_id: resolved.aweme_id, canonical: canonicalVideoUrl(resolved.aweme_id) }
  }
  return { ok: false, error: '没找到抖音视频链接或 aweme_id' }
}
