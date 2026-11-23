/**
 * lib/douyin-tools.mjs —— 复用「刷抖音」插件（dsh-douyin-scroll）已有的脚本能力：
 *
 *   · 视频信息：`node <插件>/tools/cdp-fetch.mjs --path "/aweme/v1/web/aweme/detail/?…"`
 *     （在已登录的无头页面里带签名取 JSON，实测 1–3 秒）
 *   · 热评：`<插件>/.venv/Scripts/python.exe tools/api-comments.py <aweme_id>`
 *     （签名只读接口，实测 ~12 秒）
 *   · 分享卡片：`node <插件>/tools/card-share.mjs <aweme_id> <昵称> --to-id <sec_uid>`
 *     （无头 Chrome 里点「分享给朋友」，20–60 秒；**必须**调用方先拿到用户同意）
 *
 * 本模块只负责「找到插件、起进程、解析输出」；不发任何东西，除非调用方调 shareCard()。
 * 纯解析函数单独导出，selfcheck 可离线测。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { canonicalVideoUrl } from './links.mjs'
import { dshHome } from './paths.mjs'

/** 本插件自带的视频解码脚本（用「刷抖音」venv 里的 imageio-ffmpeg）。 */
const EXTRACT_SCRIPT = fileURLToPath(new URL('../tools/extract_media.py', import.meta.url))
/** 本插件自带的本地语音转写脚本（faster-whisper）。 */
const ASR_SCRIPT = fileURLToPath(new URL('../tools/asr.py', import.meta.url))
/**
 * 「搬视频」的临时目录：必须放在 workspace / 插件目录里。
 * 实测放到系统 %TEMP% 时，子进程 python/ffmpeg 会 `WinError 5 拒绝访问`（DSH 沙箱子进程 ACL）。
 */
const WATCH_TMP_ROOT = process.env.QQDY_WATCH_DIR
  || join(fileURLToPath(new URL('..', import.meta.url)), '.watch-tmp')
/** 下载视频时伪装成浏览器（抖音 CDN 会看 UA/Referer）。 */
const DOWNLOAD_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

/** detail 接口要的公共参数（与 tools/api-comments.py 对齐）。 */
const COMMON = {
  device_platform: 'webapp',
  aid: '6383',
  channel: 'channel_pc_web',
  pc_client_type: '1',
  version_code: '190500',
  version_name: '19.5.0',
  cookie_enabled: 'true',
  screen_width: '1920',
  screen_height: '1080',
  browser_language: 'zh-CN',
  browser_platform: 'Win32',
  browser_name: 'Chrome',
  browser_version: '141.0.0.0',
  engine_name: 'Blink',
  engine_version: '141.0.0.0',
  os_name: 'Windows',
  os_version: '10',
  platform: 'PC',
}

/** 只读文件（失败给空串）。 */
function readText(file) {
  try {
    return readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return ''
  }
}

/** 读 JSON（失败 null）。 */
function readJson(file) {
  const text = readText(file)
  if (text.trim() === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * 找到「刷抖音」插件的安装目录：
 *   ① `DSH_PROFILE_DIR` 环境变量 → 该 profile 的 package.json 里 `dsh-douyin-scroll` 的 `link:` 路径；
 *   ② 扫 `$DSH_HOME/profiles/*​/package.json` 找同一个依赖；
 *   ③ 都找不到就返回 error（功能报错，不猜路径）。
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ ok: true, dir: string, python: string, node: string, stateHome: string, source: string }
 *          | { ok: false, error: string }}
 */
export function discoverDouyinTools(env = process.env) {
  const home = env.DSH_HOME && String(env.DSH_HOME).trim() !== '' ? String(env.DSH_HOME).trim() : dshHome()
  const marker = join('tools', 'api-comments.py')
  /** @type {string[]} */
  const candidates = []
  /** @type {string} */
  let source = ''

  const dirFromProfile = (profileDir) => {
    if (!profileDir) return ''
    const pkg = readJson(join(profileDir, 'package.json'))
    const dep = pkg && pkg.dependencies ? pkg.dependencies['dsh-douyin-scroll'] : undefined
    if (typeof dep !== 'string') return ''
    if (!dep.startsWith('link:')) return ''
    // 直接去掉 link: 前缀即可：Node 的 path 在 Windows 上同时接受 `/` 和 `\`，
    // 这样 macOS / Linux 也不会被写死的反斜杠弄坏。
    return dep.slice('link:'.length)
  }

  const fromEnv = dirFromProfile(env.DSH_PROFILE_DIR ? String(env.DSH_PROFILE_DIR) : '')
  if (fromEnv !== '') {
    candidates.push(fromEnv)
    source = 'DSH_PROFILE_DIR'
  }
  try {
    const profilesRoot = join(home, 'profiles')
    if (existsSync(profilesRoot)) {
      for (const name of readdirSync(profilesRoot)) {
        const dir = dirFromProfile(join(profilesRoot, name))
        if (dir !== '') candidates.push(dir)
      }
      if (source === '' && candidates.length > 0) source = 'profiles/*/package.json'
    }
  } catch {
    /* 读不到 profiles 就算了 */
  }

  const found = candidates.find((dir) => existsSync(join(dir, marker)))
  if (found === undefined) {
    return { ok: false, error: '找不到「刷抖音」插件目录（dsh-douyin-scroll）：先在设置里确认它已安装', tried: candidates }
  }

  const pythonCandidates = [
    join(home, 'douyin-duty', '.venv', 'Scripts', 'python.exe'),
    join(home, 'douyin-duty', '.venv', 'bin', 'python'),
  ]
  const python = pythonCandidates.find((file) => existsSync(file)) || ''
  if (python === '') {
    return { ok: false, error: '找不到「刷抖音」的 Python 环境（.venv）——去设置 → 刷抖音 点一次「装主依赖」', dir: found }
  }

  return {
    ok: true,
    dir: found,
    python,
    node: process.execPath,
    stateHome: join(home, 'douyin-duty'),
    source,
  }
}

/**
 * 起一个子进程并收全量输出（UTF-8）。
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: Record<string, string | undefined>, timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, code: number | null, stdout: string, stderr: string, timedOut?: boolean, error?: string }>}
 */
export function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const timeoutMs = Math.max(1_000, Math.min(Number(options.timeoutMs) || 60_000, 300_000))
    let settled = false
    let stdout = ''
    let stderr = ''
    let child
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    try {
      child = spawn(command, args, {
        cwd: options.cwd || undefined,
        env: { ...process.env, ...(options.env || {}) },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ ok: false, code: null, stdout: '', stderr: '', error: String((error && error.message) || error) })
      return
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => finish({ ok: false, code: null, stdout, stderr, error: String((error && error.message) || error) }))
    child.on('close', (code) => finish({ ok: code === 0, code, stdout, stderr }))
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已经死了 */
      }
      finish({ ok: false, code: null, stdout, stderr, timedOut: true, error: `超时（${Math.round(timeoutMs / 1000)} 秒）` })
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

/**
 * 从输出里找最后一个 JSON 对象并解析（脚本可能先打日志到 stdout）。
 * @param {string} text
 * @returns {any | null}
 */
export function pickJson(text) {
  const source = String(text ?? '')
  const start = source.indexOf('{')
  const end = source.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(source.slice(start, end + 1))
  } catch {
    return null
  }
}

/**
 * 解析 api-comments.py 的文本输出。
 * 行格式（`tools/api-comments.py:94-103`）：
 *   `  cid=123  昵称  [内容]  赞45  1700000000`
 *   `      └ reply cid=456 昵称 [内容] 1700000000`
 * @param {string} stdout
 * @param {{ limit?: number }} [options]
 * @returns {{ comments: Array<{ cid: string, nick: string, text: string, digg: number, time: number, replies: Array<{ cid: string, nick: string, text: string, time: number }> }>, total: number, pages: string[], statusOk: boolean }}
 */
export function parseComments(stdout, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit) || 20, 50))
  const comments = []
  const pages = []
  let statusOk = true
  let reportedTotal = 0
  let current = null
  for (const raw of String(stdout ?? '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (line.trim() === '') continue
    const pageMatch = /^page=(\d+)\s+status_code=(\S+)\s+comments=(\d+)/.exec(line)
    if (pageMatch) {
      pages.push(line.trim())
      if (pageMatch[2] !== '0' && pageMatch[2] !== 'OK') statusOk = false
      continue
    }
    const totalMatch = /^合计\s+(\d+)\s*条/.exec(line)
    if (totalMatch) {
      reportedTotal = Number(totalMatch[1]) || 0
      continue
    }
    const top = /^\s{2}cid=(\d+)\s{2}(.*?)\s{2}\[(.*)\]\s{2}赞(\d+)\s+(\d+)\s*$/.exec(line)
    if (top) {
      current = {
        cid: top[1],
        nick: top[2].trim(),
        text: top[3].trim(),
        digg: Number(top[4]) || 0,
        time: Number(top[5]) || 0,
        replies: [],
      }
      if (comments.length < limit) comments.push(current)
      continue
    }
    // reply 行：`      └ reply cid=456 昵称 [内容]  1700000001`（cid/昵称/`[` 之间是单空格）
    const reply = /^\s+└ reply cid=(\d+)\s+(.+?)\s+\[(.*)\]\s+(\d+)\s*$/.exec(line)
    if (reply && current !== null && current.replies.length < 6) {
      current.replies.push({
        cid: reply[1],
        nick: reply[2].trim(),
        text: reply[3].trim(),
        time: Number(reply[4]) || 0,
      })
    }
  }
  return { comments, total: comments.length, reportedTotal, pages, statusOk }
}

/**
 * 解析 detail 接口 JSON。
 * @param {any} json
 * @returns {null | { aweme_id: string, desc: string, author: string, author_sec_uid: string,
 *   digg: number, comment_count: number, share_count: number, collect_count: number,
 *   duration_ms: number, cover: string, canonical: string }}
 */
export function parseVideoDetail(json) {
  if (json === null || typeof json !== 'object') return null
  const detail = json.aweme_detail || json.aweme || null
  if (detail === null || typeof detail !== 'object') return null
  const awemeId = String(detail.aweme_id || '').trim()
  const statistics = detail.statistics !== null && typeof detail.statistics === 'object' ? detail.statistics : {}
  const author = detail.author !== null && typeof detail.author === 'object' ? detail.author : {}
  const video = detail.video !== null && typeof detail.video === 'object' ? detail.video : {}
  const coverList = video.cover && Array.isArray(video.cover.url_list) ? video.cover.url_list : []
  const originList = video.origin_cover && Array.isArray(video.origin_cover.url_list) ? video.origin_cover.url_list : []
  const playAddr = video.play_addr !== null && typeof video.play_addr === 'object' ? video.play_addr : {}
  const playList = Array.isArray(playAddr.url_list) ? playAddr.url_list : []
  const downloadAddr = video.download_addr !== null && typeof video.download_addr === 'object' ? video.download_addr : {}
  const downloadList = Array.isArray(downloadAddr.url_list) ? downloadAddr.url_list : []
  // 抖音自动字幕（部分视频有）：voice→文字，直接省掉 ASR
  const captions = []
  const claInfo = video.cla_info !== null && typeof video.cla_info === 'object' ? video.cla_info : {}
  if (Array.isArray(claInfo.caption_infos)) {
    for (const caption of claInfo.caption_infos) {
      const text = String((caption && caption.text) || '').trim()
      if (text !== '') captions.push(text)
    }
  }
  return {
    aweme_id: awemeId,
    desc: String(detail.desc || '').trim(),
    author: String(author.nickname || '').trim(),
    author_sec_uid: String(author.sec_uid || '').trim(),
    digg: Number(statistics.digg_count) || 0,
    comment_count: Number(statistics.comment_count) || 0,
    share_count: Number(statistics.share_count) || 0,
    collect_count: Number(statistics.collect_count) || 0,
    duration_ms: Number(video.duration) || 0,
    cover: String(coverList[0] || originList[0] || ''),
    play_url: String(playList[0] || downloadList[0] || ''),
    captions,
    canonical: awemeId === '' ? '' : canonicalVideoUrl(awemeId),
  }
}

/** 数字变「1.2w / 3.4k」。 */
export function formatCount(value) {
  const num = Number(value) || 0
  if (num >= 100000000) return `${(num / 100000000).toFixed(1)}亿`
  if (num >= 10000) return `${(num / 10000).toFixed(1)}w`
  if (num >= 1000) return `${(num / 1000).toFixed(1)}k`
  return String(num)
}

/**
 * 视频信息 + 热评 → 一段适合发给模型 / 人看的中文摘要。
 * @param {ReturnType<typeof parseVideoDetail>} video
 * @param {ReturnType<typeof parseComments>} parsed
 * @param {{ limit?: number }} [options]
 * @returns {string}
 */
export function formatVideoDigest(video, parsed, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit) || 6, 20))
  const lines = []
  if (video !== null) {
    const title = video.desc === '' ? '（无文案）' : video.desc.replace(/\s+/g, ' ').slice(0, 120)
    lines.push(`【抖音视频】${title}`)
    lines.push(`作者：@${video.author || '未知'}　赞 ${formatCount(video.digg)} · 评论 ${formatCount(video.comment_count)} · 收藏 ${formatCount(video.collect_count)} · 分享 ${formatCount(video.share_count)}`)
    lines.push(`链接：${video.canonical}`)
  } else {
    lines.push('【抖音视频】（没取到视频详情，只有评论）')
  }
  const comments = parsed && Array.isArray(parsed.comments) ? parsed.comments : []
  if (comments.length === 0) {
    lines.push('热评：（这次没拿到评论）')
    return lines.join('\n')
  }
  lines.push(`热评（${comments.length} 条）：`)
  comments.slice(0, limit).forEach((comment, index) => {
    lines.push(`${index + 1}. ${comment.nick}：${comment.text.slice(0, 120)}（赞 ${formatCount(comment.digg)}）`)
    for (const reply of comment.replies.slice(0, 2)) {
      lines.push(`   └ ${reply.nick}：${reply.text.slice(0, 100)}`)
    }
  })
  return lines.join('\n')
}

/**
 * 查视频详情（~1–3 秒）。
 * @param {string} awemeId
 * @param {{ tools?: ReturnType<typeof discoverDouyinTools>, timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: true, video: ReturnType<typeof parseVideoDetail> } | { ok: false, error: string }>}
 */
export async function fetchVideoDetail(awemeId, options = {}) {
  const tools = options.tools || discoverDouyinTools()
  if (tools.ok !== true) return { ok: false, error: tools.error }
  const id = String(awemeId)
  const timeoutMs = Math.max(15_000, Math.min(Number(options.timeoutMs) || 120_000, 180_000))
  /**
   * 2026-11-21：优先走「签名 HTTP」（video-detail.py，不需要无头浏览器/登录页签名 SDK）——
   * 实测无头浏览器打开视频页会撞验证码中间页，cdp-fetch 40 秒也起不来；
   * 签名路 1–3 秒就返回 aweme_detail（含 play_addr）。失败再回退 cdp-fetch。
   */
  const signed = await runProcess(tools.python, [join(tools.dir, 'tools', 'video-detail.py'), id], {
    cwd: tools.dir,
    env: { DOUYIN_HOME: tools.stateHome, DOUYIN_NODE: tools.node, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    timeoutMs: Math.min(timeoutMs, 120_000),
  })
  if (signed.ok !== false && signed.stdout && !signed.timedOut) {
    const signedJson = pickJson(signed.stdout)
    const signedVideo = parseVideoDetail(signedJson)
    if (signedVideo !== null) return { ok: true, video: signedVideo }
  }
  const query = Object.entries({ ...COMMON, aweme_id: id })
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&')
  const path = `/aweme/v1/web/aweme/detail/?${query}`
  const result = await runProcess(tools.node, [join(tools.dir, 'tools', 'cdp-fetch.mjs'), '--path', path], {
    cwd: tools.dir,
    env: { DOUYIN_HOME: tools.stateHome },
    timeoutMs,
  })
  if (result.timedOut) return { ok: false, error: '取视频详情超时（无头页面没响应）' }
  const json = pickJson(result.stdout)
  const video = parseVideoDetail(json)
  if (video === null) {
    return { ok: false, error: `没取到视频详情（签名路 + 无头页面都不通）：${(signed.stderr || result.stderr || result.stdout || '').replace(/\s+/g, ' ').slice(-160) || '无输出'}` }
  }
  return { ok: true, video }
}

/**
 * 拉热评（~10–20 秒）。
 * @param {string} awemeId
 * @param {{ limit?: number, tools?: ReturnType<typeof discoverDouyinTools>, timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: true, parsed: ReturnType<typeof parseComments> } | { ok: false, error: string }>}
 */
export async function fetchComments(awemeId, options = {}) {
  const tools = options.tools || discoverDouyinTools()
  if (tools.ok !== true) return { ok: false, error: tools.error }
  const limit = Math.max(1, Math.min(Number(options.limit) || 20, 50))
  const result = await runProcess(tools.python, [join(tools.dir, 'tools', 'api-comments.py'), String(awemeId)], {
    cwd: tools.dir,
    // Windows 默认 GBK：评论里带 emoji 时 print 会直接 UnicodeEncodeError 崩掉。
    // 「刷抖音」插件自己也是这么给 python 子进程打 UTF-8 的（index.js:263-269）。
    env: { DOUYIN_HOME: tools.stateHome, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    timeoutMs: Math.max(30_000, Math.min(Number(options.timeoutMs) || 240_000, 280_000)),
  })
  if (result.timedOut) return { ok: false, error: '拉评论超时（签名接口没响应）' }
  const parsed = parseComments(result.stdout, { limit })
  if (!parsed.statusOk && parsed.comments.length === 0) {
    const tail = (result.stderr || result.stdout || '').replace(/\s+/g, ' ').slice(-200)
    return { ok: false, error: `拉评论失败：${tail || '没有可用输出'}` }
  }
  if (parsed.comments.length === 0) {
    if (result.ok !== true) {
      const tail = (result.stderr || result.stdout || '').replace(/\s+/g, ' ').slice(-200)
      return { ok: false, error: `拉评论失败（脚本退出码 ${result.code}）：${tail || '没有可用输出'}` }
    }
    return { ok: false, error: '这条视频没有拉到评论（可能已关评或接口限流）' }
  }
  return { ok: true, parsed }
}

/**
 * 解析一整行 Cookie 请求头 → Map(name → value)（纯函数，自检可测）。
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function parseCookieHeader(text) {
  const jar = new Map()
  for (const part of String(text || '').split(';')) {
    const item = part.trim()
    if (item === '') continue
    const eq = item.indexOf('=')
    if (eq <= 0) continue
    const name = item.slice(0, eq).trim()
    const value = item.slice(eq + 1).trim()
    if (name === '' || value === '') continue
    jar.set(name, value)
  }
  return jar
}

/**
 * 确保无头浏览器处于已登录状态；掉登录时用 `douyin_cookie.txt` 里的 Cookie 直接灌回去。
 *
 * 2026-11-14 实测：插件 home 里的 Cookie 文件还能用（HTTP 接口正常），但无头 Chrome 的
 * profile 掉登录时，card-share / im-send 会「分享面板没展开」「发送器没返回结果」。
 * 这里自动把 Cookie 注入浏览器，省得用户重新扫码。
 * @param {{ tools?: ReturnType<typeof discoverDouyinTools>, quietMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, loggedOut?: boolean, injected?: number, error?: string }>}
 */
export async function ensureBrowserLogin(options = {}) {
  const tools = options.tools || discoverDouyinTools()
  if (tools.ok !== true) return { ok: false, error: tools.error }
  let chrome
  try {
    chrome = await import(pathToFileURL(join(tools.dir, 'lib', 'chrome.mjs')).href)
  } catch (error) {
    return { ok: false, error: `加载无头浏览器模块失败：${String((error && error.message) || error)}` }
  }
  const sleep = typeof chrome.sleep === 'function' ? chrome.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  let page
  try {
    page = await chrome.openPage({ url: 'https://www.douyin.com/chat' })
  } catch (error) {
    return { ok: false, error: `打开抖音聊天页失败：${String((error && error.message) || error)}` }
  }
  const isLoggedOut = async () => {
    const body = String(await page.ev('document.body.innerText.slice(0, 1200)')).replace(/\s+/g, ' ')
    return /扫码登录|登录后免费|验证码登录/.test(body)
  }
  try {
    await sleep(Math.max(2_000, Math.min(Number(options.quietMs) || 5_000, 8_000)))
    if (!(await isLoggedOut())) return { ok: true, loggedOut: false }
    let raw = ''
    try {
      raw = readFileSync(join(tools.stateHome, 'douyin_cookie.txt'), 'utf8')
    } catch {
      raw = ''
    }
    const jar = parseCookieHeader(raw)
    if (jar.size === 0) {
      return { ok: false, loggedOut: true, error: '无头浏览器未登录，且没有可用的 douyin_cookie.txt（需要扫码登录）' }
    }
    try {
      await page.send('Network.enable', {})
    } catch {
      /* 某些版本不必显式 enable */
    }
    const expires = Math.floor(Date.now() / 1000) + 7 * 24 * 3600
    let injected = 0
    for (const [name, value] of jar) {
      try {
        await page.send('Network.setCookie', { name, value, domain: '.douyin.com', path: '/', secure: true, httpOnly: false, expires })
        injected += 1
      } catch {
        /* 单条失败就跳过 */
      }
    }
    await page.send('Page.navigate', { url: 'https://www.douyin.com/chat' })
    await sleep(6_000)
    if (await isLoggedOut()) {
      return { ok: false, loggedOut: true, injected, error: 'Cookie 注入后仍未登录（Cookie 可能过期，需要扫码）' }
    }
    return { ok: true, loggedOut: true, injected }
  } catch (error) {
    return { ok: false, error: `检查浏览器登录态失败：${String((error && error.message) || error)}` }
  } finally {
    try {
      page.close()
    } catch {
      /* 已经关了 */
    }
  }
}

/**
 * 发抖音分享卡片（20–60 秒）。调用方必须先拿到用户同意。
 * 失败时如果是「浏览器掉登录」引起的，会自动把 Cookie 灌回无头浏览器并重试一次。
 * @param {string} awemeId
 * @param {{ to?: string, toId?: string, tools?: ReturnType<typeof discoverDouyinTools>, timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, sent?: boolean, error?: string, raw?: any }>}
 */
export async function shareVideoCard(awemeId, options = {}) {
  const to = String(options.to || '').trim()
  const toId = String(options.toId || '').trim()
  if (to === '' && toId === '') return { ok: false, error: '不知道发给谁：先绑定抖音好友' }
  const tools = options.tools || discoverDouyinTools()
  if (tools.ok !== true) return { ok: false, error: tools.error }
  const runCard = async () => {
    const args = [join(tools.dir, 'tools', 'card-share.mjs'), String(awemeId), to || '抖音好友']
    if (toId !== '') args.push('--to-id', toId)
    const result = await runProcess(tools.node, args, {
      cwd: tools.dir,
      env: { DOUYIN_HOME: tools.stateHome },
      timeoutMs: Math.max(30_000, Math.min(Number(options.timeoutMs) || 220_000, 280_000)),
    })
    if (result.timedOut) return { ok: false, error: '发分享卡片超时（无头 Chrome 没响应）' }
    const json = pickJson(result.stdout)
    if (json === null) {
      return { ok: false, error: `发卡片失败：${(result.stderr || result.stdout || '').replace(/\s+/g, ' ').slice(-200) || '没有输出'}` }
    }
    if (json.ok !== true) return { ok: false, error: String(json.error || '发卡片失败'), raw: json }
    return { ok: true, sent: json.sent === true, raw: json }
  }
  const first = await runCard()
  if (first.ok) return first
  const browserish = /分享面板|登录|扫码|超时|没响应|找不到分享/.test(String(first.error || ''))
  if (!browserish) return first
  const login = await ensureBrowserLogin({ tools })
  if (login.ok !== true) {
    return { ...first, error: `${first.error}；浏览器登录修复失败：${login.error}` }
  }
  const second = await runCard()
  return second.ok ? second : { ...second, error: `${second.error}（已自动修复浏览器登录并重试）` }
}

/**
 * 在本机默认浏览器打开链接（只允许抖音域名）。只负责「叫起来」，不等浏览器。
 * @param {string} url
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function openInBrowser(url) {
  const target = String(url ?? '').trim()
  if (target === '') return { ok: false, error: '链接是空的' }
  // 只放行抖音域名（防止被注入成任意 URL）
  if (!/^https?:\/\/([A-Za-z0-9-]+\.)*(douyin|iesdouyin)\.com(\/|$|\?)/i.test(target)) {
    return { ok: false, error: `只允许打开抖音链接：${target.slice(0, 80)}` }
  }
  try {
    const platform = process.platform
    const command = platform === 'win32' ? 'explorer.exe' : platform === 'darwin' ? 'open' : 'xdg-open'
    const child = spawn(command, [target], { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
}

/* ───────────────────────── 推荐流（「抖音上刷的视频」） ─────────────────────────
 * 数据来源：`tools/forward-pick.py`（只读、不签名、不碰写接口）——
 * 拉 feed 3 页 + 热榜 → 打分 → 写 `$DOUYIN_HOME/forward-pick.json`（rows: aweme_id/desc/author/…）。
 * 实测约 10–20 秒。**只读**：不点赞、不发消息。
 */

/**
 * 解析 `forward-pick.json` 的 `rows`（纯函数，selfcheck 可离线测）。
 * @param {any} json
 * @returns {Array<{ aweme_id: string, desc: string, author: string, digg: number, comment: number,
 *   collect: number, share: number, duration_s: number, score: number, web_url: string, share_url: string }>}
 */
export function parseFeed(json) {
  const rows = json !== null && typeof json === 'object' && Array.isArray(json.rows) ? json.rows : []
  const out = []
  for (const raw of rows) {
    if (raw === null || typeof raw !== 'object') continue
    const awemeId = String(raw.aweme_id || '').trim()
    if (awemeId === '') continue
    out.push({
      aweme_id: awemeId,
      desc: String(raw.desc || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      author: String(raw.author || '').trim(),
      digg: Number(raw.digg) || 0,
      comment: Number(raw.comment) || 0,
      collect: Number(raw.collect) || 0,
      share: Number(raw.share) || 0,
      duration_s: Number(raw.duration_s) || 0,
      score: Number(raw.score) || 0,
      web_url: String(raw.web_url || '').trim() || canonicalVideoUrl(awemeId),
      share_url: String(raw.share_url || '').trim(),
    })
  }
  return out
}

/**
 * 拉一轮「抖音上刷到的视频」（推荐流候选），约 10–20 秒。
 * @param {{ top?: number, tools?: ReturnType<typeof discoverDouyinTools>, timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: true, rows: ReturnType<typeof parseFeed>, total: number, meta: any }
 *          | { ok: false, error: string }>}
 */
export async function fetchFeed(options = {}) {
  const tools = options.tools || discoverDouyinTools()
  if (tools.ok !== true) return { ok: false, error: tools.error }
  const result = await runProcess(tools.python, [join(tools.dir, 'tools', 'forward-pick.py')], {
    cwd: tools.dir,
    env: { DOUYIN_HOME: tools.stateHome, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    timeoutMs: Math.max(30_000, Math.min(Number(options.timeoutMs) || 240_000, 280_000)),
  })
  if (result.timedOut) return { ok: false, error: '拉抖音推荐流超时（feed 接口没响应）' }
  let json = null
  try {
    json = JSON.parse(readFileSync(join(tools.stateHome, 'forward-pick.json'), 'utf8'))
  } catch {
    json = null
  }
  if (json === null) {
    const tail = (result.stderr || result.stdout || '').replace(/\s+/g, ' ').slice(-180)
    return { ok: false, error: `推荐流脚本没产出结果：${tail || '没有输出'}` }
  }
  const rows = parseFeed(json)
  if (rows.length === 0) {
    return { ok: false, error: `这次没拉到推荐视频（登录态可能过期或接口限流）${result.ok ? '' : '·脚本退出码非 0'}` }
  }
  const top = Math.max(1, Math.min(Number(options.top) || 5, 10))
  return { ok: true, rows: rows.slice(0, top), total: rows.length, meta: json.meta || null }
}

/**
 * 推荐流 → 给模型/人看的文本摘要。
 * @param {ReturnType<typeof parseFeed>} rows
 * @param {{ limit?: number }} [options]
 * @returns {string}
 */
export function formatFeedDigest(rows, options = {}) {
  const list = Array.isArray(rows) ? rows : []
  if (list.length === 0) return '【抖音推荐】（这次没拉到视频）'
  const limit = Math.max(1, Math.min(Number(options.limit) || list.length, 10))
  const lines = [`【抖音推荐】刷到的视频（${Math.min(limit, list.length)} 条）：`]
  list.slice(0, limit).forEach((row, index) => {
    lines.push(`${index + 1}. ${String(row.desc || '').slice(0, 80) || '（无文案）'}`)
    lines.push(`   @${row.author || '未知'}${row.duration_s ? ` · ${Math.round(row.duration_s)}s` : ''} · 赞${formatCount(row.digg)} 评${formatCount(row.comment)} 藏${formatCount(row.collect)}`)
    lines.push(`   ${row.web_url}`)
    if (Array.isArray(row.top_comments) && row.top_comments.length > 0) {
      lines.push(`   热评：${row.top_comments.slice(0, 2).map((c) => `${c.nick}：${String(c.text).slice(0, 30)}`).join(' / ')}`)
    }
  })
  return lines.join('\n')
}

/**
 * 推荐流的一条 → 发到 QQ 的一条消息。
 * @param {ReturnType<typeof parseFeed>[number]} row
 * @param {{ comments?: Array<{nick: string, text: string}> }} [options]
 * @returns {string}
 */
export function formatFeedForQQ(row, options = {}) {
  const lines = [`【抖音·推荐】${String(row.desc || '').replace(/\s+/g, ' ').slice(0, 80) || '（无文案）'}`]
  lines.push(`@${row.author || '未知'} · 赞${formatCount(row.digg)} 评${formatCount(row.comment)} 藏${formatCount(row.collect)}`)
  lines.push(row.web_url)
  const comments = Array.isArray(options.comments)
    ? options.comments
    : (Array.isArray(row.top_comments) ? row.top_comments : [])
  if (comments.length > 0) {
    lines.push(`热评：${comments.slice(0, 2).map((c) => `${c.nick}：${String(c.text).slice(0, 40)}`).join(' / ')}`)
  }
  return lines.join('\n')
}

/* ───────────────────────── 「搬整段视频」：下载 + 抽帧 + 原声 ─────────────────────────
 * 给 `douyin_video action=watch` 用：把完整 mp4 发到 QQ（用户能看动态+听声音），
 * 再抽 N 帧发到 QQ（QQ 里的鱼可用 qq_get_message_images 逐帧看），原声音频也发一条语音。
 */

/**
 * 建一个临时工作目录（放在插件目录下，调用方负责 rmSync 清理）。
 * @param {string} [prefix]
 * @returns {string}
 */
export function makeWorkDir(prefix = 'watch-') {
  mkdirSync(WATCH_TMP_ROOT, { recursive: true })
  return mkdtempSync(join(WATCH_TMP_ROOT, prefix))
}

/**
 * 下载抖音视频 mp4（签名 URL，带浏览器 UA/Referer）。
 * @param {{ aweme_id?: string, play_url?: string }} video parseVideoDetail 的结果
 * @param {{ dir: string, fetchImpl?: typeof fetch, timeoutMs?: number }} options
 * @returns {Promise<{ ok: true, file: string, bytes: number } | { ok: false, error: string }>}
 */
export async function downloadDouyinVideo(video, options = {}) {
  const url = String((video && video.play_url) || '').trim()
  if (url === '') return { ok: false, error: '这条视频没有可下载地址（play_addr 为空，可能是图文）' }
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const dir = String(options.dir || '')
  if (dir === '') return { ok: false, error: '没给临时目录' }
  const target = join(dir, `${String((video && video.aweme_id) || Date.now())}.mp4`)
  const timeout = Math.max(10_000, Math.min(Number(options.timeoutMs) || 180_000, 300_000))
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        'user-agent': DOWNLOAD_UA,
        referer: 'https://www.douyin.com/',
        accept: 'video/mp4,video/*;q=0.9,*/*;q=0.8',
      },
      signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(timeout)
        : undefined,
    })
    if (!response.ok) return { ok: false, error: `下载视频失败：HTTP ${response.status}` }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length < 1024) return { ok: false, error: `下载的视频太小（${buffer.length} 字节），可能被风控了` }
    writeFileSync(target, buffer)
    return { ok: true, file: target, bytes: buffer.length }
  } catch (error) {
    const name = String((error && error.name) || '')
    const reason = name === 'TimeoutError' || name === 'AbortError' ? '下载超时' : String((error && error.message) || error)
    return { ok: false, error: `下载视频失败：${reason}` }
  }
}

/**
 * 从 mp4 抽 N 帧 + 原声 mp3（用「刷抖音」venv 里的 imageio-ffmpeg）。
 * @param {string} videoPath
 * @param {{ tools?: ReturnType<typeof discoverDouyinTools>, frames?: number, outDir: string, timeoutMs?: number }} options
 * @returns {Promise<{ ok: true, frames: string[], audio: string, duration: number } | { ok: false, error: string }>}
 */
export async function extractFramesAndAudio(videoPath, options = {}) {
  const tools = options.tools || discoverDouyinTools()
  if (tools.ok !== true) return { ok: false, error: tools.error }
  const outDir = String(options.outDir || '')
  if (outDir === '') return { ok: false, error: '没给输出目录' }
  const frames = Math.max(3, Math.min(Number(options.frames) || 6, 12))
  const result = await runProcess(tools.python, [EXTRACT_SCRIPT, videoPath, outDir, String(frames)], {
    cwd: tools.dir,
    env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    timeoutMs: Math.max(30_000, Math.min(Number(options.timeoutMs) || 240_000, 300_000)),
  })
  if (result.timedOut) return { ok: false, error: '抽帧超时（ffmpeg 没响应）' }
  const json = pickJson(result.stdout)
  if (json === null) {
    return { ok: false, error: `抽帧脚本没返回结果：${(result.stderr || result.stdout || '').replace(/\s+/g, ' ').slice(-200) || '无输出'}` }
  }
  if (json.ok !== true) return { ok: false, error: String(json.error || '抽帧失败') }
  return {
    ok: true,
    frames: Array.isArray(json.frames) ? json.frames.map(String) : [],
    audio: String(json.audio || ''),
    duration: Number(json.duration_s) || 0,
  }
}

/** 清理临时目录（失败不抛）。 */
export function cleanupWorkDir(dir) {
  if (!dir) return
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响业务 */
  }
}

/**
 * 本地语音转文字（faster-whisper，默认 small；首次会从 HF 镜像下模型，之后纯本地）。
 * @param {string} audioPath 本地音频（mp3/m4a/wav…）
 * @param {{ tools?: ReturnType<typeof discoverDouyinTools>, model?: string, timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: true, text: string, model: string } | { ok: false, error: string }>}
 */
export async function transcribeAudio(audioPath, options = {}) {
  if (String(audioPath || '') === '') return { ok: false, error: '没有音频可转写' }
  const tools = options.tools || discoverDouyinTools()
  if (tools.ok !== true) return { ok: false, error: tools.error }
  const result = await runProcess(tools.python, [ASR_SCRIPT, String(audioPath)], {
    cwd: tools.dir,
    env: {
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      HF_ENDPOINT: 'https://hf-mirror.com',
      QQDY_ASR_MODEL: String(options.model || 'small'),
    },
    timeoutMs: Math.max(60_000, Math.min(Number(options.timeoutMs) || 420_000, 600_000)),
  })
  if (result.timedOut) return { ok: false, error: '语音转写超时（Whisper 首次要下模型，可稍后再试）' }
  const json = pickJson(result.stdout)
  if (json === null) {
    return { ok: false, error: `转写脚本没返回结果：${(result.stderr || result.stdout || '').replace(/\s+/g, ' ').slice(-200) || '无输出'}` }
  }
  if (json.ok !== true) return { ok: false, error: String(json.error || '转写失败') }
  return { ok: true, text: String(json.text || '').trim(), model: String(json.model || '') }
}
