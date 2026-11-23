/**
 * lib/store.mjs —— 状态文件的读写与规整（无 DSH 依赖，可单测）。
 *
 * 状态文件在 `$DSH_HOME/qq-douyin-bridge/state.json`；原子写（tmp + rename），
 * 损坏时备份成 `.corrupt-<时间戳>` 再回默认值。**这里不存任何 token / Cookie。**
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { bridgeHome } from './paths.mjs'

export const FILTERS = Object.freeze(['all', 'quote', 'prefix'])
export const DEFAULT_PREFIX = '回：'
export const MIN_POLL_MS = 8_000
export const MAX_POLL_MS = 120_000
export const MAX_LOG = 100

/** 全新状态（未绑定、未启用）。 */
export function defaultState() {
  return {
    version: 1,
    enabled: false,
    douyin: { sec_uid: '', nick: '' },
    qq: { kind: 'private', id: '', label: '' },
    filter: 'quote',
    prefix: DEFAULT_PREFIX,
    direction: { douyinToQQ: true, qqToDouyin: true },
    pollMs: 15_000,
    cursors: {
      dq: { primed: false, lastAt: '', keys: [] },
      qq: { primed: false, lastTime: 0, ids: [] },
    },
    forwardedQqIds: [],
    stats: { dq: 0, qd: 0, lastRunAt: null, lastDqAt: null, lastQdAt: null, errors: 0 },
    lastError: '',
    log: [],
    settings: { qqApiBase: '', douyinApiBase: '' },
    links: { autoCard: true, autoOpen: 'private', cooldownSec: 60, fetchVideo: true, autoUnderstand: true },
    linkRecent: {},
    // v0.6：抖音私信里的「分享视频卡片」默认**不转进 QQ**（避免刷屏）；要看用 douyin_video action=watch
    inbound: { skipCards: true },
    // v0.3：QQ ↔ 抖音 的共享对话摘要（两边的「鱼」都能通过宿主注入的 prompt 上下文看到）
    transcript: [],
  }
}

/** 把不确定的输入夹到合法区间。 */
function clampNumber(value, min, max, fallback) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.max(min, Math.min(max, Math.round(num)))
}

/** 布尔规整：只认真正的 boolean，其它给 fallback。 */
function sourceBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** 只接受非空字符串（去首尾空白），否则给 fallback。 */
function textOf(value, fallback = '', max = 200) {
  const text = String(value ?? '').trim()
  if (text === '') return fallback
  return text.slice(0, max)
}

/** ISO 时间字符串（非法给 null）。 */
function isoOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const date = new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/** 一条日志行的规整。 */
function normalizeLogRow(row) {
  if (row === null || typeof row !== 'object') return null
  const dir = ['dq', 'qd', 'sys'].includes(String(row.dir)) ? String(row.dir) : 'sys'
  return {
    at: isoOrNull(row.at) || new Date().toISOString(),
    dir,
    ok: row.ok === true,
    text: textOf(row.text, '', 200),
    note: textOf(row.note, '', 200),
  }
}

/**
 * 把任意输入规整成合法状态（缺字段补默认、越界夹紧、旧版本兜底）。
 * @param {unknown} raw
 * @returns {ReturnType<typeof defaultState>}
 */
export function normalizeState(raw) {
  const base = defaultState()
  const src = raw !== null && typeof raw === 'object' ? /** @type {Record<string, any>} */ (raw) : {}

  base.enabled = src.enabled === true
  base.douyin = {
    sec_uid: textOf(src.douyin && src.douyin.sec_uid, '', 200),
    nick: textOf(src.douyin && src.douyin.nick, '', 60),
  }
  base.qq = {
    kind: src.qq && src.qq.kind === 'group' ? 'group' : 'private',
    id: textOf(src.qq && src.qq.id, '', 20).replace(/\D/g, ''),
    label: textOf(src.qq && src.qq.label, '', 60),
  }
  base.filter = FILTERS.includes(String(src.filter)) ? String(src.filter) : 'quote'
  base.prefix = textOf(src.prefix, DEFAULT_PREFIX, 20) || DEFAULT_PREFIX
  base.direction = {
    douyinToQQ: !(src.direction && src.direction.douyinToQQ === false),
    qqToDouyin: !(src.direction && src.direction.qqToDouyin === false),
  }
  base.pollMs = clampNumber(src.pollMs, MIN_POLL_MS, MAX_POLL_MS, 15_000)

  const dq = src.cursors && src.cursors.dq ? src.cursors.dq : {}
  base.cursors.dq = {
    primed: dq.primed === true,
    lastAt: isoOrNull(dq.lastAt) || '',
    keys: Array.isArray(dq.keys) ? dq.keys.map((k) => String(k)).slice(-200) : [],
  }
  const qq = src.cursors && src.cursors.qq ? src.cursors.qq : {}
  base.cursors.qq = {
    primed: qq.primed === true,
    lastTime: Number.isFinite(Number(qq.lastTime)) ? Math.max(0, Number(qq.lastTime)) : 0,
    ids: Array.isArray(qq.ids) ? qq.ids.map((id) => String(id)).slice(-200) : [],
  }
  base.forwardedQqIds = Array.isArray(src.forwardedQqIds)
    ? src.forwardedQqIds.map((id) => String(id)).filter(Boolean).slice(-60)
    : []
  base.stats = {
    dq: Math.max(0, Number(src.stats && src.stats.dq) || 0),
    qd: Math.max(0, Number(src.stats && src.stats.qd) || 0),
    lastRunAt: isoOrNull(src.stats && src.stats.lastRunAt),
    lastDqAt: isoOrNull(src.stats && src.stats.lastDqAt),
    lastQdAt: isoOrNull(src.stats && src.stats.lastQdAt),
    errors: Math.max(0, Number(src.stats && src.stats.errors) || 0),
  }
  base.lastError = textOf(src.lastError, '', 300)
  base.log = Array.isArray(src.log)
    ? src.log.map(normalizeLogRow).filter(Boolean).slice(0, MAX_LOG)
    : []
  base.settings = {
    qqApiBase: textOf(src.settings && src.settings.qqApiBase, '', 200),
    douyinApiBase: textOf(src.settings && src.settings.douyinApiBase, '', 200),
  }
  // v0.2：抖音链接处理（QQ 里出现链接时自动发卡片 / 本机打开）
  const links = src.links !== null && typeof src.links === 'object' ? src.links : {}
  base.links = {
    autoCard: sourceBool(links.autoCard, true),
    autoOpen: ['off', 'private', 'always'].includes(String(links.autoOpen)) ? String(links.autoOpen) : 'private',
    cooldownSec: clampNumber(links.cooldownSec, 10, 600, 60),
    // v0.7：「QQ 里发抖音链接 → 直接把视频（MP4）发回 QQ」
    fetchVideo: sourceBool(links.fetchVideo, true),
    autoUnderstand: sourceBool(links.autoUnderstand, true),
  }
  // 链接去重水位：aweme_id / 短链 → 毫秒时间戳；只留最近 50 条。
  const recent = src.linkRecent !== null && typeof src.linkRecent === 'object' ? src.linkRecent : {}
  const recentEntries = Object.entries(recent)
    .filter(([, at]) => Number.isFinite(Number(at)) && Number(at) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 50)
  base.linkRecent = Object.fromEntries(recentEntries.map(([key, at]) => [String(key).slice(0, 200), Number(at)]))
  // v0.6：抖音私信收进来时的过滤（默认跳过「分享视频/作品」卡片，不往 QQ 发）
  const inbound = src.inbound !== null && typeof src.inbound === 'object' ? src.inbound : {}
  base.inbound = { skipCards: sourceBool(inbound.skipCards, true) }
  // v0.3 共享对话摘要：{ at, side: 'douyin'|'qq'|'feed'|'link'|'sys', text, kind? }，最多 40 条
  base.transcript = Array.isArray(src.transcript)
    ? src.transcript
      .filter((row) => row !== null && typeof row === 'object')
      .map((row) => ({
        at: isoOrNull(row.at) || '',
        side: ['douyin', 'qq', 'feed', 'link', 'sys'].includes(String(row.side)) ? String(row.side) : 'sys',
        text: textOf(row.text, '', 300),
        kind: textOf(row.kind, '', 20),
      }))
      .filter((row) => row.text !== '')
      .slice(-40)
    : []
  return base
}

/**
 * 读状态。文件不存在 → 默认值；解析失败 → 备份损坏文件 + 默认值。
 * @param {string} [home] 插件运行目录
 * @returns {{ state: ReturnType<typeof defaultState>, recovered: boolean, file: string }}
 */
export function loadState(home = bridgeHome()) {
  const file = join(home, 'state.json')
  if (!existsSync(file)) return { state: defaultState(), recovered: false, file }
  try {
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    return { state: normalizeState(JSON.parse(raw)), recovered: false, file }
  } catch {
    try {
      renameSync(file, `${file}.corrupt-${Date.now()}`)
    } catch {
      /* 备份失败也继续用默认值 */
    }
    return { state: defaultState(), recovered: true, file }
  }
}

/**
 * 原子写状态：先写同目录 tmp，再 rename 覆盖。
 * @param {string} home 插件运行目录
 * @param {unknown} state 状态
 * @returns {{ ok: boolean, file: string, error?: string }}
 */
export function saveState(home, state) {
  const file = join(home, 'state.json')
  const normalized = normalizeState(state)
  const tmp = `${file}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(normalized, null, 1)}\n`, 'utf8')
    renameSync(tmp, file)
    return { ok: true, file }
  } catch (error) {
    try {
      if (existsSync(tmp)) renameSync(tmp, `${tmp}.failed`)
    } catch {
      /* 清理失败不影响报错 */
    }
    return { ok: false, file, error: String((error && error.message) || error) }
  }
}

/** 一条日志推进状态（新的在前，最多 100 条）。 */
export function pushLog(state, row) {
  const normalized = normalizeLogRow(row)
  if (normalized === null) return state
  state.log = [normalized, ...(Array.isArray(state.log) ? state.log : [])].slice(0, MAX_LOG)
  return state
}

/** 绑定是否齐。 */
export function isConfigured(state) {
  return Boolean(
    state
    && state.douyin
    && String(state.douyin.sec_uid || '') !== ''
    && state.qq
    && String(state.qq.id || '') !== '',
  )
}

/**
 * 给设置页/工具看的公开状态（不含内部水位、不含任何 token）。
 * @param {ReturnType<typeof defaultState>} state
 * @param {{ qqApiBase?: string, douyinApiBase?: string, storePath?: string }} extra
 */
export function publicState(state, extra = {}) {
  return {
    version: 1,
    enabled: state.enabled === true,
    configured: isConfigured(state),
    binding: {
      douyin: { nick: state.douyin.nick, sec_uid: state.douyin.sec_uid },
      qq: { kind: state.qq.kind, id: state.qq.id, label: state.qq.label },
    },
    filter: state.filter,
    prefix: state.prefix,
    direction: { ...state.direction },
    pollMs: state.pollMs,
    stats: { ...state.stats },
    lastError: state.lastError,
    qqApiBase: String(extra.qqApiBase || ''),
    douyinApiBase: String(extra.douyinApiBase || ''),
    storePath: String(extra.storePath || join(bridgeHome(), 'state.json')),
    links: {
      autoCard: state.links.autoCard === true,
      autoOpen: state.links.autoOpen,
      cooldownSec: state.links.cooldownSec,
      fetchVideo: state.links.fetchVideo !== false,
      autoUnderstand: state.links.autoUnderstand !== false,
    },
    inbound: { skipCards: state.inbound.skipCards === true },
  }
}
