/**
 * lib/video-ai.mjs —— 接一个「视频大模型」来真正看懂画面（不是只看一帧封面）。
 *
 * 凭据复用 DSH 宿主环境变量（用户不需要在本插件里再存 key）：
 *   · DASHSCOPE_API_KEY（Qwen-VL，和 dsh-image-gen 的 dashscope 共用；推荐）
 *   · GEMINI_API_KEY（Gemini；原生多模态，走 generateContent inline_data）
 * 环境变量都没有时，回退读 `$DSH_HOME/vlm-key.txt`（支持 `dashscope:sk-…` / `gemini:AIza…` / 裸 key）。
 *
 * 免费额度策略（v0.9）：
 *   · 默认**按价格从低到高**依次尝试（便宜/有免费额度的先跑），模型顺序可用
 *     `QQDY_VLM_MODELS=qwen-vl-plus,qwen-vl-max-latest,...` 覆盖；
 *   · 某个模型报「额度用完 / 未开通」→ 记进状态文件、冷却 30 天，后续请求自动跳过它；
 *   · 报「限流/并发」→ 冷却 10 分钟，仍会先试别的模型；
 *   · 成功过的模型记成 preferred，下次优先用它（省得每次都从最便宜试起）。
 *   状态文件：`$DSH_HOME/qq-douyin-bridge/vlm-model-state.json`（删掉就全部重置）。
 *
 * 纯函数（classifyVlmError / pickModelCandidates / parseKeyFile / buildDescribePrompt 等）单独导出，
 * selfcheck 可离线测；网络调用只有 describeFrames / probeVlmModels。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from './paths.mjs'

const DEFAULT_DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
const DEFAULT_GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta'

/** DashScope 默认尝试顺序（只放本平台实际可用的 VL 模型；无效模型会被自动跳过）。 */
export const VLM_MODEL_CANDIDATES = [
  'qwen3-vl-plus',        // 当前账号已开通（免费额度），实测可用
  'qwen-vl-max-latest',   // 经典 VL 旗舰（开通/领免费额度后会自动用上）
]
/** 画面文字 OCR 模型顺序（消耗各自免费额度）。 */
export const OCR_MODEL_CANDIDATES = ['qwen-vl-ocr', 'qwen3.5-ocr']
/** Gemini 默认尝试顺序。 */
export const GEMINI_MODEL_CANDIDATES = ['gemini-2.5-flash', 'gemini-2.0-flash']
/** 额度用完 / 未开通的冷却时间（毫秒）；免费额度一般按模型/账号恢复，保守用 30 天。 */
export const QUOTA_COOLDOWN_MS = 30 * 24 * 3600 * 1000
/** 限流的冷却时间（毫秒）。 */
export const THROTTLE_COOLDOWN_MS = 10 * 60 * 1000

/** 没有可用 key 时的统一提示。 */
export const MISSING_KEY_HINT = '没有视频模型 key：设置 DASHSCOPE_API_KEY（Qwen-VL，和图像生成共用）或 GEMINI_API_KEY，或把 key 写进 $DSH_HOME/vlm-key.txt 后重启 DSH。'

/**
 * 解析 key 文件内容（纯函数）：支持 `dashscope:<key>` / `gemini:<key>` / 裸 key（按前缀猜）。
 * @param {string} text
 * @returns {{ provider: 'dashscope' | 'gemini' | '', key: string }}
 */
export function parseKeyFile(text) {
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^(dashscope|gemini|google|qwen)\s*[:=]\s*(.+)$/i.exec(line)
    if (match) {
      const provider = /gemini|google/i.test(match[1]) ? 'gemini' : 'dashscope'
      return { provider, key: match[2].trim() }
    }
    if (/^AIza[0-9A-Za-z_-]{10,}$/.test(line)) return { provider: 'gemini', key: line }
    return { provider: 'dashscope', key: line }
  }
  return { provider: '', key: '' }
}

/** 从 $DSH_HOME/vlm-key.txt（或插件目录下的 vlm-key.txt）读 key；失败返回空。 */
function readKeyFile() {
  const home = dshHome()
  for (const file of [join(home, 'vlm-key.txt'), join(home, 'qq-douyin-bridge', 'vlm-key.txt')]) {
    try {
      const parsed = parseKeyFile(readFileSync(file, 'utf8'))
      if (parsed.key !== '') return parsed
    } catch {
      /* 没这个文件就继续 */
    }
  }
  return { provider: '', key: '' }
}

/**
 * 读视频模型配置（不打印 key）。顺序：环境变量 → key 文件。
 * `env` 显式传入（不是 process.env）时默认不读真实 key 文件，方便自检；
 * 需要文件回退就传 `{ useKeyFile: true }`。
 * @param {Record<string, string | undefined>} [env]
 * @param {{ useKeyFile?: boolean }} [options]
 * @returns {{ available: boolean, provider: 'dashscope' | 'gemini' | '', baseUrl: string, model: string, key: string }}
 */
export function videoModelConfig(env = process.env, options = {}) {
  let dashscopeKey = String((env && env.DASHSCOPE_API_KEY) || '').trim()
  let geminiKey = String((env && env.GEMINI_API_KEY) || '').trim()
  const useFile = options.useKeyFile === true || env === process.env
  if (useFile && dashscopeKey === '' && geminiKey === '') {
    const fromFile = readKeyFile()
    if (fromFile.provider === 'gemini') geminiKey = fromFile.key
    else if (fromFile.provider === 'dashscope') dashscopeKey = fromFile.key
  }
  if (dashscopeKey !== '') {
    return {
      available: true,
      provider: 'dashscope',
      key: dashscopeKey,
      baseUrl: String((env && (env.QQDY_VLM_BASE_URL || env.DASHSCOPE_BASE_URL)) || DEFAULT_DASHSCOPE_BASE).replace(/\/+$/, ''),
      model: String((env && env.QQDY_VLM_MODEL) || '').trim(),
    }
  }
  if (geminiKey !== '') {
    return {
      available: true,
      provider: 'gemini',
      key: geminiKey,
      baseUrl: String((env && env.QQDY_VLM_BASE_URL) || DEFAULT_GEMINI_BASE).replace(/\/+$/, ''),
      model: String((env && env.QQDY_VLM_MODEL) || '').trim(),
    }
  }
  return { available: false, provider: '', key: '', baseUrl: '', model: '' }
}

/**
 * 模型尝试顺序（纯函数）。
 * @param {'dashscope'|'gemini'} provider
 * @param {Record<string, string | undefined>} [env]
 * @returns {string[]}
 */
export function modelListForProvider(provider, env = {}) {
  const configured = String((env && env.QQDY_VLM_MODELS) || '')
    .split(',')
    .map((model) => model.trim())
    .filter((model) => model !== '')
  if (configured.length > 0) return configured
  return provider === 'gemini' ? [...GEMINI_MODEL_CANDIDATES] : [...VLM_MODEL_CANDIDATES]
}

/**
 * 错误分类（纯函数）：'missing' 模型不存在/没开放 | 'quota' 额度/未开通 | 'throttle' 限流 | 'auth' 鉴权 | 'other'。
 * @param {number} status HTTP 状态码（网络错误传 0）
 * @param {string} [body] 响应正文/错误信息
 * @returns {'missing' | 'quota' | 'throttle' | 'auth' | 'other'}
 */
export function classifyVlmError(status, body = '') {
  const text = String(body || '')
  if (/model_not_found|model\s+not\s+exist|model.*not.*(exist|found)|模型不存在|无效的模型/i.test(text)) return 'missing'
  // 先看限流：它的关键词里也可能带 "exceeded"，别被额度规则抢走
  if (status === 429 || /throttl|rate\s*limit|concurrency|too\s+many|并发/i.test(text)) return 'throttle'
  if (/not\s+authorized|access\s*denied|permission|未开通|not\s+enabled|no\s+permission/i.test(text)) return 'quota'
  if (/quota|额度|arrearage|insufficient|balance|余额|allocated|流量包|试用|free\s+limit/i.test(text)) return 'quota'
  if (status === 401 || (status === 403 && /api[._-]?key|unauthor|invalid.*key|signature/i.test(text))) return 'auth'
  return 'other'
}

/**
 * 选这次要尝试的模型（纯函数）：
 * 1. 用户显式指定的 model 放最前；
 * 2. 成功过的 preferred 提前（若没被冷却）；
 * 3. 跳过 exhausted / throttled 里还没到期的模型；
 * 4. 全被冷却时仍返回原列表（宁可再试一次，也不要完全不动）。
 * @param {{ list?: string[], configured?: string, state?: { preferred?: string, exhausted?: Record<string, string>, throttled?: Record<string, string> }, now?: number }} [input]
 * @returns {string[]}
 */
export function pickModelCandidates(input = {}) {
  const list = Array.isArray(input.list) ? input.list.filter(Boolean).map(String) : []
  const configured = String(input.configured || '').trim()
  const state = input.state && typeof input.state === 'object' ? input.state : {}
  const now = Number(input.now) || Date.now()
  const exhausted = state.exhausted && typeof state.exhausted === 'object' ? state.exhausted : {}
  const throttled = state.throttled && typeof state.throttled === 'object' ? state.throttled : {}
  const isCooling = (map, model) => {
    const until = Date.parse(String(map[model] || ''))
    return Number.isFinite(until) && until > now
  }
  let ordered = configured !== '' ? [configured, ...list.filter((model) => model !== configured)] : [...list]
  if (String(state.preferred || '') !== '') {
    const preferred = String(state.preferred)
    if (ordered.includes(preferred)) ordered = [preferred, ...ordered.filter((model) => model !== preferred)]
  }
  const ready = ordered.filter((model) => !isCooling(exhausted, model) && !isCooling(throttled, model))
  return ready.length > 0 ? ready : ordered
}

/** 模型状态文件路径（$DSH_HOME/qq-douyin-bridge/vlm-model-state.json）。 */
export function modelStatePath() {
  return join(dshHome(), 'qq-douyin-bridge', 'vlm-model-state.json')
}

/**
 * 读模型状态（失败返回空状态，不抛）。
 * @param {string} [file]
 * @returns {{ preferred: string, exhausted: Record<string, string>, throttled: Record<string, string> }}
 */
export function readModelState(file = modelStatePath()) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    return {
      preferred: String((parsed && parsed.preferred) || ''),
      exhausted: parsed && parsed.exhausted && typeof parsed.exhausted === 'object' ? parsed.exhausted : {},
      throttled: parsed && parsed.throttled && typeof parsed.throttled === 'object' ? parsed.throttled : {},
    }
  } catch {
    return { preferred: '', exhausted: {}, throttled: {} }
  }
}

/**
 * 写模型状态（失败静默，不影响主流程）。
 * @param {{ preferred?: string, exhausted?: Record<string, string>, throttled?: Record<string, string> }} state
 * @param {string} [file]
 */
export function writeModelState(state, file = modelStatePath()) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({
      preferred: String(state.preferred || ''),
      exhausted: state.exhausted || {},
      throttled: state.throttled || {},
      updatedAt: new Date().toISOString(),
    }, null, 2), 'utf8')
  } catch {
    /* 状态写不进去就退化成每次全试 */
  }
}

/** 把某个模型按错误类型标记冷却（纯函数，返回新 state）。 */
export function markModelCooling(state, model, errorType, now = Date.now()) {
  const next = {
    preferred: String((state && state.preferred) || ''),
    exhausted: { ...((state && state.exhausted) || {}) },
    throttled: { ...((state && state.throttled) || {}) },
  }
  const name = String(model || '')
  if (name === '') return next
  if (errorType === 'quota' || errorType === 'missing') next.exhausted[name] = new Date(now + QUOTA_COOLDOWN_MS).toISOString()
  else if (errorType === 'throttle') next.throttled[name] = new Date(now + THROTTLE_COOLDOWN_MS).toISOString()
  return next
}

/** 标记成功后：preferred=model，并清掉它的冷却。 */
export function markModelSuccess(state, model, now = Date.now()) {
  const next = {
    preferred: String(model || ''),
    exhausted: { ...((state && state.exhausted) || {}) },
    throttled: { ...((state && state.throttled) || {}) },
  }
  if (next.exhausted[model]) delete next.exhausted[model]
  if (next.throttled[model]) delete next.throttled[model]
  return next
}

/**
 * 组织给视觉模型的提示词（纯函数）。
 * @param {{ frames?: number, title?: string, author?: string, transcript?: string, captions?: string[], ocrText?: string }} input
 * @returns {string}
 */
export function buildDescribePrompt(input = {}) {
  const frames = Math.max(1, Number(input.frames) || 1)
  const title = String(input.title || '').replace(/\s+/g, ' ').slice(0, 120)
  const author = String(input.author || '').slice(0, 40)
  const transcript = String(input.transcript || '').replace(/\s+/g, ' ').slice(0, 600)
  const captions = Array.isArray(input.captions) ? input.captions.join(' ').slice(0, 400) : ''
  const ocrText = String(input.ocrText || '').replace(/\s+/g, ' ').slice(0, 500)
  const lines = [
    `这是一条抖音视频按时间顺序均匀抽取的 ${frames} 张画面帧。`,
    title !== '' ? `视频文案：${title}` : '',
    author !== '' ? `作者：${author}` : '',
    transcript !== '' ? `原声语音转写：${transcript}` : '',
    captions !== '' ? `抖音自动字幕：${captions}` : '',
    ocrText !== '' ? `OCR 识别到的画面文字：${ocrText}` : '',
    '',
    '请用中文输出一段 JSON（不要围栏）：',
    '{"summary":"一句话总结视频在讲什么","scenes":["按时间顺序描述画面/人物/动作变化，3-6 条"],"text_in_video":["画面里出现的文字/字幕，没有就空数组"],"audio_summary":"声音内容概括（人声/音乐/音效）","content_type":"内容类型，如萌宠/美食/剧情/舞蹈/知识","notable":"最值得注意的细节"}',
    '',
    '要求：只根据这些帧和给定信息描述，不要编造看不到的细节；如果帧之间动作不连续，就如实说明。',
  ]
  return lines.filter((line) => line !== '').join('\n')
}

/** OCR 提示词（纯函数）。 */
export function buildOcrPrompt() {
  return '只输出这张图片里的文字内容本身，按阅读顺序逐行输出；不要输出坐标、数字串、JSON 或任何解释；没有文字就只输出「无」。'
}

/**
 * 清洗 OCR 输出（纯函数）：qwen-vl-ocr 常带「x1,y1,x2,y2,置信度,文字」坐标前缀，
 * 这里去掉坐标/纯数字行并去重。
 * @param {string} text
 * @returns {string}
 */
export function cleanOcrText(text) {
  const out = []
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    let line = rawLine.trim()
    if (line === '' || /^无$/.test(line)) continue
    // 去掉开头的坐标串（数字/逗号/空格），保留后面的文字
    if (/^(?:\d+\s*[,，]\s*)+\S/.test(line)) {
      line = line.replace(/^(?:\d+\s*[,，]\s*)+/, '').trim()
    }
    if (line === '' || /^[\d\s,，.。:：-]+$/.test(line)) continue
    if (!out.includes(line)) out.push(line)
  }
  return out.join('\n')
}

/**
 * 用 OCR 模型读画面文字（qwen-vl-ocr 等，消耗各自免费额度）。
 * @param {{
 *   frames?: string[], env?: Record<string, string | undefined>, maxFrames?: number,
 *   timeoutMs?: number, fetchImpl?: typeof fetch, stateFile?: string,
 * }} [options]
 * @returns {Promise<{ ok: boolean, text: string, model: string, perFrame: Array<{ frame: number, ok: boolean, text: string, error?: string }> }>}
 */
export async function ocrFrames(options = {}) {
  const env = options.env || process.env
  const config = videoModelConfig(env)
  const empty = { ok: false, text: '', model: '', perFrame: [] }
  if (!config.available || config.provider !== 'dashscope') return empty
  const frames = Array.isArray(options.frames) ? options.frames.filter(Boolean).slice(0, Math.max(1, Number(options.maxFrames) || 4)) : []
  if (frames.length === 0) return empty
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const timeout = Math.max(15_000, Math.min(Number(options.timeoutMs) || 90_000, 180_000))
  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(timeout)
    : undefined
  const configured = String((env && env.QQDY_OCR_MODEL) || '').trim()
  let models = configured !== '' ? [configured] : [...OCR_MODEL_CANDIDATES]
  for (const candidate of ['qwen-vl-ocr', 'qwen3.5-ocr']) {
    if (!models.includes(candidate)) models.push(candidate)
  }
  const stateFile = String(options.stateFile || modelStatePath())
  let state = readModelState(stateFile)
  const ordered = pickModelCandidates({ list: models, state })
  /** @type {Array<{ frame: number, ok: boolean, text: string, error?: string }>} */
  const perFrame = []
  let usedModel = ''
  const texts = []
  for (let index = 0; index < frames.length; index++) {
    let b64 = ''
    try {
      b64 = readFileSync(frames[index]).toString('base64')
    } catch (error) {
      perFrame.push({ frame: index + 1, ok: false, text: '', error: String((error && error.message) || error) })
      continue
    }
    let done = false
    for (const model of ordered) {
      try {
        const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${config.key}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: buildOcrPrompt() },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
              ],
            }],
            max_tokens: 400,
            temperature: 0,
          }),
          signal,
        })
        if (!response.ok) {
          const body = await response.text().catch(() => '')
          const kind = classifyVlmError(response.status, body)
          if (kind === 'quota' || kind === 'missing' || kind === 'throttle') {
            state = markModelCooling(state, model, kind)
            writeModelState(state, stateFile)
          }
          continue
        }
        const json = await response.json()
        const text = String(json && json.choices && json.choices[0] && json.choices[0].message
          ? json.choices[0].message.content || ''
          : '').trim()
        usedModel = model
        texts.push(text)
        perFrame.push({ frame: index + 1, ok: true, text })
        done = true
        break
      } catch (error) {
        perFrame.push({ frame: index + 1, ok: false, text: '', error: String((error && error.message) || error) })
      }
    }
    if (!done && perFrame.length <= index) perFrame.push({ frame: index + 1, ok: false, text: '', error: '所有 OCR 模型都不可用' })
  }
  const text = cleanOcrText(texts.join('\n'))
  return { ok: text !== '', text, model: usedModel, perFrame }
}

/**
 * 把画面帧交给视觉大模型，拿一段结构化「画面理解」（按免费/便宜优先顺序自动换模型）。
 * @param {{
 *   frames?: string[], title?: string, author?: string, transcript?: string,
 *   captions?: string[], env?: Record<string, string | undefined>,
 *   timeoutMs?: number, fetchImpl?: typeof fetch,
 *   stateFile?: string,
 * }} [options]
 * @returns {Promise<{ ok: true, text: string, model: string, tried: string[] } | { ok: false, error: string, tried?: string[] }>}
 */
export async function describeFrames(options = {}) {
  const env = options.env || process.env
  const config = videoModelConfig(env)
  if (!config.available) return { ok: false, error: MISSING_KEY_HINT }
  const framePaths = Array.isArray(options.frames) ? options.frames.filter((path) => String(path || '') !== '').slice(0, 8) : []
  if (framePaths.length === 0) return { ok: false, error: '没有画面帧可分析' }
  const prompt = buildDescribePrompt({
    frames: framePaths.length,
    title: options.title,
    author: options.author,
    transcript: options.transcript,
    captions: options.captions,
    ocrText: options.ocrText,
  })
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const timeout = Math.max(20_000, Math.min(Number(options.timeoutMs) || 180_000, 300_000))
  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(timeout)
    : undefined
  /** @type {string[]} */
  const base64Frames = []
  try {
    for (const path of framePaths) base64Frames.push(readFileSync(path).toString('base64'))
  } catch (error) {
    return { ok: false, error: `读画面帧失败：${String((error && error.message) || error)}` }
  }
  const stateFile = String(options.stateFile || modelStatePath())
  let state = readModelState(stateFile)
  const list = modelListForProvider(config.provider, env)
  const models = pickModelCandidates({ list, configured: config.model, state })
  const tried = []
  /** @type {string[]} */
  const errors = []
  if (config.provider === 'gemini') {
    const parts = [{ text: prompt }, ...base64Frames.map((data) => ({ inline_data: { mime_type: 'image/jpeg', data } }))]
    for (const model of models) {
      tried.push(model)
      try {
        const response = await fetchImpl(`${config.baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.key)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.3, maxOutputTokens: 900 } }),
          signal,
        })
        if (!response.ok) {
          const body = await response.text().catch(() => '')
          const kind = classifyVlmError(response.status, body)
          errors.push(`${model} ${kind}（HTTP ${response.status}）：${body.replace(/\s+/g, ' ').slice(0, 160)}`)
          state = kind === 'auth' ? state : markModelCooling(state, model, kind)
          writeModelState(state, stateFile)
          if (kind === 'auth') break
          continue
        }
        const json = await response.json()
        const candidate = json && Array.isArray(json.candidates) ? json.candidates[0] : null
        const content = candidate && candidate.content && Array.isArray(candidate.content.parts) ? candidate.content.parts : []
        const text = content.map((part) => String((part && part.text) || '')).join('').trim()
        if (text === '') {
          errors.push(`${model} 返回空内容`)
          continue
        }
        state = markModelSuccess(state, model)
        writeModelState(state, stateFile)
        return { ok: true, text, model, tried }
      } catch (error) {
        const name = String((error && error.name) || '')
        errors.push(`${model} ${name === 'TimeoutError' || name === 'AbortError' ? '超时' : String((error && error.message) || error)}`)
      }
    }
    return { ok: false, error: `Gemini 视频模型调用失败：${errors.join('；') || '未知原因'}`, tried }
  }
  const userContent = [{ type: 'text', text: prompt }, ...base64Frames.map((data) => ({
    type: 'image_url',
    image_url: { url: `data:image/jpeg;base64,${data}` },
  }))]
  for (const model of models) {
    tried.push(model)
    try {
      const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: '你是视频画面理解助手，负责把抽样的画面帧 + 文案 + 语音转写整理成准确、克制的结构化描述。' },
            { role: 'user', content: userContent },
          ],
          max_tokens: 900,
          temperature: 0.3,
        }),
        signal,
      })
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        const kind = classifyVlmError(response.status, body)
        errors.push(`${model} ${kind}（HTTP ${response.status}）：${body.replace(/\s+/g, ' ').slice(0, 160)}`)
        state = kind === 'auth' ? state : markModelCooling(state, model, kind)
        writeModelState(state, stateFile)
        if (kind === 'auth') break
        continue
      }
      const json = await response.json()
      const text = String(json && json.choices && json.choices[0] && json.choices[0].message
        ? json.choices[0].message.content || ''
        : '').trim()
      if (text === '') {
        errors.push(`${model} 返回空内容`)
        continue
      }
      state = markModelSuccess(state, model)
      writeModelState(state, stateFile)
      return { ok: true, text, model, tried }
    } catch (error) {
      const name = String((error && error.name) || '')
      errors.push(`${model} ${name === 'TimeoutError' || name === 'AbortError' ? '超时' : String((error && error.message) || error)}`)
    }
  }
  return { ok: false, error: `视频模型调用失败：${errors.join('；') || '未知原因'}`, tried }
}

/**
 * 「每个模型一个个开启」的探针：逐个模型发一条最小的文本请求（不花图片 token），
 * 告诉你这个模型现在能不能用、是额度问题还是没开通。
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   models?: string[],
 *   timeoutMs?: number,
 *   fetchImpl?: typeof fetch,
 *   stateFile?: string,
 * }} [options]
 * @returns {Promise<Array<{ model: string, ok: boolean, status: number, errorType: string, detail: string, ms: number }>>}
 */
export async function probeVlmModels(options = {}) {
  const env = options.env || process.env
  const config = videoModelConfig(env)
  if (!config.available) return []
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const timeout = Math.max(10_000, Math.min(Number(options.timeoutMs) || 60_000, 120_000))
  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(timeout)
    : undefined
  const stateFile = String(options.stateFile || modelStatePath())
  let state = readModelState(stateFile)
  const models = Array.isArray(options.models) && options.models.length > 0
    ? options.models.map(String)
    : modelListForProvider(config.provider, env)
  const results = []
  for (const model of models) {
    const started = Date.now()
    const line = { model, ok: false, status: 0, errorType: 'other', detail: '', ms: 0 }
    try {
      let response
      if (config.provider === 'gemini') {
        response = await fetchImpl(`${config.baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.key)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: '回复：OK' }] }], generationConfig: { maxOutputTokens: 5 } }),
          signal,
        })
      } else {
        response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${config.key}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: '回复：OK' }],
            max_tokens: 5,
          }),
          signal,
        })
      }
      const body = await response.text().catch(() => '')
      line.status = response.status
      line.ms = Date.now() - started
      line.ok = response.ok
      line.errorType = response.ok ? '' : classifyVlmError(response.status, body)
      line.detail = response.ok ? '可用' : body.replace(/\s+/g, ' ').slice(0, 180)
      if (response.ok) {
        state = markModelSuccess(state, model)
      } else if (line.errorType === 'quota' || line.errorType === 'throttle' || line.errorType === 'missing') {
        state = markModelCooling(state, model, line.errorType)
      }
    } catch (error) {
      line.ms = Date.now() - started
      line.detail = String((error && error.message) || error)
    }
    results.push(line)
  }
  writeModelState(state, stateFile)
  return results
}
