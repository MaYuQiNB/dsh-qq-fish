#!/usr/bin/env node
/**
 * dsh-qq-douyin-bridge —— 离线自检（selfcheck）。
 * ============================================================================
 * 目标：纯 Node、零网络、零 DSH 依赖，`node selfcheck.mjs` 直接跑。
 *
 * 覆盖（对应 CONTRACT.md §6 / §7）：
 *   1. 状态层 lib/store.mjs：defaultState / normalizeState / loadState / saveState /
 *      pushLog / publicState / isConfigured，以及 v0.2 的 links / linkRecent 规整；
 *   2. 文案层 lib/format.mjs：formatDouyinForQQ / stripPrefix / clip / dedupeKey / nowIso …
 *   3. 抖音挑新 lib/filter.mjs#pickNewDouyin：首轮对表 / 只挑 them / 去重 / 水位推进；
 *   4. QQ 过滤 lib/filter.mjs#pickQqIngest：all / quote / prefix、跳过机器人自己、
 *      message_id 去重、单轮上限、quotedOk 兜底、水位推进、首轮对表、v0.2 的 skipIds；
 *   5. v0.2 抖音链接层 lib/links.mjs：extractUrls / isDouyinUrl / classifyDouyinUrl /
 *      parseTarget / extractTargets / stripDouyinLinks，以及用注入假 fetch 的
 *      resolveShortLink / resolveAwemeTarget（不联网）；
 *   6. v0.2 抖音视频/评论/推荐流纯函数 lib/douyin-tools.mjs：parseComments / parseVideoDetail /
 *      formatCount / formatVideoDigest / parseFeed / formatFeedDigest / formatFeedForQQ /
 *      pickJson / discoverDouyinTools（临时 DSH_HOME，不起真实子进程、不联网）；
 *   7. OneBot 响应规整 lib/onebot.mjs#normalizeOneBotResponse（用注入的假 fetch，
 *      所以依然零网络）；顺带测 lib/douyin.mjs 的 ok/sent 判定；
 *   8. 路径与自动发现：lib/paths.mjs、lib/discover.mjs（临时 DSH_HOME）；
 *   9. 包契约静态检查：package.json exports / dsh.bundle.patch / locale / icon.svg /
 *      CONTRACT.md / index.js（含 v0.2 的 douyin_video / 推荐流 feed 分支）/ client.js 等文件齐备
 *      （client.js 还没写完时输出 SKIP，不算失败）；
 *  10. v0.3 共享记忆 / Cookie 解析：lib/share.mjs 的 pickQqMemories / pickDmFacts /
 *      formatSharedContext / readSharedContext（临时目录）、lib/douyin-tools.mjs#parseCookieHeader、
 *      store.transcript 的默认 / 规整 / publicState 不外泄，以及 index.js 的 systemPrompt.context /
 *      bridgeDigestText / ensureBrowserLogin 静态检查。
 *
 * 不测：index.js 的 HTTP 路由与轮询（要 DSH 宿主）、client.js 的渲染、
 * 真实 QQ / 抖音账号的端到端行为（这里一行网络请求都不发）。
 *
 * 输出最后一行固定是 `N passed, M failed`；有失败时 exit code = 1。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspect, isDeepStrictEqual } from 'node:util'

import { aiOverlapOf, listDouyinMemoryPeers, readQqBridgeConfig } from './lib/discover.mjs'
import { createDouyin } from './lib/douyin.mjs'
import {
  discoverDouyinTools,
  formatCount,
  formatFeedDigest,
  formatFeedForQQ,
  formatVideoDigest,
  parseComments,
  parseCookieHeader,
  parseFeed,
  parseVideoDetail,
  pickJson,
} from './lib/douyin-tools.mjs'
import { looksLikeForwardedMark, pickNewDouyin, pickQqIngest, replyToIdOf, segmentsOf, textOf as filterTextOf } from './lib/filter.mjs'
import { MARK, QQ_MARK_RE, clip, clockOf, dedupeKey, formatDouyinForQQ, hasContent, nowIso, stripPrefix } from './lib/format.mjs'
import {
  classifyDouyinUrl,
  extractTargets,
  extractUrls,
  isDouyinUrl,
  parseTarget,
  resolveAwemeTarget,
  resolveShortLink,
  stripDouyinLinks,
} from './lib/links.mjs'
import { createOneBot, normalizeOneBotResponse } from './lib/onebot.mjs'
import { bridgeHome, douyinHome, dshHome, qqBridgeDir, stateFile } from './lib/paths.mjs'
import { formatSharedContext, pickDmFacts, pickQqMemories, readSharedContext } from './lib/share.mjs'
import {
  MISSING_KEY_HINT,
  THROTTLE_COOLDOWN_MS,
  VLM_MODEL_CANDIDATES,
  buildDescribePrompt,
  classifyVlmError,
  cleanOcrText,
  markModelCooling,
  markModelSuccess,
  modelListForProvider,
  parseKeyFile,
  pickModelCandidates,
  readModelState,
  videoModelConfig,
  writeModelState,
} from './lib/video-ai.mjs'
import {
  DEFAULT_PREFIX,
  FILTERS,
  MAX_LOG,
  MAX_POLL_MS,
  defaultState,
  isConfigured,
  loadState,
  MIN_POLL_MS,
  normalizeState,
  publicState,
  pushLog,
  saveState,
} from './lib/store.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const TMP = mkdtempSync(join(tmpdir(), 'qqdy-selfcheck-'))
const ORIGINAL_DSH_HOME = process.env.DSH_HOME

let passed = 0
let failed = 0
let skipped = 0
const failureNames = []

// ---------------------------------------------------------------------------
// 极简断言器（失败打印名字 + 期望 + 实际，不抛异常，跑完所有条目）
// ---------------------------------------------------------------------------

const fmt = (value) => inspect(value, { depth: 6, breakLength: 140, maxArrayLength: 12, maxStringLength: 200 })

function pass(name) {
  passed += 1
  console.log(`  ok   ${name}`)
}

function fail(name, want, got) {
  failed += 1
  failureNames.push(name)
  console.log(`  FAIL ${name}`)
  console.log(`       期望: ${fmt(want)}`)
  console.log(`       实际: ${fmt(got)}`)
}

function eq(name, got, want) {
  if (isDeepStrictEqual(got, want)) pass(name)
  else fail(name, want, got)
}

function truthy(name, value) {
  if (value) pass(name)
  else fail(name, true, value)
}

function check(name, condition, actual) {
  if (condition) pass(name)
  else fail(name, true, actual)
}

function skip(name, why) {
  skipped += 1
  console.log(`  SKIP ${name} —— ${why}`)
}

function section(title) {
  console.log(`\n── ${title}`)
}

/** 跑一个分组；分组里抛异常只记一条失败，后面继续跑。 */
async function group(title, fn) {
  section(title)
  try {
    await fn()
  } catch (error) {
    fail(`${title}：分组内未捕获异常`, '不抛异常', String((error && error.stack) || error))
  }
}

// ---------------------------------------------------------------------------
// 测试用的小工具
// ---------------------------------------------------------------------------

/** 假的 fetch：记录调用，返回给定响应。全程零网络。 */
function makeFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init, calls.length)
  }
  fetchImpl.calls = calls
  return fetchImpl
}

/** 假 Response：只需要 ok / status / text()。 */
function jsonResponse(payload, options = {}) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return { ok: options.ok !== false, status: options.status === undefined ? 200 : options.status, text: async () => text }
}

/** OneBot 消息段：一段 text。 */
function textSegment(text) {
  return [{ type: 'text', data: { text } }]
}

/** QQ 历史里的一条消息。 */
function qqMessage(id, senderId, text, time, extra = {}) {
  return { message_id: id, time, sender: { user_id: senderId }, message: textSegment(text), ...extra }
}

/** 一个临时目录（建在 os.tmpdir() 下）。 */
function tmpDir(name) {
  const dir = join(TMP, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

// ---------------------------------------------------------------------------
// 1. 状态层
// ---------------------------------------------------------------------------

function storeTests() {
  // v0.2 加了 links / linkRecent（链接分享设置 + 链接去重水位）；v0.3 加了 transcript（QQ↔抖音共享摘要）
  const DEFAULT_KEYS = ['version', 'enabled', 'douyin', 'qq', 'filter', 'prefix', 'direction', 'pollMs',
    'cursors', 'forwardedQqIds', 'stats', 'lastError', 'log', 'settings', 'links', 'linkRecent', 'inbound', 'transcript']

  const base = defaultState()
  eq('defaultState 顶层字段齐全', Object.keys(base).sort(), [...DEFAULT_KEYS].sort())
  eq('defaultState 基本默认值', {
    version: base.version,
    enabled: base.enabled,
    filter: base.filter,
    prefix: base.prefix,
    pollMs: base.pollMs,
    direction: base.direction,
    cursors: base.cursors,
  }, {
    version: 1,
    enabled: false,
    filter: 'quote',
    prefix: '回：',
    pollMs: 15000,
    direction: { douyinToQQ: true, qqToDouyin: true },
    cursors: {
      dq: { primed: false, lastAt: '', keys: [] },
      qq: { primed: false, lastTime: 0, ids: [] },
    },
  })
  eq('defaultState 统计默认值', base.stats, { dq: 0, qd: 0, lastRunAt: null, lastDqAt: null, lastQdAt: null, errors: 0 })
  eq('defaultState 未绑定时 douyin/qq 为空', [base.douyin.sec_uid, base.douyin.nick, base.qq.id], ['', '', ''])
  eq('defaultState 新对象（两次调用不共享引用）', base === defaultState(), false)
  eq('常量：FILTERS', FILTERS, ['all', 'quote', 'prefix'])
  eq('常量：DEFAULT_PREFIX', DEFAULT_PREFIX, '回：')
  eq('常量：MIN_POLL_MS / MAX_POLL_MS', [MIN_POLL_MS, MAX_POLL_MS], [8000, 120000])
  eq('常量：MAX_LOG', MAX_LOG, 100)

  // ---- normalizeState：脏输入规整 ----
  const dirty = normalizeState({
    enabled: 'true',
    filter: 'QUOTE',
    pollMs: 1,
    prefix: '   ',
    qq: { kind: 'GROUP', id: ' 38a06b24 2644 ' },
    douyin: { sec_uid: '  MS4wLjABAAAAa1  ', nick: '  小王  ' },
    direction: { douyinToQQ: false, qqToDouyin: 'false' },
    forwardedQqIds: [1, 2, ''],
    stats: { dq: -5, qd: '3', errors: 'x' },
    lastError: 'x'.repeat(400),
  })
  eq('normalizeState：字符串 "true" 不算 true', dirty.enabled, false)
  eq('normalizeState：true 保留', normalizeState({ enabled: true }).enabled, true)
  eq('normalizeState：非法 filter 回 quote', normalizeState({ filter: 'QUOTE' }).filter, 'quote')
  eq('normalizeState：合法 filter 保留', normalizeState({ filter: 'all' }).filter, 'all')
  eq('normalizeState：pollMs 低于下限夹到 8000', normalizeState({ pollMs: 1 }).pollMs, 8000)
  eq('normalizeState：pollMs 高于上限夹到 120000', normalizeState({ pollMs: 999999 }).pollMs, 120000)
  eq('normalizeState：pollMs 字符串数字可用', normalizeState({ pollMs: '30000' }).pollMs, 30000)
  eq('normalizeState：pollMs 小数四舍五入', normalizeState({ pollMs: 15000.6 }).pollMs, 15001)
  eq('normalizeState：pollMs 非数字回 15000', normalizeState({ pollMs: 'abc' }).pollMs, 15000)
  eq('normalizeState：QQ id 去掉字母与空格', dirty.qq.id, '<OWNER_QQ>')
  eq('normalizeState：qq.kind 大写不算 group', dirty.qq.kind, 'private')
  eq('normalizeState：qq.kind=group 保留', normalizeState({ qq: { kind: 'group' } }).qq.kind, 'group')
  eq('normalizeState：sec_uid 去首尾空格', dirty.douyin.sec_uid, 'MS4wLjABAAAAa1')
  eq('normalizeState：nick 去空格', dirty.douyin.nick, '小王')
  eq('normalizeState：空 prefix 回默认', dirty.prefix, '回：')
  eq('normalizeState：prefix 去空格后保留', normalizeState({ prefix: ' 喂： ' }).prefix, '喂：')
  eq('normalizeState：direction 只认布尔 false', dirty.direction, { douyinToQQ: false, qqToDouyin: true })
  eq('normalizeState：forwardedQqIds 转字符串', dirty.forwardedQqIds, ['1', '2'])
  eq('normalizeState：stats 负数归零 / 数字字符串转数字', [dirty.stats.dq, dirty.stats.qd, dirty.stats.errors], [0, 3, 0])
  eq('normalizeState：lastError 截到 300 字', dirty.lastError.length, 300)
  eq('normalizeState(null) 等于默认值', normalizeState(null), defaultState())
  eq('normalizeState(非对象) 等于默认值', normalizeState('nope'), defaultState())
  eq('normalizeState：cursors.dq.keys 最多 200', normalizeState({
    cursors: { dq: { keys: Array.from({ length: 250 }, (_, i) => `k${i}`) } },
  }).cursors.dq.keys.length, 200)
  eq('normalizeState：cursors.dq.keys 保留尾部（最近 200）', normalizeState({
    cursors: { dq: { keys: Array.from({ length: 250 }, (_, i) => `k${i}`) } },
  }).cursors.dq.keys[0], 'k50')
  eq('normalizeState：cursors.qq.ids 最多 200', normalizeState({
    cursors: { qq: { ids: Array.from({ length: 230 }, (_, i) => `i${i}`) } },
  }).cursors.qq.ids[0], 'i30')
  eq('normalizeState：cursors.dq.lastAt 非法回空串', normalizeState({ cursors: { dq: { lastAt: 'not-a-date' } } }).cursors.dq.lastAt, '')
  eq('normalizeState：cursors.dq.lastAt 变成标准 ISO', normalizeState({
    cursors: { dq: { lastAt: '2026-11-13T14:00:00+08:00' } },
  }).cursors.dq.lastAt, '2026-11-13T06:00:00.000Z')
  eq('normalizeState：forwardedQqIds 最多 60', normalizeState({
    forwardedQqIds: Array.from({ length: 70 }, (_, i) => String(i)),
  }).forwardedQqIds.length, 60)
  eq('normalizeState：stats.lastRunAt 非法回 null', normalizeState({ stats: { lastRunAt: 'x' } }).stats.lastRunAt, null)
  eq('normalizeState：log 非法行被过滤', normalizeState({ log: [null, 'x', 5, true] }).log, [])
  const normLog = normalizeState({
    log: [
      { dir: 'dq', at: '2026-01-01T00:00:00Z', ok: true, text: '  hi  ', note: '' },
      { dir: 'bogus' },
    ],
  })
  eq('normalizeState：log 合法行保留', normLog.log.length, 2)
  eq('normalizeState：log 行文本去空格 / ok 严格布尔', [normLog.log[0].text, normLog.log[0].ok, normLog.log[0].dir], ['hi', true, 'dq'])
  eq('normalizeState：log 非法 dir 回 sys', normLog.log[1].dir, 'sys')
  const manyLogs = Array.from({ length: 150 }, (_, i) => ({ at: '2026-01-01T00:00:00.000Z', dir: 'dq', ok: true, text: `r${i}` }))
  const normMany = normalizeState({ log: manyLogs })
  eq('normalizeState：log 最多 100 条', normMany.log.length, 100)
  eq('normalizeState：log 保留最早的 100 条（新的在前）', [normMany.log[0].text, normMany.log[99].text], ['r0', 'r99'])

  // ---- loadState / saveState（os.tmpdir() 下的临时目录） ----
  const missingHome = join(TMP, 'missing')
  const missing = loadState(missingHome)
  eq('loadState：文件不存在 → 默认值', missing.state, defaultState())
  eq('loadState：文件不存在 → recovered=false', missing.recovered, false)
  eq('loadState：返回的 file 指向 state.json', missing.file.endsWith('state.json'), true)

  const roundHome = tmpDir('roundtrip')
  const saveResult = saveState(roundHome, {
    enabled: true,
    filter: 'all',
    prefix: '喂：',
    pollMs: 30000,
    qq: { kind: 'group', id: '123456789', label: '测试群' },
    douyin: { sec_uid: 'MS4wLjABAAAAtest', nick: '小王' },
    stats: { dq: 7 },
  })
  eq('saveState：ok', saveResult.ok, true)
  eq('saveState：返回的 file 路径', saveResult.file, join(roundHome, 'state.json'))
  truthy('saveState：文件真的写出来了', existsSync(join(roundHome, 'state.json')))
  const round = loadState(roundHome)
  eq('loadState：写→读 recovered=false', round.recovered, false)
  eq('loadState：写→读 开关一致', round.state.enabled, true)
  eq('loadState：写→读 filter 一致', round.state.filter, 'all')
  eq('loadState：写→读 prefix 一致', round.state.prefix, '喂：')
  eq('loadState：写→读 pollMs 一致', round.state.pollMs, 30000)
  eq('loadState：写→读 QQ 绑定一致', round.state.qq, { kind: 'group', id: '123456789', label: '测试群' })
  eq('loadState：写→读 抖音绑定一致', round.state.douyin, { sec_uid: 'MS4wLjABAAAAtest', nick: '小王' })
  eq('loadState：写→读 统计一致', round.state.stats.dq, 7)
  const rawState = readFileSync(join(roundHome, 'state.json'), 'utf8')
  eq('状态文件：是合法 JSON', (() => { try { JSON.parse(rawState); return true } catch { return false } })(), true)
  eq('状态文件：不存 accessToken', rawState.includes('accessToken'), false)
  eq('状态文件：不存 token 字段', /"token"/.test(rawState), false)

  const bomHome = tmpDir('bom')
  writeFileSync(join(bomHome, 'state.json'), `\uFEFF${JSON.stringify({ enabled: true })}`, 'utf8')
  eq('loadState：带 BOM 也能读', loadState(bomHome).state.enabled, true)

  const corruptHome = tmpDir('corrupt')
  writeFileSync(join(corruptHome, 'state.json'), '{ 这不是 JSON', 'utf8')
  const recovered = loadState(corruptHome)
  eq('损坏状态文件：recovered=true', recovered.recovered, true)
  eq('损坏状态文件：回默认值', recovered.state, defaultState())
  const corruptFiles = readdirSync(corruptHome)
  eq('损坏状态文件：备份成 .corrupt-<ts>', corruptFiles.some((name) => /^state\.json\.corrupt-\d+$/.test(name)), true)
  eq('损坏状态文件：原文件名不再存在', corruptFiles.includes('state.json'), false)

  const dirtyHome = tmpDir('dirty-save')
  saveState(dirtyHome, { enabled: 'yes', pollMs: 1, filter: 'nope', prefix: '  ' })
  const dirtyLoaded = loadState(dirtyHome).state
  eq('saveState：写盘前会 normalize（enabled/pollMs/filter）', [dirtyLoaded.enabled, dirtyLoaded.pollMs, dirtyLoaded.filter], [false, 8000, 'quote'])

  // ---- pushLog ----
  const logState = defaultState()
  for (let i = 0; i < 105; i += 1) {
    pushLog(logState, { at: '2026-01-01T00:00:00.000Z', dir: 'dq', ok: true, text: `m${i}` })
  }
  eq('pushLog：上限 100 条', logState.log.length, MAX_LOG)
  eq('pushLog：新的在前', logState.log[0].text, 'm104')
  eq('pushLog：最旧被挤掉', logState.log[99].text, 'm5')
  const pushState = defaultState()
  eq('pushLog：返回同一个 state 对象', pushLog(pushState, { text: 'x' }) === pushState, true)
  eq('pushLog：非对象行被忽略', pushLog(defaultState(), null).log.length, 0)
  eq('pushLog：缺字段的行补默认 dir=sys、ok=false', [pushState.log[0].dir, pushState.log[0].ok], ['sys', false])

  // ---- isConfigured / publicState ----
  eq('isConfigured：默认未绑定', isConfigured(defaultState()), false)
  const bound = normalizeState({ qq: { id: '<OWNER_QQ>' }, douyin: { sec_uid: 'MS4wSEC' } })
  eq('isConfigured：两边都有才算绑定', isConfigured(bound), true)
  eq('isConfigured：缺抖音 sec_uid 不算', isConfigured(normalizeState({ qq: { id: '<OWNER_QQ>' } })), false)
  eq('isConfigured：缺 QQ id 不算', isConfigured(normalizeState({ douyin: { sec_uid: 'MS4wSEC' } })), false)

  const publicSource = normalizeState({
    enabled: true,
    douyin: { sec_uid: 'MS4wSEC', nick: '小王' },
    qq: { kind: 'private', id: '<OWNER_QQ>', label: '西嗨' },
    filter: 'all',
    prefix: '回：',
    stats: { dq: 3, qd: 2 },
  })
  const pub = publicState(publicSource, {
    qqApiBase: 'http://127.0.0.1:3000',
    douyinApiBase: 'http://127.0.0.1:54487/api/douyin-duty',
    storePath: 'C:\\tmp\\state.json',
  })
  eq('publicState：configured', pub.configured, true)
  eq('publicState：binding 结构', pub.binding, {
    douyin: { nick: '小王', sec_uid: 'MS4wSEC' },
    qq: { kind: 'private', id: '<OWNER_QQ>', label: '西嗨' },
  })
  eq('publicState：绑定摘要字段齐', [pub.version, pub.enabled, pub.filter, pub.prefix, pub.pollMs], [1, true, 'all', '回：', 15000])
  eq('publicState：extra 覆盖三个端点字段', [pub.qqApiBase, pub.douyinApiBase, pub.storePath],
    ['http://127.0.0.1:3000', 'http://127.0.0.1:54487/api/douyin-duty', 'C:\\tmp\\state.json'])
  for (const leaked of ['cursors', 'settings', 'forwardedQqIds', 'log']) {
    eq(`publicState：不泄漏 ${leaked}`, Object.prototype.hasOwnProperty.call(pub, leaked), false)
  }
  eq('publicState：JSON 里没有 token / Cookie 字样', /accessToken|cookie|sec_uid\s*:\s*"[^"]{0,4}"/i.test(JSON.stringify(pub)), false)
  const pubDefault = publicState(defaultState())
  eq('publicState：默认 storePath 指向插件家目录', pubDefault.storePath.endsWith(join('qq-douyin-bridge', 'state.json')), true)
  eq('publicState：未绑定 configured=false', pubDefault.configured, false)

  // ---- v0.2：state.links / state.linkRecent ----
  eq('v0.2 defaultState.links 默认值', defaultState().links, { autoCard: true, autoOpen: 'private', cooldownSec: 60, fetchVideo: true, autoUnderstand: true })
  eq('v0.2 defaultState.linkRecent 默认空对象', defaultState().linkRecent, {})
  eq('v0.2 defaultState.linkRecent 是独立对象', defaultState().linkRecent === defaultState().linkRecent, false)

  const dirtyLinks = normalizeState({ links: { autoCard: 'yes', autoOpen: '乱写', cooldownSec: 1 } })
  eq('v0.2 normalizeState：autoCard 非布尔回默认 true', dirtyLinks.links.autoCard, true)
  eq('v0.2 normalizeState：autoOpen 非法回 private', dirtyLinks.links.autoOpen, 'private')
  eq('v0.2 normalizeState：cooldownSec 低于下限夹到 10', dirtyLinks.links.cooldownSec, 10)
  eq('v0.2 normalizeState：cooldownSec 高于上限夹到 600', normalizeState({ links: { cooldownSec: 9999 } }).links.cooldownSec, 600)
  eq('v0.2 normalizeState：cooldownSec 非数字回 60', normalizeState({ links: { cooldownSec: 'abc' } }).links.cooldownSec, 60)
  eq('v0.2 normalizeState：cooldownSec 数字字符串可用', normalizeState({ links: { cooldownSec: '120' } }).links.cooldownSec, 120)
  eq('v0.2 normalizeState：autoCard=false 保留', normalizeState({ links: { autoCard: false } }).links.autoCard, false)
  eq('v0.2 normalizeState：autoOpen=always / off 保留',
    [normalizeState({ links: { autoOpen: 'always' } }).links.autoOpen, normalizeState({ links: { autoOpen: 'off' } }).links.autoOpen],
    ['always', 'off'])
  eq('v0.2 normalizeState：links 缺字段回默认',
    normalizeState({ links: {} }).links,
    { autoCard: true, autoOpen: 'private', cooldownSec: 60, fetchVideo: true, autoUnderstand: true })
  eq('v0.11 normalizeState：autoUnderstand=false 保留 / 非布尔回 true',
    [normalizeState({ links: { autoUnderstand: false } }).links.autoUnderstand,
      normalizeState({ links: { autoUnderstand: 'no' } }).links.autoUnderstand],
    [false, true])

  const recent60 = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`id${i}`, (i + 1) * 1000]))
  const recentNorm = normalizeState({ linkRecent: { ...recent60, 坏: 'x', 零: 0 } }).linkRecent
  eq('v0.2 normalizeState：linkRecent 最多 50 条', Object.keys(recentNorm).length, 50)
  eq('v0.2 normalizeState：linkRecent 丢最旧的 10 条', Object.prototype.hasOwnProperty.call(recentNorm, 'id9'), false)
  eq('v0.2 normalizeState：linkRecent 保留最新一条', recentNorm.id59, 60000)
  eq('v0.2 normalizeState：linkRecent 值都是数字', [...new Set(Object.values(recentNorm).map((value) => typeof value))], ['number'])
  eq('v0.2 normalizeState：linkRecent 非数字 / 0 条目被过滤',
    [Object.prototype.hasOwnProperty.call(recentNorm, '坏'), Object.prototype.hasOwnProperty.call(recentNorm, '零')],
    [false, false])

  const pubLinks = publicState(normalizeState({ links: { autoOpen: 'always', cooldownSec: 30 }, linkRecent: { '123': Date.now() } }))
  eq('v0.2 publicState：含 links 字段', Object.prototype.hasOwnProperty.call(pubLinks, 'links'), true)
  eq('v0.2 publicState：links 与 state 一致', pubLinks.links, { autoCard: true, autoOpen: 'always', cooldownSec: 30, fetchVideo: true, autoUnderstand: true })
  eq('v0.2 publicState：不泄漏 linkRecent', Object.prototype.hasOwnProperty.call(pubLinks, 'linkRecent'), false)
  eq('v0.2 publicState：linkRecent 不出现在 JSON 里', JSON.stringify(pubLinks).includes('linkRecent'), false)

  // ---- v0.6：inbound.skipCards（抖音私信里的分享视频卡片默认不转 QQ）----
  eq('v0.6 defaultState.inbound 默认 skipCards=true', defaultState().inbound, { skipCards: true })
  eq('v0.6 normalizeState：缺 inbound 时 skipCards=true', normalizeState({}).inbound.skipCards, true)
  eq('v0.6 normalizeState：inbound.skipCards=false 保留', normalizeState({ inbound: { skipCards: false } }).inbound.skipCards, false)
  eq('v0.6 normalizeState：inbound.skipCards 非布尔回 true', normalizeState({ inbound: { skipCards: 'no' } }).inbound.skipCards, true)
  eq('v0.6 publicState：含 inbound 字段', publicState(normalizeState({ inbound: { skipCards: false } })).inbound, { skipCards: false })

  // ---- v0.3：transcript（QQ ↔ 抖音共享对话摘要）----
  eq('v0.3 defaultState.transcript 默认空数组', defaultState().transcript, [])
  eq('v0.3 defaultState.transcript 每次都是新数组', defaultState().transcript === defaultState().transcript, false)
  eq('v0.3 normalizeState：transcript 非数组回 []',
    [normalizeState({ transcript: 'x' }).transcript, normalizeState({ transcript: {} }).transcript], [[], []])
  const normTranscript = normalizeState({
    transcript: [
      { at: '2026-11-14T00:00:00+08:00', side: 'douyin', text: '  抖音来的  ', kind: ' text ' },
      { side: 'bogus', text: '非法 side 变 sys' },
      { side: 'qq' },
      null,
      'x',
      { at: 'not-a-date', side: 'feed', text: 'at 非法回空串' },
      { side: 'link', text: 'kind 数字转字符串', kind: 123 },
      { side: 'sys', text: '系统提示', at: '2026-11-14T01:00:00Z' },
    ],
  }).transcript
  eq('v0.3 normalizeState：transcript 非法行被丢弃', normTranscript.length, 5)
  eq('v0.3 normalizeState：transcript at 规整成 ISO', normTranscript[0].at, '2026-11-13T16:00:00.000Z')
  eq('v0.3 normalizeState：transcript text / kind 去空格',
    [normTranscript[0].text, normTranscript[0].kind], ['抖音来的', 'text'])
  eq('v0.3 normalizeState：transcript 每行只有四个字段',
    Object.keys(normTranscript[0]).sort(), ['at', 'kind', 'side', 'text'])
  eq('v0.3 normalizeState：transcript 非法 side 回 sys',
    [normTranscript[1].side, normTranscript[1].text], ['sys', '非法 side 变 sys'])
  eq('v0.3 normalizeState：transcript at 非法回空串', normTranscript[2].at, '')
  eq('v0.3 normalizeState：transcript kind 数字转字符串', normTranscript[3].kind, '123')
  eq('v0.3 normalizeState：transcript 合法 side 都保留',
    normTranscript.map((row) => row.side), ['douyin', 'sys', 'feed', 'link', 'sys'])
  eq('v0.3 normalizeState：transcript text 截到 300 字',
    normalizeState({ transcript: [{ side: 'qq', text: 'x'.repeat(400) }] }).transcript[0].text.length, 300)
  const manyTranscript = normalizeState({
    transcript: Array.from({ length: 50 }, (_, i) => ({ side: 'qq', text: `t${i}` })),
  }).transcript
  eq('v0.3 normalizeState：transcript 最多 40 条', manyTranscript.length, 40)
  eq('v0.3 normalizeState：transcript 保留最近的 40 条',
    [manyTranscript[0].text, manyTranscript[39].text], ['t10', 't49'])
  const pubTranscript = publicState(normalizeState({
    transcript: [{ at: '2026-11-14T00:00:00Z', side: 'qq', text: '私聊里的秘密' }],
  }))
  eq('v0.3 publicState：不泄漏 transcript', Object.prototype.hasOwnProperty.call(pubTranscript, 'transcript'), false)
  eq('v0.3 publicState：JSON 里没有 transcript', JSON.stringify(pubTranscript).includes('transcript'), false)
}

// ---------------------------------------------------------------------------
// 2. 文案层
// ---------------------------------------------------------------------------

function formatTests() {
  eq('MARK 常量', MARK, '【抖音·')
  eq('formatDouyinForQQ：普通文本', formatDouyinForQQ({ nick: '小王', text: ' 周末去爬山吗？ ' }), '【抖音·小王】周末去爬山吗？')
  eq('formatDouyinForQQ：昵称为空回「抖音好友」', formatDouyinForQQ({ nick: '  ', text: 'hi' }), '【抖音·抖音好友】hi')
  eq('formatDouyinForQQ：卡片加 [卡片] 标记', formatDouyinForQQ({ nick: '小王', text: '视频标题', kind: 'card' }), '【抖音·小王】[卡片] 视频标题')
  eq('formatDouyinForQQ：空卡片文本', formatDouyinForQQ({ nick: '小王', kind: 'card' }), '【抖音·小王】[分享卡片]')
  eq('formatDouyinForQQ：空非卡片文本', formatDouyinForQQ({ nick: '小王' }), '【抖音·小王】[非文字消息]')
  eq('formatDouyinForQQ：正文截到 1800 字', formatDouyinForQQ({ nick: '小王', text: 'a'.repeat(2000) }), `【抖音·小王】${'a'.repeat(1800)}`)
  eq('formatDouyinForQQ：昵称截到 40 字', formatDouyinForQQ({ nick: 'n'.repeat(100), text: 'hi' }), `【抖音·${'n'.repeat(40)}】hi`)
  const markMatch = '【抖音·小王】你好'.match(QQ_MARK_RE)
  eq('QQ_MARK_RE：能取出昵称', markMatch ? markMatch[1] : null, '小王')
  eq('QQ_MARK_RE：普通文本不匹配', QQ_MARK_RE.test('你好'), false)

  eq('stripPrefix：中文冒号', stripPrefix('回：你好', '回：'), { matched: true, text: '你好' })
  eq('stripPrefix：英文冒号也认', stripPrefix('回:你好', '回：'), { matched: true, text: '你好' })
  eq('stripPrefix：前导空格也认', stripPrefix('  回：你好', '回：'), { matched: true, text: '你好' })
  eq('stripPrefix：前缀后空格被吃掉', stripPrefix('回：   你好  ', '回：'), { matched: true, text: '你好  ' })
  eq('stripPrefix：不匹配原样返回', stripPrefix('你好', '回：'), { matched: false, text: '你好' })
  eq('stripPrefix：空文本', stripPrefix('', '回：'), { matched: false, text: '' })
  eq('stripPrefix：只有前缀 → 剥成空串', stripPrefix('回：', '回：'), { matched: true, text: '' })
  eq('stripPrefix：prefix 为空不剥', stripPrefix('回：你好', ''), { matched: false, text: '回：你好' })
  eq('stripPrefix：自定义前缀', stripPrefix('abc 你好', 'abc'), { matched: true, text: '你好' })

  eq('clip：截断', clip('abcdef', 3), 'abc')
  eq('clip：不超长原样返回', clip('abc', 3), 'abc')
  eq('clip：max=0 回空串', clip('abc', 0), '')
  eq('clip：null → 空串', clip(null, 5), '')
  eq('clip：非字符串转字符串再截', clip(123456, 3), '123')
  eq('clip：max 非有限数回空串', clip('abc', Number.NaN), '')

  eq('dedupeKey：方向 + 正文前 60 字', dedupeKey('them', 'x'.repeat(100)), `them|${'x'.repeat(60)}`)
  eq('dedupeKey：undefined 也安全', dedupeKey(undefined, undefined), '|')

  eq('nowIso：Date → ISO', nowIso(new Date('2026-11-13T14:00:00.000Z')), '2026-11-13T14:00:00.000Z')
  eq('nowIso：字符串 → 标准 ISO', nowIso('2026-11-13T14:00:00Z'), '2026-11-13T14:00:00.000Z')
  eq('nowIso：非法输入 → 空串', nowIso('nope'), '')
  truthy('nowIso：无参数给当前时间', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(nowIso()))

  eq('clockOf：非法输入 → 空串', clockOf('nope'), '')
  truthy('clockOf：合法时间 → HH:mm:ss', /^\d{2}:\d{2}:\d{2}$/.test(clockOf('2026-11-13T14:05:09.000Z')))

  eq('hasContent：中文算有内容', hasContent('你好'), true)
  eq('hasContent：纯标点算没内容', hasContent('！？…'), false)
  eq('hasContent：空/null 算没内容', [hasContent(''), hasContent(null), hasContent('   ')], [false, false, false])
}

// ---------------------------------------------------------------------------
// 3. 消息段解析（filter.mjs 的纯工具）
// ---------------------------------------------------------------------------

function segmentTests() {
  eq('segmentsOf：非数组 → []', segmentsOf('hi'), [])
  eq('segmentsOf：过滤非对象元素', segmentsOf([{ type: 'text' }, {}, null, 7]).length, 2)
  eq('textOf：字符串原样返回', filterTextOf('hi'), 'hi')
  eq('textOf：只拼 text 段', filterTextOf([
    { type: 'text', data: { text: '你' } },
    { type: 'image', data: { file: 'a.jpg' } },
    { type: 'text', data: { text: '好' } },
  ]), '你好')
  eq('textOf：空 text 段不贡献字符', filterTextOf([{ type: 'text', data: { text: '' } }]), '')
  eq('replyToIdOf：取出 reply 段 id', replyToIdOf([
    { type: 'reply', data: { id: 12345 } },
    { type: 'text', data: { text: 'x' } },
  ]), '12345')
  eq('replyToIdOf：空 id → null', replyToIdOf([{ type: 'reply', data: { id: '   ' } }]), null)
  eq('replyToIdOf：没有 reply 段 → null', replyToIdOf([{ type: 'text', data: { text: 'x' } }]), null)
  eq('looksLikeForwardedMark：转发消息', looksLikeForwardedMark('【抖音·小王】hi'), true)
  eq('looksLikeForwardedMark：前导空格也认', looksLikeForwardedMark('  【抖音·小王】hi'), true)
  eq('looksLikeForwardedMark：普通消息', [looksLikeForwardedMark('hi'), looksLikeForwardedMark(null)], [false, false])
}

// ---------------------------------------------------------------------------
// 4. 抖音挑新 pickNewDouyin
// ---------------------------------------------------------------------------

function pickNewDouyinTests() {
  const messages = [
    { from: 'them', text: '早', at: '2026-11-13T10:00:00.000Z' },
    { from: 'me', text: '早啊', at: '2026-11-13T10:01:00.000Z' },
    { from: 'them', text: '  周末去爬山吗？ ', at: '2026-11-13T10:02:00.000Z', kind: 'card' },
    { from: 'unknown', text: '？' },
    { from: 'them', text: '   ', at: '2026-11-13T10:03:00.000Z' },
    null,
    'x',
  ]
  const KEY_A = '2026-11-13T10:00:00.000Z|them|早'
  const KEY_B = '2026-11-13T10:02:00.000Z|them|周末去爬山吗？'

  const first = pickNewDouyin({ messages })
  eq('首轮对表：不返回任何消息', first.fresh, [])
  eq('首轮对表：baseline=true', first.baseline, true)
  eq('首轮对表：next.primed=true', first.next.primed, true)
  eq('首轮对表：lastAt 取对方最新时间', first.next.lastAt, '2026-11-13T10:02:00.000Z')
  eq('首轮对表：keys 只记 them 的指纹', first.next.keys, [KEY_A, KEY_B])

  const all = pickNewDouyin({ messages, primed: true, lastAt: '', keys: [] })
  eq('只挑 from=them（且非空文本）', all.fresh, [
    { from: 'them', text: '早', at: '2026-11-13T10:00:00.000Z', kind: 'text', item_id: '', cover: '' },
    { from: 'them', text: '周末去爬山吗？', at: '2026-11-13T10:02:00.000Z', kind: 'card', item_id: '', cover: '' },
  ])
  eq('非首轮 baseline=false', all.baseline, false)

  const later = [...messages, { from: 'them', text: '新消息', at: '2026-11-13T10:05:00.000Z' }]
  const second = pickNewDouyin({ messages: later, primed: true, lastAt: first.next.lastAt, keys: first.next.keys })
  eq('已见过的不重复', second.fresh.map((m) => m.text), ['新消息'])
  eq('水位推进到最新', second.next.lastAt, '2026-11-13T10:05:00.000Z')
  truthy('keys 里包含新消息指纹', second.next.keys.includes('2026-11-13T10:05:00.000Z|them|新消息'))

  const old = pickNewDouyin({
    messages: [{ from: 'them', text: '没见过的旧消息', at: '2026-11-13T09:00:00.000Z' }],
    primed: true,
    lastAt: '2026-11-13T10:02:00.000Z',
    keys: [],
  })
  eq('早于水位的旧消息不回捞', old.fresh, [])

  const onlyMe = pickNewDouyin({ messages: [{ from: 'me', text: '我发的', at: '2026-11-13T10:00:00.000Z' }] })
  eq('只有 me 消息：fresh 为空', onlyMe.fresh, [])
  eq('只有 me 消息：keys 为空', onlyMe.next.keys, [])

  const empty = pickNewDouyin()
  eq('空列表安全：默认输入', empty, { fresh: [], baseline: true, next: { primed: true, lastAt: '', keys: [] } })
  const emptyPrimed = pickNewDouyin({ messages: [], primed: true, lastAt: '2026-11-13T10:00:00.000Z', keys: ['old'] })
  eq('空列表安全：已 prime 时不回退', [emptyPrimed.fresh, emptyPrimed.baseline, emptyPrimed.next.lastAt], [[], false, '2026-11-13T10:00:00.000Z'])

  const keys250 = Array.from({ length: 250 }, (_, i) => `k${i}`)
  const capped = pickNewDouyin({ messages: [], primed: true, keys: keys250 })
  eq('keys 最多保留 200', capped.next.keys.length, 200)
  eq('keys 保留最近 200（尾部）', capped.next.keys[0], 'k50')

  // ---- v0.6：skipCards=true 时「分享视频卡片」不转 QQ ----
  const cardMessages = [
    { from: 'them', text: '正常文字', at: '2026-11-13T10:00:00.000Z', kind: 'text' },
    {
      from: 'them',
      text: '分享的视频标题',
      at: '2026-11-13T10:01:00.000Z',
      kind: 'card',
      item_id: '7700000000000000001',
      cover: 'https://x/y.jpg',
    },
  ]
  const skipOn = pickNewDouyin({ messages: cardMessages, primed: true, lastAt: '', keys: [], skipCards: true })
  eq('v0.6 skipCards=true：卡片不进 fresh', skipOn.fresh.map((m) => m.kind), ['text'])
  eq('v0.6 skipCards=true：卡片指纹仍记进 keys（不会每轮重现）',
    skipOn.next.keys.includes('2026-11-13T10:01:00.000Z|them|分享的视频标题'), true)
  eq('v0.6 skipCards=true：水位仍推进到卡片时间', skipOn.next.lastAt, '2026-11-13T10:01:00.000Z')
  const skipOff = pickNewDouyin({ messages: cardMessages, primed: true, lastAt: '', keys: [] })
  eq('v0.6 不传 skipCards：卡片照常进 fresh', skipOff.fresh.map((m) => m.kind), ['text', 'card'])
  eq('v0.6 卡片 item_id / cover 透传',
    [skipOff.fresh[1].item_id, skipOff.fresh[1].cover], ['7700000000000000001', 'https://x/y.jpg'])
}

// ---------------------------------------------------------------------------
// 5. QQ 过滤 pickQqIngest
// ---------------------------------------------------------------------------

function pickQqIngestTests() {
  const all = pickQqIngest({
    messages: [
      qqMessage(1, '2001', '你好', 1000),
      qqMessage(2, '2002', '在吗', 1001),
      qqMessage(3, '2003', '   ', 1002),
    ],
    primed: true,
    filter: 'all',
    selfUin: '9999',
    lastTime: 0,
  })
  eq('all：全部转发（空文本跳过）', all.items.map((item) => item.id), ['1', '2'])
  eq('all：正文与 via', [all.items[0].text, all.items[0].via], ['你好', 'all'])
  eq('all：空文本不算 filtered', all.filtered, 0)
  eq('all：水位推进', all.next.lastTime, 1002)

  const robot = pickQqIngest({
    messages: [
      { message_id: 11, time: 1000, sender: { user_id: '9999' }, message: textSegment('机器人发的') },
      { message_id: 12, time: 1001, user_id: '9999', sender: { user_id: '8888' }, message: textSegment('顶层 user_id 是机器人') },
      { message_id: 13, time: 1002, user_id: 9999, sender: { user_id: 9999 }, message: textSegment('数字 id') },
      { message_id: 14, time: 1003, user_id: 9999, sender: {}, message: textSegment('只有顶层 id') },
    ],
    primed: true,
    filter: 'all',
    selfUin: '9999',
    lastTime: 0,
  })
  eq('跳过机器人自己发的（sender.user_id / user_id / 数字混用）', robot.items, [])

  const deduped = pickQqIngest({
    messages: [qqMessage(1, '2001', '一', 1000), qqMessage(2, '2002', '二', 1001), qqMessage(3, '2003', '三', 1002)],
    ids: ['1', '2'],
    primed: true,
    filter: 'all',
    lastTime: 0,
  })
  eq('已处理 message_id 去重', deduped.items.map((item) => item.id), ['3'])

  const many = Array.from({ length: 25 }, (_, i) => qqMessage(String(i + 1), '2001', `第${i + 1}条`, 1000 + i))
  const defaultLimit = pickQqIngest({ messages: many, primed: true, filter: 'all', lastTime: 0 })
  eq('默认单轮上限 5', defaultLimit.items.length, 5)
  eq('超出计入 overLimit', defaultLimit.overLimit, 20)
  eq('limit 被夹到最多 20', pickQqIngest({ messages: many, primed: true, filter: 'all', lastTime: 0, limit: 100 }).items.length, 20)

  const replyOf = (id) => ({ type: 'reply', data: { id } })
  const quoteMessage = (id, replyId, text, time) => ({
    message_id: id,
    time,
    sender: { user_id: '2001' },
    message: [replyOf(replyId), { type: 'text', data: { text } }],
  })
  const quoteHit = pickQqIngest({
    messages: [quoteMessage(21, 500, '好的', 1000), quoteMessage(22, 501, '另一个', 1001)],
    primed: true,
    filter: 'quote',
    forwardedIds: ['500'],
    lastTime: 0,
  })
  eq('quote：命中已登记的转发 message_id', quoteHit.items.map((item) => item.id), ['21'])
  eq('quote：未命中的被过滤', quoteHit.filtered, 1)
  const quoteFallback = pickQqIngest({
    messages: [quoteMessage(23, 502, '兜底命中', 1000)],
    primed: true,
    filter: 'quote',
    quotedOk: ['502'],
    lastTime: 0,
  })
  eq('quote：quotedOk 兜底命中', quoteFallback.items.map((item) => item.id), ['23'])
  eq('quote：via=quote', quoteFallback.items[0].via, 'quote')
  const quoteMiss = pickQqIngest({
    messages: [{ message_id: 24, time: 1000, sender: { user_id: '2001' }, message: textSegment('没引用') }],
    primed: true,
    filter: 'quote',
    lastTime: 0,
  })
  eq('quote：没有 reply 段的被过滤', quoteMiss.items, [])
  eq('quote：filtered 计数', quoteMiss.filtered, 1)

  const prefix = pickQqIngest({
    messages: [
      qqMessage(31, '2001', '回：你好', 1000),
      qqMessage(32, '2002', '你好', 1001),
      qqMessage(33, '2003', '回:也行', 1002),
    ],
    primed: true,
    filter: 'prefix',
    prefix: '回：',
    lastTime: 0,
  })
  eq('prefix：命中并剥掉前缀', prefix.items.map((item) => [item.id, item.text]), [['31', '你好'], ['33', '也行']])
  eq('prefix：via=prefix', prefix.items[0].via, 'prefix')
  eq('prefix：不匹配的被过滤', prefix.filtered, 1)
  const sevenMatches = Array.from({ length: 7 }, (_, i) => qqMessage(String(40 + i), '2001', `回：第${i + 1}条`, 1000 + i))
  const sevenPicked = pickQqIngest({ messages: sevenMatches, primed: true, filter: 'prefix', prefix: '回：', lastTime: 0 })
  eq('prefix：单轮上限 5', sevenPicked.items.length, 5)
  eq('prefix：超出 2 条计入 overLimit', sevenPicked.overLimit, 2)

  const unprimed = pickQqIngest({
    messages: [qqMessage(51, '2001', 'a', 1000), qqMessage(52, '9999', 'self', 1005)],
    selfUin: '9999',
    filter: 'all',
  })
  eq('首轮对表：items 为空', unprimed.items, [])
  eq('首轮对表：overLimit=0', unprimed.overLimit, 0)
  eq('首轮对表：next.primed=true', unprimed.next.primed, true)
  eq('首轮对表：水位推进到最新', unprimed.next.lastTime, 1005)
  eq('首轮对表：ids 记录本轮所有 message_id', [...unprimed.next.ids].sort(), ['51', '52'])

  const watermark = pickQqIngest({
    messages: [qqMessage(61, '2001', '旧', 900), qqMessage(62, '2001', '等于水位', 1000), qqMessage(63, '2001', '更旧', 500)],
    primed: true,
    filter: 'all',
    lastTime: 1000,
  })
  eq('水位：早于水位的旧消息跳过', watermark.items.map((item) => item.id), ['62'])

  const empty = pickQqIngest()
  eq('空数组安全：items', empty.items, [])
  eq('空数组安全：filtered/overLimit', [empty.filtered, empty.overLimit], [0, 0])
  eq('空数组安全：next', empty.next, { primed: true, lastTime: 0, ids: [] })

  const realId = pickQqIngest({
    messages: [{ real_id: 77, time: 1000, sender: { user_id: '2001' }, message: textSegment('real') }],
    primed: true,
    filter: 'all',
    lastTime: 0,
  })
  eq('real_id 作为 message_id 兜底', realId.items[0].id, '77')
  eq('没有 message_id 的消息跳过', pickQqIngest({
    messages: [{ time: 1000, sender: { user_id: '2001' }, message: textSegment('无 id') }],
    primed: true,
    filter: 'all',
    lastTime: 0,
  }).items, [])
  eq('只有图片段（没有文字）的消息跳过', pickQqIngest({
    messages: [{ message_id: 81, time: 1000, sender: { user_id: '2001' }, message: [{ type: 'image', data: { file: 'a.jpg' } }] }],
    primed: true,
    filter: 'all',
    lastTime: 0,
  }).items, [])
  eq('多个 text 段拼起来', pickQqIngest({
    messages: [{
      message_id: 91,
      time: 1000,
      sender: { user_id: '2001' },
      message: [{ type: 'text', data: { text: '你' } }, { type: 'text', data: { text: '好' } }],
    }],
    primed: true,
    filter: 'all',
    lastTime: 0,
  }).items[0].text, '你好')

  const capIds = Array.from({ length: 230 }, (_, i) => `i${i}`)
  const capResult = pickQqIngest({ messages: [], ids: capIds, primed: true, filter: 'all', lastTime: 0 })
  eq('ids 最多保留 200', capResult.next.ids.length, 200)
  eq('ids 保留最近 200（尾部）', capResult.next.ids[0], 'i30')

  // ---- v0.2：skipIds（QQ 里的抖音链接消息不再重复当纯文本转）----
  const skipMessages = [
    qqMessage(101, '2001', '看 https://www.douyin.com/video/7300000000000000001', 1000),
    qqMessage(102, '2002', '这条正常', 1001),
  ]
  const skipped = pickQqIngest({ messages: skipMessages, primed: true, filter: 'all', lastTime: 0, skipIds: ['101'] })
  eq('v0.2 skipIds：命中的 message_id 不出现在 items', skipped.items.map((item) => item.id), ['102'])
  eq('v0.2 skipIds：命中跳过的 id 仍进 next.ids', skipped.next.ids.includes('101'), true)
  eq('v0.2 skipIds：不传 skipIds 时行为与此前一致',
    pickQqIngest({ messages: skipMessages, primed: true, filter: 'all', lastTime: 0 }).items.map((item) => item.id),
    ['101', '102'])
  eq('v0.2 skipIds：空数组不影响',
    pickQqIngest({ messages: skipMessages, primed: true, filter: 'all', lastTime: 0, skipIds: [] }).items.length,
    2)
  const skippedAll = pickQqIngest({
    messages: [qqMessage(103, '2001', '只有一条链接', 1000)],
    primed: true,
    filter: 'all',
    lastTime: 0,
    skipIds: ['103'],
  })
  eq('v0.2 skipIds：全被跳过时 items 为空', skippedAll.items, [])
  eq('v0.2 skipIds：全被跳过时 next.ids 仍记录', skippedAll.next.ids, ['103'])
  eq('v0.2 skipIds：首轮对表也照记 next.ids',
    pickQqIngest({ messages: [qqMessage(104, '2001', '链接', 1000)], filter: 'all', skipIds: ['104'] }).next.ids,
    ['104'])
}

// ---------------------------------------------------------------------------
// 6. v0.2 抖音链接识别（lib/links.mjs；短链解析注入假 fetch，不联网）
// ---------------------------------------------------------------------------

const AWEME_A = '7300000000000000001'
const AWEME_B = '7300000000000000002'
const CANONICAL_A = `https://www.douyin.com/video/${AWEME_A}`
const CANONICAL_B = `https://www.douyin.com/video/${AWEME_B}`
const SHORT_URL = 'https://v.douyin.com/abc/'

async function linksTests() {
  // ---- extractUrls ----
  eq('extractUrls：单个链接', extractUrls(`看这个 https://www.douyin.com/video/${AWEME_A}`), [CANONICAL_A])
  eq('extractUrls：中文逗号 / 句号截断', extractUrls(`https://www.douyin.com/video/${AWEME_A}，笑死。`), [CANONICAL_A])
  eq('extractUrls：中文弯引号截断', extractUrls(`看看“https://www.douyin.com/video/${AWEME_A}”好笑`), [CANONICAL_A])
  eq('extractUrls：尖括号 / 中文括号不吞', extractUrls(`<https://www.douyin.com/video/${AWEME_A}>（转发）`), [CANONICAL_A])
  eq('extractUrls：英文逗号 / 右括号截断', extractUrls(`(https://www.douyin.com/video/${AWEME_A}),`), [CANONICAL_A])
  eq('extractUrls：重复链接去重', extractUrls(`https://www.douyin.com/video/${AWEME_A} 再说一遍 https://www.douyin.com/video/${AWEME_A}`).length, 1)
  eq('extractUrls：只留 http(s)', extractUrls('ftp://example.com/a douyin.com/video/123'), [])
  eq('extractUrls：多链接按出现顺序', extractUrls(`一 https://v.douyin.com/abc/ 二 https://www.douyin.com/note/${AWEME_B}`), [SHORT_URL, `https://www.douyin.com/note/${AWEME_B}`])
  eq('extractUrls：空 / 非字符串安全', [extractUrls(null), extractUrls(''), extractUrls(undefined)], [[], [], []])

  // ---- isDouyinUrl ----
  eq('isDouyinUrl：douyin.com', isDouyinUrl('https://douyin.com/video/1'), true)
  eq('isDouyinUrl：www.douyin.com', isDouyinUrl(CANONICAL_A), true)
  eq('isDouyinUrl：v.douyin.com', isDouyinUrl(SHORT_URL), true)
  eq('isDouyinUrl：iesdouyin.com', isDouyinUrl(`https://www.iesdouyin.com/share/video/${AWEME_A}/`), true)
  eq('isDouyinUrl：example.com 不算', isDouyinUrl('https://example.com/video/1'), false)
  eq('isDouyinUrl：非 URL 安全', [isDouyinUrl(''), isDouyinUrl(null), isDouyinUrl('not a url')], [false, false, false])

  // ---- classifyDouyinUrl ----
  eq('classifyDouyinUrl：/video/<id>', classifyDouyinUrl(CANONICAL_A),
    { kind: 'video', aweme_id: AWEME_A, canonical: CANONICAL_A })
  eq('classifyDouyinUrl：/note/<id>', classifyDouyinUrl(`https://www.douyin.com/note/${AWEME_B}`),
    { kind: 'note', aweme_id: AWEME_B, canonical: CANONICAL_B })
  eq('classifyDouyinUrl：/share/video/<id>', classifyDouyinUrl(`https://www.iesdouyin.com/share/video/${AWEME_A}/?region=CN`),
    { kind: 'video', aweme_id: AWEME_A, canonical: CANONICAL_A })
  eq('classifyDouyinUrl：?modal_id=<id>', classifyDouyinUrl(`https://www.douyin.com/discover?modal_id=${AWEME_A}`),
    { kind: 'video', aweme_id: AWEME_A, canonical: CANONICAL_A })
  eq('classifyDouyinUrl：v.douyin.com 短链', classifyDouyinUrl(SHORT_URL), { kind: 'short' })
  eq('classifyDouyinUrl：未知路径 → unknown', classifyDouyinUrl('https://www.douyin.com/user/MS4wLjABAAAA'), { kind: 'unknown' })
  eq('classifyDouyinUrl：非抖音域名 → unknown', classifyDouyinUrl('https://example.com/video/123456789'), { kind: 'unknown' })
  eq('classifyDouyinUrl：id 长度不合法 → unknown', classifyDouyinUrl('https://www.douyin.com/video/123'), { kind: 'unknown' })

  // ---- parseTarget ----
  eq('parseTarget：裸 19 位 aweme_id', parseTarget(AWEME_A),
    { kind: 'video', aweme_id: AWEME_A, canonical: CANONICAL_A })
  eq('parseTarget：完整链接', parseTarget(CANONICAL_A).aweme_id, AWEME_A)
  eq('parseTarget：文字里含链接', parseTarget(`看这个 ${CANONICAL_A} 哈哈`).aweme_id, AWEME_A)
  eq('parseTarget：短链', parseTarget(SHORT_URL), { kind: 'short', short_url: SHORT_URL })
  eq('parseTarget：非抖音链接 → null', parseTarget(`https://example.com/video/${AWEME_A}`), null)
  eq('parseTarget：空输入 → null', [parseTarget(''), parseTarget(null)], [null, null])

  // ---- extractTargets ----
  const targets = extractTargets(`${CANONICAL_A} ${SHORT_URL} ${CANONICAL_A}`)
  eq('extractTargets：一条文字多个链接去重', targets.map((target) => target.kind), ['video', 'short'])
  eq('extractTargets：视频目标带 canonical', targets[0].canonical, CANONICAL_A)
  eq('extractTargets：裸 id 文本也能认出', extractTargets(AWEME_B).map((target) => target.aweme_id), [AWEME_B])
  eq('extractTargets：没有抖音目标 → []', extractTargets('你好 https://example.com/x'), [])
  eq('extractTargets：空文本 → []', extractTargets(''), [])

  // ---- stripDouyinLinks ----
  eq('stripDouyinLinks：去掉链接保留人话', stripDouyinLinks(`看这个 ${CANONICAL_A} 好笑`),
    { text: '看这个 好笑', links: [CANONICAL_A] })
  eq('stripDouyinLinks：没有链接原样返回', stripDouyinLinks('纯文字'), { text: '纯文字', links: [] })
  eq('stripDouyinLinks：非抖音链接不动', stripDouyinLinks('https://example.com/a'),
    { text: 'https://example.com/a', links: [] })

  // ---- resolveShortLink（注入假 fetch，不联网）----
  const redirectFetch = makeFetch(() => ({ url: CANONICAL_A, text: async () => '<html></html>' }))
  const resolved = await resolveShortLink(SHORT_URL, { fetchImpl: redirectFetch })
  eq('resolveShortLink：302 后 URL 带 /video/<id> → ok', [resolved.ok, resolved.aweme_id], [true, AWEME_A])
  eq('resolveShortLink：假 fetch 收到的是短链', redirectFetch.calls[0].url, SHORT_URL)

  const htmlFetch = makeFetch(() => ({
    url: 'https://www.douyin.com/share/landing?x=1',
    text: async () => `<script>var s="video/${AWEME_A}"</script>`,
  }))
  const htmlResolved = await resolveShortLink(SHORT_URL, { fetchImpl: htmlFetch })
  eq('resolveShortLink：最终 URL 不认得时从 HTML 兜底取 id', [htmlResolved.ok, htmlResolved.aweme_id], [true, AWEME_A])

  const throwResolved = await resolveShortLink(SHORT_URL, {
    fetchImpl: async () => { throw Object.assign(new Error('boom'), { name: 'TimeoutError' }) },
  })
  eq('resolveShortLink：异常 → ok=false 且不抛', throwResolved.ok, false)
  truthy('resolveShortLink：异常文案提示贴完整链接', /短链解析失败|贴完整|超时/.test(String(throwResolved.error)))

  const unknownResolved = await resolveShortLink(SHORT_URL, {
    fetchImpl: makeFetch(() => ({ url: 'https://www.douyin.com/404', text: async () => 'not found' })),
  })
  eq('resolveShortLink：跳到不认识的地址 → ok=false', unknownResolved.ok, false)

  // ---- resolveAwemeTarget ----
  const directTarget = await resolveAwemeTarget({ aweme_id: AWEME_A })
  eq('resolveAwemeTarget：直接给 aweme_id', [directTarget.ok, directTarget.aweme_id, directTarget.canonical], [true, AWEME_A, CANONICAL_A])
  eq('resolveAwemeTarget：完整链接', (await resolveAwemeTarget({ url: CANONICAL_A })).aweme_id, AWEME_A)
  eq('resolveAwemeTarget：含链接的一段文字', (await resolveAwemeTarget({ text: `看 ${CANONICAL_A} 笑死` })).aweme_id, AWEME_A)
  eq('resolveAwemeTarget：短链（假 fetch 跟随）', (await resolveAwemeTarget({ url: SHORT_URL, fetchImpl: redirectFetch })).aweme_id, AWEME_A)
  const noTarget = await resolveAwemeTarget({ text: '今天天气不错' })
  eq('resolveAwemeTarget：没有目标 → ok=false', noTarget.ok, false)
  truthy('resolveAwemeTarget：没有目标给明确错误', /没找到/.test(String(noTarget.error)))
  eq('resolveAwemeTarget：短链解析失败 → ok=false',
    (await resolveAwemeTarget({ url: SHORT_URL, fetchImpl: async () => { throw new Error('dead') } })).ok,
    false)
}

// ---------------------------------------------------------------------------
// 7. v0.2 抖音视频 / 评论 / 推荐流纯函数（lib/douyin-tools.mjs；不起真子进程、不联网）
// ---------------------------------------------------------------------------

function douyinToolsTests() {
  // ---- parseComments：真实 api-comments.py 输出格式 ----
  const SAMPLE = [
    'page=0 status_code=0 comments=19 新=19 has_more=1',
    '  cid=123  昵称  [内容]  赞45  1700000000',
    '      └ reply cid=456 回复者 [回复内容]  1700000001',
  ].join('\n')
  const parsed = parseComments(SAMPLE)
  eq('parseComments：顶层评论条数', parsed.comments.length, 1)
  eq('parseComments：cid / nick / text', [parsed.comments[0].cid, parsed.comments[0].nick, parsed.comments[0].text], ['123', '昵称', '内容'])
  eq('parseComments：digg / time', [parsed.comments[0].digg, parsed.comments[0].time], [45, 1700000000])
  eq('parseComments：楼中楼 reply 条数', parsed.comments[0].replies.length, 1)
  const reply0 = parsed.comments[0].replies[0] || {}
  eq('parseComments：reply 字段', [reply0.cid, reply0.nick, reply0.text, reply0.time], ['456', '回复者', '回复内容', 1700000001])
  eq('parseComments：pages 记录分页行', parsed.pages, ['page=0 status_code=0 comments=19 新=19 has_more=1'])
  eq('parseComments：status_code=0 → statusOk=true', parsed.statusOk, true)
  eq('parseComments：total = 返回条数', parsed.total, 1)
  const limitedComments = parseComments(`${SAMPLE}\n  cid=124  别人  [第二条]  赞1  1700000002\n  cid=125  第三人  [第三条]  赞0  1700000003`, { limit: 2 })
  eq('parseComments：limit 截断评论条数', limitedComments.comments.length, 2)
  eq('parseComments：status_code 非 0 → statusOk=false',
    parseComments('page=0 status_code=5 comments=0 新=0 has_more=0').statusOk, false)
  eq('parseComments：空输入安全', parseComments(''), { comments: [], total: 0, reportedTotal: 0, pages: [], statusOk: true })
  eq('parseComments：只有无关行不抛', parseComments('hello world\n合计 3 条').comments, [])

  // ---- parseVideoDetail：detail 接口 JSON ----
  const detailJson = {
    aweme_detail: {
      aweme_id: AWEME_A,
      desc: '  测试视频  ',
      author: { nickname: '小王', sec_uid: 'MS4wSEC' },
      statistics: { digg_count: 1234, comment_count: 56, share_count: 7, collect_count: 890 },
      video: { duration: 15000, cover: { url_list: ['https://p3.douyinpic.com/a.jpg'] } },
    },
  }
  const video = parseVideoDetail(detailJson)
  eq('parseVideoDetail：aweme_id / desc', [video.aweme_id, video.desc], [AWEME_A, '测试视频'])
  eq('parseVideoDetail：作者昵称 / sec_uid', [video.author, video.author_sec_uid], ['小王', 'MS4wSEC'])
  eq('parseVideoDetail：统计四项', [video.digg, video.comment_count, video.share_count, video.collect_count], [1234, 56, 7, 890])
  eq('parseVideoDetail：时长 / 封面第一张', [video.duration_ms, video.cover], [15000, 'https://p3.douyinpic.com/a.jpg'])
  eq('parseVideoDetail：canonical', video.canonical, CANONICAL_A)
  eq('parseVideoDetail：空 / 坏输入 → null',
    [parseVideoDetail(null), parseVideoDetail({}), parseVideoDetail({ aweme_detail: 'x' }), parseVideoDetail()],
    [null, null, null, null])

  // ---- formatCount ----
  eq('formatCount：999 / 1.2k / 3.4w / 1.2亿',
    [formatCount(999), formatCount(1200), formatCount(34000), formatCount(120000000)],
    ['999', '1.2k', '3.4w', '1.2亿'])
  eq('formatCount：0 与非数字 → 0', [formatCount(0), formatCount('x')], ['0', '0'])

  // ---- formatVideoDigest：三种组合 ----
  const digest = formatVideoDigest(video, parsed)
  truthy('formatVideoDigest：有详情有评论 → 含链接', digest.includes(CANONICAL_A))
  truthy('formatVideoDigest：有详情有评论 → 含作者', digest.includes('@小王'))
  truthy('formatVideoDigest：有详情有评论 → 含热评昵称', digest.includes('昵称'))
  truthy('formatVideoDigest：有详情有评论 → 含楼中楼', digest.includes('回复者'))
  const onlyComments = formatVideoDigest(null, parsed)
  truthy('formatVideoDigest：无详情有评论 → 提示没取到详情', onlyComments.includes('没取到视频详情'))
  truthy('formatVideoDigest：无详情有评论 → 仍带热评', onlyComments.includes('昵称'))
  const onlyVideo = formatVideoDigest(video, null)
  truthy('formatVideoDigest：有详情无评论 → 提示没拿到评论', onlyVideo.includes('这次没拿到评论'))
  truthy('formatVideoDigest：有详情无评论 → 仍有链接', onlyVideo.includes(CANONICAL_A))
  eq('formatVideoDigest：空详情空评论也不抛', typeof formatVideoDigest(null, null), 'string')

  // ---- pickJson：脚本先打日志再打 JSON ----
  eq('pickJson：前后有日志也能取出对象', pickJson('日志: starting\n{"ok":true,"sent":true}\ndone'), { ok: true, sent: true })
  eq('pickJson：嵌套对象', pickJson('log\n{"a":{"b":1}}\ntail'), { a: { b: 1 } })
  eq('pickJson：坏 JSON → null', pickJson('{ 坏 json '), null)
  eq('pickJson：没有 JSON → null', [pickJson(''), pickJson('no braces')], [null, null])

  // ---- parseFeed / formatFeedDigest / formatFeedForQQ：推荐流（feed）纯函数 ----
  // 数据形状对齐「刷抖音」插件 tools/forward-pick.py 写出的 forward-pick.json 的 rows。
  const feedJson = {
    rows: [
      {
        aweme_id: `  ${AWEME_A}  `,
        desc: '  第一条\n视频\t测试  ',
        author: ' 小王 ',
        digg: 1234,
        comment: 56,
        collect: 7,
        share: 8,
        duration_s: 15.6,
        score: 88,
        web_url: '  https://www.douyin.com/video/7300000000000000001?from=feed  ',
        share_url: ' https://v.douyin.com/abc/ ',
      },
      {
        aweme_id: AWEME_B,
        desc: '第二条视频',
        author: '小李',
        digg: '34000',
        comment: '12',
        collect: 0,
        share: 0,
        duration_s: 30,
      },
      { desc: '没有 aweme_id 的坏行' },
      null,
      'not-an-object',
    ],
  }
  const feedRows = parseFeed(feedJson)
  eq('parseFeed：坏行（缺 aweme_id / 非对象）被丢弃', feedRows.length, 2)
  eq('parseFeed：aweme_id / author 转字符串并 trim', [feedRows[0].aweme_id, feedRows[0].author], [AWEME_A, '小王'])
  eq('parseFeed：desc 连续空白压成一个空格', feedRows[0].desc, '第一条 视频 测试')
  eq('parseFeed：数值字段都是 number',
    [feedRows[0].digg, feedRows[0].comment, feedRows[0].collect, feedRows[0].share, feedRows[0].duration_s, feedRows[0].score]
      .map((value) => typeof value),
    ['number', 'number', 'number', 'number', 'number', 'number'])
  eq('parseFeed：数值原样保留', [feedRows[0].digg, feedRows[0].comment, feedRows[0].collect, feedRows[0].share, feedRows[0].duration_s],
    [1234, 56, 7, 8, 15.6])
  eq('parseFeed：字符串数字也转 number', [feedRows[1].digg, feedRows[1].comment], [34000, 12])
  eq('parseFeed：显式 web_url 保留并 trim', feedRows[0].web_url, 'https://www.douyin.com/video/7300000000000000001?from=feed')
  eq('parseFeed：web_url 缺失时用 canonical 补', feedRows[1].web_url, `https://www.douyin.com/video/${AWEME_B}`)
  eq('parseFeed：share_url 保留并 trim', feedRows[0].share_url, 'https://v.douyin.com/abc/')
  eq('parseFeed：desc 最长 300 字', parseFeed({ rows: [{ aweme_id: '7300000000000000003', desc: 'x'.repeat(400) }] })[0].desc.length, 300)
  eq('parseFeed：非对象 / 空输入 → []',
    [parseFeed(null), parseFeed(undefined), parseFeed({}), parseFeed([]), parseFeed('x'), parseFeed({ rows: 'x' })],
    [[], [], [], [], [], []])

  const digestRows = [
    { ...feedRows[0], top_comments: [{ nick: '路人甲', text: '太好笑了吧' }, { nick: '路人乙', text: '哈哈哈哈' }] },
    feedRows[1],
  ]
  const feedDigest = formatFeedDigest(digestRows)
  truthy('formatFeedDigest：标题含「【抖音推荐】」', feedDigest.includes('【抖音推荐】'))
  truthy('formatFeedDigest：每条都有序号', feedDigest.includes('1. 第一条 视频 测试') && feedDigest.includes('2. 第二条视频'))
  truthy('formatFeedDigest：含 @作者', feedDigest.includes('@小王') && feedDigest.includes('@小李'))
  truthy('formatFeedDigest：含赞 / 评 / 藏与数值', feedDigest.includes('赞1.2k 评56 藏7') && feedDigest.includes('赞3.4w 评12 藏0'))
  truthy('formatFeedDigest：带时长', feedDigest.includes('16s') && feedDigest.includes('30s'))
  truthy('formatFeedDigest：每条都带链接', feedDigest.includes(feedRows[0].web_url) && feedDigest.includes(feedRows[1].web_url))
  truthy('formatFeedDigest：带 top_comments 时出现「热评：」', feedDigest.includes('热评：') && feedDigest.includes('路人甲'))
  eq('formatFeedDigest：空数组安全（兜底文案）', formatFeedDigest([]), '【抖音推荐】（这次没拉到视频）')
  eq('formatFeedDigest：null 也不抛', typeof formatFeedDigest(null), 'string')
  truthy('formatFeedDigest：limit 只输出前 N 条',
    formatFeedDigest(digestRows, { limit: 1 }).includes(feedRows[0].web_url)
      && !formatFeedDigest(digestRows, { limit: 1 }).includes(feedRows[1].web_url))

  const cardRow = { ...feedRows[0], top_comments: [{ nick: '路人甲', text: '太好笑了吧' }] }
  const feedCard = formatFeedForQQ(cardRow, { comments: [{ nick: '评论者', text: '这是热评' }] })
  const feedCardLines = feedCard.split('\n')
  eq('formatFeedForQQ：返回一条字符串消息', typeof feedCard, 'string')
  eq('formatFeedForQQ：一条消息 4 行（标题 / 作者 / 链接 / 热评）', feedCardLines.length, 4)
  truthy('formatFeedForQQ：第一行以「【抖音·推荐】」开头', feedCardLines[0].startsWith('【抖音·推荐】'))
  eq('formatFeedForQQ：第一行是压缩空白后的文案', feedCardLines[0], '【抖音·推荐】第一条 视频 测试')
  eq('formatFeedForQQ：第二行 @作者 + 赞 / 评 / 藏', feedCardLines[1], '@小王 · 赞1.2k 评56 藏7')
  eq('formatFeedForQQ：第三行是 web_url', feedCardLines[2], cardRow.web_url)
  truthy('formatFeedForQQ：comments 选项追加「热评：」行', feedCardLines[3].startsWith('热评：') && feedCardLines[3].includes('评论者：这是热评'))
  eq('formatFeedForQQ：换行之外没有怪字符（\\r / 控制字符）', /[\u0000-\u0009\u000b-\u001f\u007f]/.test(feedCard), false)
  truthy('formatFeedForQQ：没传 comments 时回落到 row.top_comments', formatFeedForQQ(cardRow).includes('路人甲'))
  eq('formatFeedForQQ：comments 为空数组不添热评行', formatFeedForQQ(feedRows[1], { comments: [] }).split('\n').length, 3)
  eq('formatFeedForQQ：desc 为空有兜底文案',
    formatFeedForQQ({ ...feedRows[1], desc: '' }).split('\n')[0], '【抖音·推荐】（无文案）')

  // ---- discoverDouyinTools：临时 DSH_HOME + 假的 profile / .venv / 插件目录 ----
  if (process.platform !== 'win32') {
    skip('discoverDouyinTools（临时 DSH_HOME + link: 依赖）', '该用例按 Windows 路径分隔符造 link: 路径，非 Windows 跳过')
    return
  }
  const discoverRoot = mkdtempSync(join(tmpdir(), 'qqdy-discover-'))
  try {
    const pluginDir = join(discoverRoot, 'fake-plugin')
    mkdirSync(join(pluginDir, 'tools'), { recursive: true })
    writeFileSync(join(pluginDir, 'tools', 'api-comments.py'), '# fake\n', 'utf8')
    const home = join(discoverRoot, 'dsh-home')
    const profileDir = join(home, 'profiles', 'test')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      dependencies: { 'dsh-douyin-scroll': `link:${pluginDir.replace(/\\/g, '/')}` },
    }), 'utf8')
    const pyDir = join(home, 'douyin-duty', '.venv', 'Scripts')
    mkdirSync(pyDir, { recursive: true })
    writeFileSync(join(pyDir, 'python.exe'), 'fake', 'utf8')

    const found = discoverDouyinTools({ DSH_HOME: home })
    eq('discoverDouyinTools：按 profile package.json 的 link: 依赖找到插件', found.ok, true)
    eq('discoverDouyinTools：dir 指向插件目录', resolve(found.dir), resolve(pluginDir))
    eq('discoverDouyinTools：python 指向假 .venv', found.python, join(pyDir, 'python.exe'))
    eq('discoverDouyinTools：stateHome 在 douyin-duty', found.stateHome, join(home, 'douyin-duty'))
    eq('discoverDouyinTools：source 标注来源', found.source, 'profiles/*/package.json')

    const missing = discoverDouyinTools({ DSH_HOME: join(discoverRoot, 'no-such-home') })
    eq('discoverDouyinTools：没有插件 → ok=false', missing.ok, false)
    truthy('discoverDouyinTools：没有插件时提示先安装', /找不到/.test(String(missing.error)))

    const home2 = join(discoverRoot, 'dsh-home2')
    const profile2 = join(home2, 'profiles', 'test')
    mkdirSync(profile2, { recursive: true })
    writeFileSync(join(profile2, 'package.json'), JSON.stringify({
      dependencies: { 'dsh-douyin-scroll': `link:${pluginDir.replace(/\\/g, '/')}` },
    }), 'utf8')
    const noPython = discoverDouyinTools({ DSH_HOME: home2 })
    eq('discoverDouyinTools：缺 .venv → ok=false', noPython.ok, false)
    truthy('discoverDouyinTools：缺 .venv 提示装依赖', /Python 环境|装主依赖/.test(String(noPython.error)))
  } finally {
    rmSync(discoverRoot, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 8. OneBot 响应规整（含假 fetch，不联网）
// ---------------------------------------------------------------------------

async function onebotTests() {
  eq('normalizeOneBotResponse：status=ok + retcode=0', normalizeOneBotResponse({
    status: 'ok', retcode: 0, data: { user_id: 123 },
  }), { ok: true, data: { user_id: 123 } })
  eq('normalizeOneBotResponse：status=ok 且没有 retcode', normalizeOneBotResponse({ status: 'ok', data: null }), { ok: true, data: null })
  eq('normalizeOneBotResponse：retcode 是字符串 "0" 也认', normalizeOneBotResponse({ status: 'ok', retcode: '0', data: { a: 1 } }), { ok: true, data: { a: 1 } })
  eq('normalizeOneBotResponse：failed + retcode（取 wording）', normalizeOneBotResponse({
    status: 'failed', retcode: 100, wording: 'token 不对',
  }), { ok: false, error: 'token 不对', retcode: 100 })
  eq('normalizeOneBotResponse：failed（取 message）', normalizeOneBotResponse({
    status: 'failed', retcode: 1403, message: '权限不足',
  }), { ok: false, error: '权限不足', retcode: 1403 })
  eq('normalizeOneBotResponse：failed 没有可读文案时拼 status/retcode', normalizeOneBotResponse({
    status: 'failed', retcode: 1500,
  }), { ok: false, error: 'OneBot 返回 status=failed retcode=1500', retcode: 1500 })
  eq('normalizeOneBotResponse：status=ok 但 retcode 非 0 算失败', normalizeOneBotResponse({
    status: 'ok', retcode: 100,
  }), { ok: false, error: 'OneBot 返回 status=ok retcode=100', retcode: 100 })
  eq('normalizeOneBotResponse：retcode=0 但缺 status 算失败', normalizeOneBotResponse({
    retcode: 0, data: {},
  }), { ok: false, error: 'OneBot 返回 status=undefined retcode=0', retcode: 0 })
  const nonObject = normalizeOneBotResponse(null)
  eq('normalizeOneBotResponse：非对象 → ok=false', nonObject.ok, false)
  truthy('normalizeOneBotResponse：非对象 → 提示 QQ 侧可能没启动', /不是 JSON 对象/.test(nonObject.error))
  eq('normalizeOneBotResponse：字符串也不抛', normalizeOneBotResponse('ok').ok, false)

  // ---- createOneBot：注入假 fetch，断言请求构造与错误分支 ----
  const okFetch = makeFetch(() => jsonResponse({ status: 'ok', retcode: 0, data: { user_id: 123, nickname: '大肥鱼', message_id: 9001 } }))
  const bot = createOneBot({ baseUrl: 'http://127.0.0.1:3000///', token: 'tok-abc', fetchImpl: okFetch })
  eq('createOneBot：baseUrl 去掉尾部斜杠', bot.baseUrl, 'http://127.0.0.1:3000')
  eq('createOneBot：默认 baseUrl', createOneBot({}).baseUrl, 'http://127.0.0.1:3000')
  const login = await bot.loginInfo()
  eq('createOneBot：loginInfo 返回 ok/data', [login.ok, login.data.user_id], [true, 123])
  eq('createOneBot：请求 URL 是 path-style /get_login_info', okFetch.calls[0].url, 'http://127.0.0.1:3000/get_login_info')
  eq('createOneBot：POST + JSON', [okFetch.calls[0].init.method, okFetch.calls[0].init.headers['content-type']], ['POST', 'application/json'])
  eq('createOneBot：带 Bearer token', okFetch.calls[0].init.headers.authorization, 'Bearer tok-abc')

  const historyFetch = makeFetch(() => jsonResponse({ status: 'ok', retcode: 0, data: { messages: [] } }))
  const historyBot = createOneBot({ baseUrl: 'http://127.0.0.1:3000', fetchImpl: historyFetch })
  await historyBot.friendHistory('<OWNER_QQ>', 999)
  const friendBody = JSON.parse(historyFetch.calls[0].init.body)
  eq('friendHistory：user_id 转数字 / count 夹到 50', [friendBody.user_id, friendBody.count], [<OWNER_QQ>, 50])
  eq('friendHistory：action 路径', historyFetch.calls[0].url.endsWith('/get_friend_msg_history'), true)
  await historyBot.groupHistory('123456789', 0)
  const groupBody = JSON.parse(historyFetch.calls[1].init.body)
  eq('groupHistory：count=0 回默认 20', groupBody.count, 20)
  await historyBot.sendPrivate('abc', '你好')
  eq('sendPrivate：非法 user_id 给 0（不瞎发）', JSON.parse(historyFetch.calls[2].init.body).user_id, 0)
  eq('sendPrivate：文本用消息段数组', JSON.parse(historyFetch.calls[2].init.body).message, [{ type: 'text', data: { text: '你好' } }])

  const getMsgFetch = makeFetch(() => jsonResponse({ status: 'ok', retcode: 0, data: { message_id: 55 } }))
  const getMsgBot = createOneBot({ baseUrl: 'http://127.0.0.1:3000', fetchImpl: getMsgFetch })
  eq('getMsg：非法 message_id 直接失败（不发请求）', (await getMsgBot.getMsg('abc')).ok, false)
  eq('getMsg：非法 message_id 时没有发请求', getMsgFetch.calls.length, 0)
  await getMsgBot.getMsg('55')
  eq('getMsg：合法 id 转数字', JSON.parse(getMsgFetch.calls[0].init.body).message_id, 55)

  const badJsonBot = createOneBot({
    baseUrl: 'http://127.0.0.1:3000',
    fetchImpl: makeFetch(() => jsonResponse('<html>502</html>')),
  })
  const badJson = await badJsonBot.loginInfo()
  eq('createOneBot：非 JSON 响应 → ok=false', badJson.ok, false)
  truthy('createOneBot：非 JSON 提示带 HTTP 状态', /不是 JSON/.test(badJson.error))

  const httpErrorBot = createOneBot({
    baseUrl: 'http://127.0.0.1:3000',
    fetchImpl: makeFetch(() => jsonResponse({ status: 'failed', retcode: 100, wording: 'boom' }, { ok: false, status: 500 })),
  })
  const httpError = await httpErrorBot.loginInfo()
  truthy('createOneBot：HTTP 错误码进错误文案', /HTTP 500/.test(httpError.error))

  const timeoutBot = createOneBot({
    baseUrl: 'http://127.0.0.1:3000',
    fetchImpl: makeFetch(() => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }) }),
  })
  const timeout = await timeoutBot.loginInfo()
  truthy('createOneBot：超时给「QQ 侧超时」', /超时/.test(timeout.error))

  const refuseBot = createOneBot({
    baseUrl: 'http://127.0.0.1:3000',
    fetchImpl: makeFetch(() => { throw new TypeError('fetch failed') }),
  })
  const refused = await refuseBot.loginInfo()
  truthy('createOneBot：连不上给「连不上 QQ 侧」', /连不上 QQ 侧/.test(refused.error))
}

// ---------------------------------------------------------------------------
// 9. 抖音客户端（假 fetch）
// ---------------------------------------------------------------------------

async function douyinClientTests() {
  const emptyBase = createDouyin({ baseUrl: '' })
  const emptyResult = await emptyBase.status()
  eq('createDouyin：baseUrl 为空 → ok=false', emptyResult.ok, false)
  truthy('createDouyin：baseUrl 为空 → 提示地址为空', /地址为空/.test(emptyResult.error))

  const allowlist = createDouyin({ baseUrl: 'http://127.0.0.1:54487/api/douyin-duty', fetchImpl: makeFetch(() => jsonResponse({ ok: true })) })
  const blocked = await allowlist.request('GET', '/etc/passwd')
  eq('createDouyin：未支持路径被拒', blocked.ok, false)
  truthy('createDouyin：拒绝文案', /未支持的抖音接口/.test(blocked.error))

  const statusFetch = makeFetch(() => jsonResponse({ ok: true, loggedIn: true, account: { nick: '阿抖', uid: 'u1' } }))
  const statusClient = createDouyin({ baseUrl: 'http://127.0.0.1:54487/api/douyin-duty/', fetchImpl: statusFetch })
  eq('createDouyin：baseUrl 去尾斜杠', statusClient.baseUrl, 'http://127.0.0.1:54487/api/douyin-duty')
  const statusResult = await statusClient.status()
  eq('createDouyin：ok=true 透传 data', [statusResult.ok, statusResult.data.loggedIn], [true, true])
  eq('createDouyin：status 是 GET', [statusFetch.calls[0].init.method, statusFetch.calls[0].url.endsWith('/status')], ['GET', true])

  const loginNeeded = createDouyin({
    baseUrl: 'http://127.0.0.1:54487/api/douyin-duty',
    fetchImpl: makeFetch(() => jsonResponse({ ok: false, error: '抖音还没登录' })),
  })
  const needLogin = await loginNeeded.status()
  eq('createDouyin：业务失败 → ok=false', needLogin.ok, false)
  eq('createDouyin：登录类错误 → needLogin=true', needLogin.needLogin, true)

  const genericFail = createDouyin({
    baseUrl: 'http://127.0.0.1:54487/api/douyin-duty',
    fetchImpl: makeFetch(() => jsonResponse({ ok: false, detail: 'boom' })),
  })
  eq('createDouyin：业务失败取 detail', (await genericFail.status()).error, 'boom')

  const httpFail = createDouyin({
    baseUrl: 'http://127.0.0.1:54487/api/douyin-duty',
    fetchImpl: makeFetch(() => jsonResponse({ ok: true }, { ok: false, status: 503 })),
  })
  truthy('createDouyin：HTTP 非 2xx 报 HTTP 码', /HTTP 503/.test((await httpFail.status()).error))

  const badJson = createDouyin({
    baseUrl: 'http://127.0.0.1:54487/api/douyin-duty',
    fetchImpl: makeFetch(() => jsonResponse('not json')),
  })
  truthy('createDouyin：非 JSON 响应给提示', /不是 JSON/.test((await badJson.status()).error))

  const readFetch = makeFetch(() => jsonResponse({ ok: true, to: '小王', messages: [{ from: 'them', text: 'hi' }] }))
  const readClient = createDouyin({ baseUrl: 'http://127.0.0.1:54487/api/douyin-duty', fetchImpl: readFetch })
  const readResult = await readClient.read('MS4wSEC', '小王')
  eq('createDouyin：read 返回 ok', readResult.ok, true)
  eq('createDouyin：read 用 POST 且 body 有 to_id/to', [readFetch.calls[0].init.method, JSON.parse(readFetch.calls[0].init.body)], ['POST', { to_id: 'MS4wSEC', to: '小王' }])

  const sendFailFetch = makeFetch(() => jsonResponse({ ok: true, sent: false, error: '没发出去' }))
  const sendFailClient = createDouyin({ baseUrl: 'http://127.0.0.1:54487/api/douyin-duty', fetchImpl: sendFailFetch })
  const sendFail = await sendFailClient.send('MS4wSEC', '小王', '你好')
  eq('createDouyin：sent != true 算失败', [sendFail.ok, sendFail.error], [false, '没发出去'])
  eq('createDouyin：send 正文带 confirm:true', JSON.parse(sendFailFetch.calls[0].init.body).confirm, true)

  const sendOkClient = createDouyin({
    baseUrl: 'http://127.0.0.1:54487/api/douyin-duty',
    fetchImpl: makeFetch(() => jsonResponse({ ok: true, sent: true })),
  })
  eq('createDouyin：sent === true 才算发出', (await sendOkClient.send('MS4wSEC', '小王', '你好')).ok, true)

  const timeoutClient = createDouyin({
    baseUrl: 'http://127.0.0.1:54487/api/douyin-duty',
    timeoutMs: 2000,
    fetchImpl: makeFetch(() => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }) }),
  })
  truthy('createDouyin：超时文案', /超时/.test((await timeoutClient.status()).error))

  const refuseClient = createDouyin({
    baseUrl: 'http://127.0.0.1:54487/api/douyin-duty',
    fetchImpl: makeFetch(() => { throw new TypeError('fetch failed') }),
  })
  truthy('createDouyin：连不上文案', /连不上抖音插件/.test((await refuseClient.status()).error))
}

// ---------------------------------------------------------------------------
// 10. 路径与自动发现（临时 DSH_HOME）
// ---------------------------------------------------------------------------

function pathAndDiscoverTests() {
  const fakeHome = join(TMP, 'dsh-home')
  process.env.DSH_HOME = fakeHome
  try {
    eq('paths：dshHome 尊重 DSH_HOME', dshHome(), fakeHome)
    eq('paths：bridgeHome', bridgeHome(), join(fakeHome, 'qq-douyin-bridge'))
    eq('paths：stateFile', stateFile(), join(fakeHome, 'qq-douyin-bridge', 'state.json'))
    eq('paths：qqBridgeDir', qqBridgeDir(), join(fakeHome, 'qq-bridge'))
    eq('paths：douyinHome', douyinHome(), join(fakeHome, 'douyin-duty'))
    process.env.DSH_HOME = ''
    eq('paths：DSH_HOME 空串回退 ~/.dsh', dshHome(), join(homedir(), '.dsh'))
    delete process.env.DSH_HOME
    eq('paths：没有 DSH_HOME 回退 ~/.dsh', dshHome(), join(homedir(), '.dsh'))
    process.env.DSH_HOME = fakeHome

    // ---- 缺文件时的安全默认值 ----
    const missing = readQqBridgeConfig()
    eq('discover：缺配置 exists=false', missing.exists, false)
    eq('discover：缺配置给默认 httpUrl', missing.httpUrl, 'http://127.0.0.1:3000')
    eq('discover：缺配置给默认 wsUrl', missing.wsUrl, 'ws://127.0.0.1:3001')
    eq('discover：缺配置 accessToken 为空串', missing.accessToken, '')
    eq('discover：缺配置 consolePort=3100', missing.consolePort, 3100)
    eq('discover：缺配置 allow 为空数组', [missing.allow.private, missing.allow.groups], [[], []])
    eq('discover：缺配置 sessions 为空对象', missing.sessions, {})

    // ---- 有配置时 ----
    const bridgeDir = join(fakeHome, 'qq-bridge')
    mkdirSync(join(bridgeDir, 'state'), { recursive: true })
    writeFileSync(join(bridgeDir, 'config.json'), JSON.stringify({
      snowluma: { httpUrl: 'http://127.0.0.1:3999/', wsUrl: 'ws://127.0.0.1:3998/', accessToken: 'tok-123' },
      consolePort: 3200,
      allow: { private: ['<OWNER_QQ>'], groups: [123456789] },
    }), 'utf8')
    writeFileSync(join(bridgeDir, 'state', 'console-token'), '  ctok\n', 'utf8')
    writeFileSync(join(bridgeDir, 'state', 'sessions.json'), JSON.stringify({
      sessions: { 'private:<OWNER_QQ>': 'sess-1', 'group:123456789': 'sess-2' },
    }), 'utf8')

    const cfg = readQqBridgeConfig()
    eq('discover：读到 exists=true', cfg.exists, true)
    eq('discover：httpUrl 去尾斜杠', cfg.httpUrl, 'http://127.0.0.1:3999')
    eq('discover：wsUrl 去尾斜杠', cfg.wsUrl, 'ws://127.0.0.1:3998')
    eq('discover：读到 accessToken（只给宿主用）', cfg.accessToken, 'tok-123')
    eq('discover：consolePort', cfg.consolePort, 3200)
    eq('discover：consoleToken 从 state/console-token 兜底', cfg.consoleToken, 'ctok')
    eq('discover：allow 转字符串数组', [cfg.allow.private, cfg.allow.groups], [['<OWNER_QQ>'], ['123456789']])
    eq('discover：sessions 读到', cfg.sessions, { 'private:<OWNER_QQ>': 'sess-1', 'group:123456789': 'sess-2' })

    eq('discover：aiOverlap 私聊命中 allow.private', aiOverlapOf('private', '<OWNER_QQ>'), true)
    eq('discover：aiOverlap 私聊不在白名单', aiOverlapOf('private', '999'), false)
    eq('discover：aiOverlap 群命中 sessions', aiOverlapOf('group', '123456789'), true)
    eq('discover：aiOverlap 群不在任何名单', aiOverlapOf('group', '999'), false)

    // ---- 抖音本机记忆兜底 ----
    const memoryDir = join(fakeHome, 'douyin-duty', 'memory')
    mkdirSync(memoryDir, { recursive: true })
    writeFileSync(join(memoryDir, 'dm-aaa.json'), JSON.stringify({ who: { sec_uid: 'MS4wSEC', nick: '小王' } }), 'utf8')
    writeFileSync(join(memoryDir, 'dm-bbb.json'), JSON.stringify({ who: { nick: '没有 sec_uid' } }), 'utf8')
    writeFileSync(join(memoryDir, 'dm-ccc.json'), JSON.stringify({ who: { sec_uid: '  MS4wB  ' } }), 'utf8')
    writeFileSync(join(memoryDir, 'dm-bad.json'), '{ 坏 JSON', 'utf8')
    writeFileSync(join(memoryDir, 'notes.txt'), '不是 dm-*.json', 'utf8')
    const peers = listDouyinMemoryPeers().sort((a, b) => a.sec_uid.localeCompare(b.sec_uid))
    eq('discover：listDouyinMemoryPeers 过滤无效文件', peers.length, 2)
    eq('discover：记忆里的 peer 结构', peers[0], { nick: 'MS4wB', sec_uid: 'MS4wB', has_id: true, is_group: false, duplicate: false })
    eq('discover：记忆里的昵称', peers[1], { nick: '小王', sec_uid: 'MS4wSEC', has_id: true, is_group: false, duplicate: false })

    // 损坏的 qq-bridge 配置不能让插件崩
    writeFileSync(join(bridgeDir, 'config.json'), '{ 坏配置', 'utf8')
    const broken = readQqBridgeConfig()
    eq('discover：配置损坏也绝不抛（回默认）', [broken.exists, broken.httpUrl, broken.accessToken], [false, 'http://127.0.0.1:3000', ''])
  } finally {
    if (ORIGINAL_DSH_HOME === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = ORIGINAL_DSH_HOME
  }

  eq('发现层：临时 DSH_HOME 已还原', process.env.DSH_HOME, ORIGINAL_DSH_HOME)
}

// ---------------------------------------------------------------------------
// 11. v0.3 共享记忆纯函数（lib/share.mjs）
// ---------------------------------------------------------------------------

function shareTests() {
  // ---- pickQqMemories：只挑 QQ 桥接会话的记忆 ----
  const qqChoice = [
    { source: 'qq', createdAt: 1000, assistantText: 'QQ 鱼记得：他周末去爬山', excerpt: '【当前时间】2026/11/14 22:42:58 系统提示' },
    { tags: ['记忆', 'qq'], createdAt: 3000, excerpt: '  只看摘要也够用  ', text: '这段不该被用到' },
    { sessionTitle: 'QQ 桥接会话', createdAt: 2000, assistantText: '   ', excerpt: '【当前时间】2026/11/14 一大段系统提示', text: '  正文兜底  ' },
  ]
  const picked = pickQqMemories({
    memories: [
      ...qqChoice,
      { source: 'qq', createdAt: 4000, forgottenAt: '2026-11-01T00:00:00Z', assistantText: '已经遗忘了' },
      { source: 'memory-brain', sessionTitle: '普通任务', createdAt: 5000, assistantText: '不是 QQ 的' },
      { source: 'qq', createdAt: 6000, assistantText: '【当前时间】2026/11/14', excerpt: '【当前角色】傲娇助手', text: '【你的身份】大肥鱼' },
      null,
      'not-an-object',
    ],
  })
  eq('pickQqMemories：默认 limit=3', picked.length, 3)
  eq('pickQqMemories：按 createdAt 倒序，且优先 assistantText → excerpt → text', picked, [
    { at: '3000', text: '只看摘要也够用' },
    { at: '2000', text: '正文兜底' },
    { at: '1000', text: 'QQ 鱼记得：他周末去爬山' },
  ])
  eq('pickQqMemories：输出只有 at / text 两个字段', Object.keys(picked[0]).sort(), ['at', 'text'])
  eq('pickQqMemories：跳过 forgottenAt', picked.some((item) => item.text === '已经遗忘了'), false)
  eq('pickQqMemories：非 QQ 会话不挑', picked.some((item) => item.text === '不是 QQ 的'), false)
  eq('pickQqMemories：全是系统提示的条目被丢弃', picked.some((item) => item.text.startsWith('【当前时间】')), false)

  // 单条判据：source / tags / sessionTitle 三种都算 QQ
  eq('pickQqMemories：source=qq', pickQqMemories({ memories: [qqChoice[0]] }),
    [{ at: '1000', text: 'QQ 鱼记得：他周末去爬山' }])
  eq('pickQqMemories：source 大小写不敏感',
    pickQqMemories({ memories: [{ source: 'QQ', createdAt: 7, assistantText: '大写来源也算' }] }),
    [{ at: '7', text: '大写来源也算' }])
  eq('pickQqMemories：tags 含 qq（大小写不敏感）', pickQqMemories({ memories: [qqChoice[1]] }),
    [{ at: '3000', text: '只看摘要也够用' }])
  eq('pickQqMemories：sessionTitle 含 QQ', pickQqMemories({ memories: [qqChoice[2]] }),
    [{ at: '2000', text: '正文兜底' }])
  eq('pickQqMemories：sessionTitle 小写 qq 也算',
    pickQqMemories({ memories: [{ sessionTitle: 'qq 私聊', createdAt: 9, assistantText: '标题小写也算' }] }),
    [{ at: '9', text: '标题小写也算' }])
  eq('pickQqMemories：assistantText 是系统提示时退回 excerpt', pickQqMemories({ memories: [
    { source: 'qq', createdAt: 11, assistantText: '【当前时间】x', excerpt: '摘要兜底', text: '正文' },
  ] }), [{ at: '11', text: '摘要兜底' }])
  eq('pickQqMemories：三种文本全是系统提示 → 丢弃', pickQqMemories({ memories: [
    { source: 'qq', createdAt: 10, assistantText: '【当前时间】x', excerpt: '【当前角色】y', text: '【你的身份】z' },
  ] }), [])
  // 真实 memory-brain.json 形状：active 记忆的 forgottenAt 是 0；语义记忆 source 为空、只有 tags 带 qq
  eq('pickQqMemories：forgottenAt=0 不算遗忘',
    pickQqMemories({ memories: [{ source: 'qq', createdAt: 14, forgottenAt: 0, assistantText: '还在的记忆' }] }),
    [{ at: '14', text: '还在的记忆' }])
  eq('pickQqMemories：语义记忆（source 空 / tags qq / 正文是系统提示）被丢弃', pickQqMemories({ memories: [
    { id: 'sem-x', kind: 'semantic', source: '', tags: ['记忆', 'qq'], text: '【当前时间】2026/11/7 22:42:58（Asia/Shanghai）【当前角色】傲娇助手', assistantText: '', excerpt: '', forgottenAt: 0 },
  ] }), [])
  eq('pickQqMemories：文本压空白 / 截到 160 字', pickQqMemories({ memories: [
    { source: 'qq', createdAt: 12, assistantText: '  a\n\t b   c  ' },
    { source: 'qq', createdAt: 13, assistantText: 'x'.repeat(200) },
  ] }, { limit: 2 }), [{ at: '13', text: 'x'.repeat(160) }, { at: '12', text: 'a b c' }])
  eq('pickQqMemories：没有 createdAt 时 at 为空串',
    pickQqMemories({ memories: [{ source: 'qq', assistantText: 'hi' }] }), [{ at: '', text: 'hi' }])
  eq('pickQqMemories：limit=0 回默认 3', pickQqMemories({ memories: qqChoice }, { limit: 0 }).length, 3)

  const eightQq = { memories: Array.from({ length: 8 }, (_, i) => ({ source: 'qq', createdAt: i * 100, assistantText: `c${i}` })) }
  eq('pickQqMemories：limit 上限 6', pickQqMemories(eightQq, { limit: 99 }).length, 6)
  eq('pickQqMemories：limit=99 时保留最新 6 条', pickQqMemories(eightQq, { limit: 99 }).map((item) => item.text),
    ['c7', 'c6', 'c5', 'c4', 'c3', 'c2'])
  eq('pickQqMemories：limit 指定条数', pickQqMemories(eightQq, { limit: 2 }).map((item) => item.text), ['c7', 'c6'])
  eq('pickQqMemories：limit 字符串数字可用', pickQqMemories(eightQq, { limit: '2' }).length, 2)
  eq('pickQqMemories：空 / 坏输入 → []', [
    pickQqMemories(null),
    pickQqMemories(undefined),
    pickQqMemories({}),
    pickQqMemories({ memories: 'x' }),
    pickQqMemories('x'),
    pickQqMemories([]),
  ], [[], [], [], [], [], []])

  // ---- pickDmFacts ----
  eq('pickDmFacts：nick 去空格 / facts 去空去空白', pickDmFacts({
    who: { nick: ' 小王 ' },
    facts: [' 在杭州 ', '', '养了只橘猫', '   '],
  }), { nick: '小王', facts: ['在杭州', '养了只橘猫'] })
  eq('pickDmFacts：facts 压空白', pickDmFacts({ who: {}, facts: ['养了  只猫'] }).facts, ['养了 只猫'])
  eq('pickDmFacts：非字符串 fact 转字符串', pickDmFacts({ who: {}, facts: [1, ' 2 '] }).facts, ['1', '2'])
  eq('pickDmFacts：limit 默认 5', pickDmFacts({ who: {}, facts: Array.from({ length: 8 }, (_, i) => `f${i}`) }).facts.length, 5)
  eq('pickDmFacts：limit 上限 10',
    pickDmFacts({ who: {}, facts: Array.from({ length: 12 }, (_, i) => `f${i}`) }, { limit: 99 }).facts.length, 10)
  eq('pickDmFacts：limit 指定条数', pickDmFacts({ who: {}, facts: ['a', 'b', 'c'] }, { limit: 2 }).facts, ['a', 'b'])
  eq('pickDmFacts：坏输入 → { nick:"", facts:[] }', [
    pickDmFacts(null),
    pickDmFacts(undefined),
    pickDmFacts('x'),
    pickDmFacts({}),
    pickDmFacts({ who: 'x', facts: 'x' }),
  ], [{ nick: '', facts: [] }, { nick: '', facts: [] }, { nick: '', facts: [] }, { nick: '', facts: [] }, { nick: '', facts: [] }])

  // ---- formatSharedContext ----
  const sharedBase = { qqMemories: [{ at: '', text: '记得那件事' }], dmNick: '小王', dmFacts: ['在杭州', '养了只橘猫'] }
  eq('formatSharedContext：私聊默认输出 QQ 记忆行 + facts 行', formatSharedContext(sharedBase), [
    'QQ 这边的鱼最近记得（QQ 桥接会话）：',
    '- 记得那件事',
    '抖音好友「小王」：在杭州；养了只橘猫',
  ])
  eq('formatSharedContext：privateSession=true 与默认一致',
    formatSharedContext(sharedBase, { privateSession: true }), formatSharedContext(sharedBase))
  eq('formatSharedContext：privateSession=false 不出现 QQ 记忆行', formatSharedContext(sharedBase, { privateSession: false }),
    ['抖音好友「小王」：在杭州；养了只橘猫'])
  eq('formatSharedContext：privateSession=false 且没有 facts → []',
    formatSharedContext({ qqMemories: [{ at: '', text: '私聊内容' }], dmNick: '', dmFacts: [] }, { privateSession: false }), [])
  eq('formatSharedContext：QQ 记忆带时间时加 [HH:mm] 前缀',
    /^- \[\d{2}:\d{2}\] 带时间$/.test(formatSharedContext({ qqMemories: [{ at: '1700000000000', text: '带时间' }] })[1]), true)
  eq('formatSharedContext：记忆文本截到 120 字',
    formatSharedContext({ qqMemories: [{ at: '', text: 'y'.repeat(200) }] })[1], `- ${'y'.repeat(120)}`)
  eq('formatSharedContext：facts 用「；」连接、昵称为空回「对方」',
    formatSharedContext({ dmNick: '  ', dmFacts: ['在杭州', '养了只橘猫'] }), ['抖音好友「对方」：在杭州；养了只橘猫'])
  eq('formatSharedContext：facts 最多 5 条',
    formatSharedContext({ dmFacts: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7'] }), ['抖音好友「对方」：f1；f2；f3；f4；f5'])
  eq('formatSharedContext：单条 fact 截到 60 字',
    formatSharedContext({ dmFacts: ['x'.repeat(100)] }), [`抖音好友「对方」：${'x'.repeat(60)}`])
  eq('formatSharedContext：空上下文 → []',
    [formatSharedContext({}), formatSharedContext({ qqMemories: [], dmNick: '', dmFacts: [] })], [[], []])

  // ---- readSharedContext：临时 DSH_HOME（os.tmpdir），两个文件都放在里面 ----
  const shareHome = mkdtempSync(join(tmpdir(), 'qqdy-share-'))
  try {
    writeFileSync(join(shareHome, 'memory-brain.json'), JSON.stringify({
      memories: [
        { source: 'qq', createdAt: 1700000000000, assistantText: 'QQ 鱼记得：他周末去爬山', excerpt: '【当前时间】2026/11/14 系统提示' },
        { source: 'qq', createdAt: 1700000001000, assistantText: '另一条 QQ 记忆' },
        { source: 'task', createdAt: 1700000002000, assistantText: '不是 QQ 的' },
        { source: 'qq', createdAt: 1700000003000, assistantText: '已遗忘', forgottenAt: '2026-11-01T00:00:00Z' },
      ],
    }), 'utf8')
    mkdirSync(join(shareHome, 'douyin-duty', 'memory'), { recursive: true })
    writeFileSync(join(shareHome, 'douyin-duty', 'memory', 'dm-MS4wSEC.json'), JSON.stringify({
      who: { nick: '小王' },
      facts: ['在杭州', '养了只橘猫'],
    }), 'utf8')

    const shared = readSharedContext({ home: shareHome, secUid: 'MS4wSEC', limit: 2 })
    eq('readSharedContext：读到 QQ 记忆（倒序、跳过遗忘 / 非 QQ）', shared.qqMemories.map((item) => item.text),
      ['另一条 QQ 记忆', 'QQ 鱼记得：他周末去爬山'])
    eq('readSharedContext：读到抖音昵称', shared.dmNick, '小王')
    eq('readSharedContext：读到抖音 facts', shared.dmFacts, ['在杭州', '养了只橘猫'])

    const noSec = readSharedContext({ home: shareHome })
    eq('readSharedContext：没给 secUid 时不读抖音 facts', [noSec.dmNick, noSec.dmFacts], ['', []])
    eq('readSharedContext：没给 secUid 仍读 QQ 记忆', noSec.qqMemories.length, 2)

    const missingShared = readSharedContext({ home: join(shareHome, 'no-such-home'), secUid: 'MS4wSEC' })
    eq('readSharedContext：文件缺失 → 空结果不抛', missingShared, { qqMemories: [], dmNick: '', dmFacts: [] })

    const badHome = join(shareHome, 'bad')
    mkdirSync(join(badHome, 'douyin-duty', 'memory'), { recursive: true })
    writeFileSync(join(badHome, 'memory-brain.json'), '{ 坏 JSON', 'utf8')
    writeFileSync(join(badHome, 'douyin-duty', 'memory', 'dm-BAD1.json'), '坏 JSON', 'utf8')
    eq('readSharedContext：坏 JSON → 空结果不抛', readSharedContext({ home: badHome, secUid: 'BAD1' }),
      { qqMemories: [], dmNick: '', dmFacts: [] })
  } finally {
    rmSync(shareHome, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 12. v0.3 Cookie 头解析（lib/douyin-tools.mjs#parseCookieHeader）
// ---------------------------------------------------------------------------

function cookieHeaderTests() {
  eq('parseCookieHeader：a=1; b=2; → 两项', parseCookieHeader('a=1; b=2; '), new Map([['a', '1'], ['b', '2']]))
  truthy('parseCookieHeader：返回 Map', parseCookieHeader('a=1') instanceof Map)
  eq('parseCookieHeader：跳过空值 / 空名 / 没有等号的片段',
    [parseCookieHeader('a=; b=2').size, parseCookieHeader('=x; b=2').size, parseCookieHeader('garbage; b=2').size], [1, 1, 1])
  eq('parseCookieHeader：值里含等号保留', parseCookieHeader('x=a=b').get('x'), 'a=b')
  eq('parseCookieHeader：名字 / 值去首尾空格', parseCookieHeader(' s = v ').get('s'), 'v')
  eq('parseCookieHeader：空输入空 Map', [
    parseCookieHeader('').size,
    parseCookieHeader(null).size,
    parseCookieHeader(undefined).size,
    parseCookieHeader(' ; ; ').size,
  ], [0, 0, 0, 0])
  eq('parseCookieHeader：重名后者覆盖', parseCookieHeader('a=1; a=2').get('a'), '2')
  eq('parseCookieHeader：真实 douyin_cookie.txt 一行',
    [...parseCookieHeader('ttwid=1%7Cabc; passport_csrf_token=xyz; odin_tt=deadbeef').keys()],
    ['ttwid', 'passport_csrf_token', 'odin_tt'])
}

// ---------------------------------------------------------------------------
// 13. v0.7 视频大模型纯函数（lib/video-ai.mjs）
// ---------------------------------------------------------------------------

function videoAiTests() {
  // ---- videoModelConfig：没有 key 时明确 unavailable ----
  const none = videoModelConfig({})
  eq('videoModelConfig：没有 key 时 available=false', [none.available, none.provider], [false, ''])
  eq('videoModelConfig：没有 key 时 key 是空串', none.key, '')
  eq('videoModelConfig：没有 key 时的提示文案含 DASHSCOPE_API_KEY', MISSING_KEY_HINT.includes('DASHSCOPE_API_KEY'), true)

  // ---- DashScope 通道 ----
  const dash = videoModelConfig({ DASHSCOPE_API_KEY: ' sk-test ' })
  eq('videoModelConfig：有 DASHSCOPE_API_KEY → dashscope', [dash.available, dash.provider, dash.key], [true, 'dashscope', 'sk-test'])
  eq('videoModelConfig：DashScope 默认 endpoint', dash.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1')
  eq('videoModelConfig：DashScope 默认模型留空（走候选回退）', dash.model, '')
  const custom = videoModelConfig({ DASHSCOPE_API_KEY: 'k', DASHSCOPE_BASE_URL: 'https://example.test/v1/', QQDY_VLM_MODEL: 'qwen-vl-max-latest' })
  eq('videoModelConfig：自定义 baseURL 去尾斜杠 / 自定义模型',
    [custom.baseUrl, custom.model], ['https://example.test/v1', 'qwen-vl-max-latest'])

  // ---- Gemini 通道（dashscope 优先）----
  const gem = videoModelConfig({ GEMINI_API_KEY: 'g-key' })
  eq('videoModelConfig：只有 GEMINI_API_KEY → gemini', [gem.available, gem.provider, gem.key], [true, 'gemini', 'g-key'])
  eq('videoModelConfig：Gemini 默认 endpoint', gem.baseUrl, 'https://generativelanguage.googleapis.com/v1beta')
  const both = videoModelConfig({ DASHSCOPE_API_KEY: 'd', GEMINI_API_KEY: 'g' })
  eq('videoModelConfig：两个 key 都有时优先 DashScope', both.provider, 'dashscope')
  eq('videoModelConfig：空字符串 key 不算有 key',
    [videoModelConfig({ DASHSCOPE_API_KEY: '   ' }).available, videoModelConfig({ GEMINI_API_KEY: '' }).available],
    [false, false])

  // ---- buildDescribePrompt ----
  const prompt = buildDescribePrompt({
    frames: 6,
    title: '鲸小团日常—冬天当然是吃火锅啦！',
    author: '大肥鱼鲸小团',
    transcript: '今晚给你做火锅吃',
    captions: ['字幕一'],
  })
  truthy('buildDescribePrompt：含帧数', prompt.includes('6 张画面帧'))
  truthy('buildDescribePrompt：含标题', prompt.includes('冬天当然是吃火锅啦'))
  truthy('buildDescribePrompt：含作者', prompt.includes('大肥鱼鲸小团'))
  truthy('buildDescribePrompt：含语音转写', prompt.includes('今晚给你做火锅吃'))
  truthy('buildDescribePrompt：含自动字幕', prompt.includes('字幕一'))
  truthy('buildDescribePrompt：要求输出 JSON', prompt.includes('"summary"') && prompt.includes('"scenes"'))
  truthy('buildDescribePrompt：要求不编造', prompt.includes('不要编造'))
  const withOcr = buildDescribePrompt({ frames: 3, ocrText: '画面里写着：时光一眨眼' })
  truthy('buildDescribePrompt：带 OCR 文字时写进提示词', withOcr.includes('OCR 识别到的画面文字：画面里写着：时光一眨眼'))
  truthy('buildDescribePrompt：不带 OCR 时不出现 OCR 行', !prompt.includes('OCR 识别到的画面文字'))
  eq('cleanOcrText：去掉坐标前缀 / 纯数字行 / 去重',
    cleanOcrText('202,908,69,251,90,时光一眨眼又是个冬天\n168,904,61,81,90,想要见\n12,34,56,78,90\n时光一眨眼又是个冬天\n无'),
    '时光一眨眼又是个冬天\n想要见')
  eq('cleanOcrText：空输入', cleanOcrText(''), '')
  eq('cleanOcrText：普通文字原样保留', cleanOcrText('第一行\n第二行'), '第一行\n第二行')
  const bare = buildDescribePrompt()
  truthy('buildDescribePrompt：空输入也给字符串', typeof bare === 'string' && bare.includes('画面帧'))
  truthy('buildDescribePrompt：空输入不出现「视频文案：」', !bare.includes('视频文案：'))
  const longTitle = buildDescribePrompt({ title: 'x'.repeat(400) })
  truthy('buildDescribePrompt：超长标题被截断', !longTitle.includes('x'.repeat(200)))

  // ---- parseKeyFile：key 文件格式 ----
  eq('parseKeyFile：裸 sk- key 当 dashscope',
    parseKeyFile('sk-abc123'), { provider: 'dashscope', key: 'sk-abc123' })
  eq('parseKeyFile：dashscope: 前缀',
    parseKeyFile('dashscope: sk-xxx'), { provider: 'dashscope', key: 'sk-xxx' })
  eq('parseKeyFile：gemini: 前缀',
    parseKeyFile('gemini: AIzaFakeKey1234567890'), { provider: 'gemini', key: 'AIzaFakeKey1234567890' })
  eq('parseKeyFile：google= 前缀',
    parseKeyFile('google=AIzaFakeKey1234567890'), { provider: 'gemini', key: 'AIzaFakeKey1234567890' })
  eq('parseKeyFile：裸 AIza key 当 gemini',
    parseKeyFile('AIzaFakeKey1234567890'), { provider: 'gemini', key: 'AIzaFakeKey1234567890' })
  eq('parseKeyFile：注释 / 空行跳过取下一行',
    parseKeyFile('# 注释\n\n  dashscope=k-1  \n'), { provider: 'dashscope', key: 'k-1' })
  eq('parseKeyFile：空文件 / null',
    [parseKeyFile(''), parseKeyFile(null), parseKeyFile('# only comment')],
    [{ provider: '', key: '' }, { provider: '', key: '' }, { provider: '', key: '' }])

  // ---- 文件回退：$DSH_HOME/vlm-key.txt ----
  const keyHome = join(TMP, 'vlm-key-home')
  mkdirSync(keyHome, { recursive: true })
  const savedHome = process.env.DSH_HOME
  const fakeEnv = { DSH_HOME: keyHome }
  process.env.DSH_HOME = keyHome
  try {
    writeFileSync(join(keyHome, 'vlm-key.txt'), 'dashscope: sk-from-file\n', 'utf8')
    const fromFile = videoModelConfig(fakeEnv, { useKeyFile: true })
    eq('videoModelConfig：没有环境变量时从 vlm-key.txt 读 dashscope key',
      [fromFile.available, fromFile.provider, fromFile.key], [true, 'dashscope', 'sk-from-file'])
    writeFileSync(join(keyHome, 'vlm-key.txt'), 'gemini: AIzaFakeKey1234567890\n', 'utf8')
    const gemFromFile = videoModelConfig(fakeEnv, { useKeyFile: true })
    eq('videoModelConfig：vlm-key.txt 写 gemini: 时走 gemini',
      [gemFromFile.available, gemFromFile.provider], [true, 'gemini'])
    rmSync(join(keyHome, 'vlm-key.txt'), { force: true })
    eq('videoModelConfig：没有 key 文件时 unavailable',
      videoModelConfig(fakeEnv, { useKeyFile: true }).available, false)
    eq('videoModelConfig：显式 env 默认不读文件（自检隔离）',
      videoModelConfig(fakeEnv).available, false)
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
  }

  // ---- v0.9 免费额度优先：模型顺序 / 错误分类 / 冷却状态 ----
  eq('v0.9 默认模型顺序：qwen3-vl-plus 已开通在前，其次 qwen-vl-max-latest',
    VLM_MODEL_CANDIDATES.slice(0, 2), ['qwen3-vl-plus', 'qwen-vl-max-latest'])
  truthy('v0.9 默认模型顺序：不再包含无效的 qwen-vl-plus / qwen3-vl-flash',
    !VLM_MODEL_CANDIDATES.includes('qwen-vl-plus') && !VLM_MODEL_CANDIDATES.includes('qwen3-vl-flash'))
  eq('v0.9 modelListForProvider：默认用 DashScope 顺序',
    modelListForProvider('dashscope', {}), [...VLM_MODEL_CANDIDATES])
  eq('v0.9 modelListForProvider：QQDY_VLM_MODELS 覆盖顺序（去空格/空项）',
    modelListForProvider('dashscope', { QQDY_VLM_MODELS: ' a , ,b,c ' }), ['a', 'b', 'c'])
  eq('v0.9 modelListForProvider：gemini 用自己的列表',
    modelListForProvider('gemini', {}).length, 2)

  eq('v0.9 classifyVlmError：额度/未开通 → quota',
    [classifyVlmError(403, 'AccessDenied: model not authorized'),
      classifyVlmError(400, 'free quota exceeded, 免费额度已用完'),
      classifyVlmError(400, '余额不足')],
    ['quota', 'quota', 'quota'])
  eq('v0.9 classifyVlmError：模型不存在 → missing',
    [classifyVlmError(404, '{"error":{"code":"model_not_found","message":"Model not exist."}}'),
      classifyVlmError(400, '模型不存在')],
    ['missing', 'missing'])
  eq('v0.9 classifyVlmError：限流 → throttle',
    [classifyVlmError(429, 'rate limit'), classifyVlmError(400, 'concurrency exceeded')],
    ['throttle', 'throttle'])
  eq('v0.9 classifyVlmError：key 鉴权 → auth',
    classifyVlmError(401, 'invalid api key'), 'auth')
  eq('v0.9 classifyVlmError：普通错误 → other',
    classifyVlmError(500, 'internal error'), 'other')

  const now = Date.parse('2026-11-21T12:00:00Z')
  const baseState = { preferred: '', exhausted: {}, throttled: {} }
  const cooled = markModelCooling(baseState, 'qwen-vl-plus', 'quota', now)
  truthy('v0.9 markModelCooling：quota 写进 exhausted',
    Date.parse(cooled.exhausted['qwen-vl-plus']) > now)
  const throttled = markModelCooling(baseState, 'qwen-vl-max-latest', 'throttle', now)
  eq('v0.9 markModelCooling：throttle 冷却 10 分钟',
    Date.parse(throttled.throttled['qwen-vl-max-latest']) - now, THROTTLE_COOLDOWN_MS)
  eq('v0.9 markModelSuccess：preferred + 清掉自己的冷却',
    (() => {
      const s = markModelSuccess(cooled, 'qwen-vl-plus', now)
      return [s.preferred, Object.prototype.hasOwnProperty.call(s.exhausted, 'qwen-vl-plus')]
    })(), ['qwen-vl-plus', false])

  eq('v0.9 pickModelCandidates：跳过冷却中的模型',
    pickModelCandidates({ list: [...VLM_MODEL_CANDIDATES], state: markModelCooling(baseState, 'qwen3-vl-plus', 'quota', now), now }),
    VLM_MODEL_CANDIDATES.filter((model) => model !== 'qwen3-vl-plus'))
  eq('v0.9 pickModelCandidates：preferred 提到最前',
    pickModelCandidates({ list: [...VLM_MODEL_CANDIDATES], state: { preferred: VLM_MODEL_CANDIDATES[1], exhausted: {}, throttled: {} }, now }),
    [VLM_MODEL_CANDIDATES[1], ...VLM_MODEL_CANDIDATES.filter((model) => model !== VLM_MODEL_CANDIDATES[1])])
  eq('v0.9 pickModelCandidates：显式配置的模型排最前',
    pickModelCandidates({ list: [...VLM_MODEL_CANDIDATES], configured: 'qwen3-vl-plus', state: baseState, now })[0],
    'qwen3-vl-plus')
  eq('v0.9 pickModelCandidates：全部冷却时仍返回原列表（宁可再试一次）',
    (() => {
      const all = { preferred: '', exhausted: Object.fromEntries(VLM_MODEL_CANDIDATES.map((m) => [m, new Date(now + 86400000).toISOString()])), throttled: {} }
      return pickModelCandidates({ list: [...VLM_MODEL_CANDIDATES], state: all, now })
    })(), [...VLM_MODEL_CANDIDATES])
  eq('v0.9 pickModelCandidates：冷却已过期的不再跳过',
    (() => {
      const expired = { preferred: '', exhausted: { 'qwen-vl-plus': new Date(now - 1000).toISOString() }, throttled: {} }
      return pickModelCandidates({ list: [...VLM_MODEL_CANDIDATES], state: expired, now })
    })(), [...VLM_MODEL_CANDIDATES])

  // ---- 模型状态文件读写（临时路径，不碰真实 $DSH_HOME） ----
  const stateFile = join(TMP, 'vlm-model-state.json')
  writeModelState({ preferred: 'qwen-vl-plus', exhausted: { 'qwen-vl-max-latest': '2026-12-31T00:00:00.000Z' }, throttled: {} }, stateFile)
  const loaded = readModelState(stateFile)
  eq('v0.9 readModelState：能读回 preferred / exhausted',
    [loaded.preferred, Object.keys(loaded.exhausted)], ['qwen-vl-plus', ['qwen-vl-max-latest']])
  rmSync(stateFile, { force: true })
  eq('v0.9 readModelState：文件不存在时返回空状态',
    readModelState(stateFile), { preferred: '', exhausted: {}, throttled: {} })
  writeModelState({ preferred: '', exhausted: {}, throttled: {} }, join(TMP, 'bad-dir', 'vlm-state.json'))
  truthy('v0.9 writeModelState：目录不存在时自动建目录', existsSync(join(TMP, 'bad-dir', 'vlm-state.json')))
}

// ---------------------------------------------------------------------------
// 14. 包契约静态检查
// ---------------------------------------------------------------------------

function staticTests() {
  const readJsonFile = (file) => {
    try {
      return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    } catch {
      return null
    }
  }
  const resolveTarget = (target) => join(ROOT, String(target).replace(/^\.\//, ''))
  const contains = (file) => existsSync(file) && statSync(file).size > 0

  const pkgFile = join(ROOT, 'package.json')
  truthy('package.json 存在', existsSync(pkgFile))
  const pkg = readJsonFile(pkgFile)
  truthy('package.json 可解析', pkg !== null)
  if (pkg === null) return
  eq('package.json name', pkg.name, 'dsh-qq-douyin-bridge')
  eq('package.json type 是 module', pkg.type, 'module')
  eq('package.json main', pkg.main, 'index.js')

  // ---- exports ----
  const exportsField = pkg.exports !== null && typeof pkg.exports === 'object' ? pkg.exports : {}
  truthy('package.json 声明 exports', Object.keys(exportsField).length > 0)
  const mainExport = exportsField['.']
  eq('exports "." 指向的文件存在', Boolean(mainExport) && existsSync(resolveTarget(mainExport)), true)
  const iconExport = exportsField['./icon']
  eq('exports "./icon" 指向的文件存在', Boolean(iconExport) && existsSync(resolveTarget(iconExport)), true)
  const localeExport = exportsField['./locale/*.json']
  if (typeof localeExport === 'string' && localeExport.includes('*')) {
    const [before, after] = localeExport.split('*')
    const localeDir = join(ROOT, before.replace(/^\.\//, '').replace(/\/$/, ''))
    const suffix = after || ''
    const matched = existsSync(localeDir) ? readdirSync(localeDir).filter((name) => name.endsWith(suffix)) : []
    eq('exports locale 通配至少匹配到 2 个文件', matched.length >= 2, true)
    eq('exports locale 通配的文件都存在', matched.every((name) => existsSync(join(localeDir, name))), true)
  } else {
    fail('exports "./locale/*.json" 是通配字符串', '"./locale/*.json"', localeExport)
  }
  const clientExport = exportsField['./client']
  const clientFile = join(ROOT, 'client.js')
  if (!existsSync(clientFile)) {
    skip('exports "./client" 指向的文件存在', 'client.js 还没写完（设置页半端）')
  } else {
    eq('exports "./client" 指向的文件存在', Boolean(clientExport) && existsSync(resolveTarget(clientExport)), true)
  }

  // ---- dsh.bundle.patch ----
  const dsh = pkg.dsh !== null && typeof pkg.dsh === 'object' ? pkg.dsh : {}
  const bundle = dsh.bundle !== null && typeof dsh.bundle === 'object' ? dsh.bundle : {}
  eq('dsh.bundle.patch 指向 ./cordis.patch.yml', bundle.patch, './cordis.patch.yml')
  const patchFile = typeof bundle.patch === 'string' ? resolveTarget(bundle.patch) : ''
  eq('cordis.patch.yml 存在', Boolean(patchFile) && existsSync(patchFile), true)
  if (patchFile && existsSync(patchFile)) {
    const patchText = readFileSync(patchFile, 'utf8')
    truthy('cordis.patch.yml 含包名 dsh-qq-douyin-bridge', patchText.includes('dsh-qq-douyin-bridge'))
    truthy('cordis.patch.yml 含 entry id qq-douyin-bridge', patchText.includes('id: qq-douyin-bridge'))
  }

  // ---- files 清单（声明要发布的文件应该都在） ----
  const filesField = Array.isArray(pkg.files) ? pkg.files : []
  truthy('package.json 声明 files', filesField.length > 0)
  for (const entry of filesField) {
    if (String(entry).includes('*')) continue
    const full = join(ROOT, entry)
    if (entry === 'client.js' && !existsSync(full)) {
      skip(`files 列出的 ${entry} 存在`, 'client.js 还没写完（设置页半端）')
      continue
    }
    eq(`files 列出的 ${entry} 存在`, existsSync(full), true)
  }

  // ---- locale ----
  const readLocale = (name) => readJsonFile(join(ROOT, 'locale', name))
  const zh = readLocale('zh.json')
  const en = readLocale('en.json')
  truthy('locale/zh.json 可解析', zh !== null)
  truthy('locale/en.json 可解析', en !== null)
  if (zh && en) {
    truthy('locale/zh.json meta.title 非空', typeof zh.meta?.title === 'string' && zh.meta.title.trim() !== '')
    truthy('locale/zh.json meta.description 非空', typeof zh.meta?.description === 'string' && zh.meta.description.trim() !== '')
    truthy('locale/en.json meta.title 非空', typeof en.meta?.title === 'string' && en.meta.title.trim() !== '')
    truthy('locale/en.json meta.description 非空', typeof en.meta?.description === 'string' && en.meta.description.trim() !== '')
    eq('中英 locale meta 键一致', Object.keys(zh.meta).sort(), Object.keys(en.meta).sort())
  }

  // ---- icon.svg ----
  const iconFile = join(ROOT, 'icon.svg')
  if (existsSync(iconFile)) {
    const iconText = readFileSync(iconFile, 'utf8')
    const iconSize = statSync(iconFile).size
    truthy('icon.svg 以 <svg 开头', iconText.startsWith('<svg'))
    eq('icon.svg 不超过 256 KiB', iconSize <= 256 * 1024, true)
    truthy('icon.svg 以 </svg> 结尾', iconText.trimEnd().endsWith('</svg>'))
  } else {
    fail('icon.svg 存在', true, false)
  }

  // ---- 契约 / 宿主 / 设置页 ----
  const contractFile = join(ROOT, 'CONTRACT.md')
  truthy('CONTRACT.md 存在且非空', contains(contractFile))
  if (existsSync(contractFile)) {
    const contractText = readFileSync(contractFile, 'utf8')
    truthy('CONTRACT.md 提到 selfcheck.mjs', contractText.includes('selfcheck.mjs'))
    truthy('CONTRACT.md 提到 /api/qq-douyin', contractText.includes('/api/qq-douyin'))
  }
  const indexFile = join(ROOT, 'index.js')
  truthy('index.js 存在且非空', contains(indexFile))
  if (existsSync(indexFile)) {
    const indexText = readFileSync(indexFile, 'utf8')
    truthy('index.js 导出 apply', /export function apply\s*\(/.test(indexText))
    truthy('index.js 声明 ROUTE_PREFIX=/api/qq-douyin', indexText.includes("'/api/qq-douyin'"))
    truthy('index.js 注册只读工具 douyin_video（v0.2）', indexText.includes('douyin_video'))
    truthy('index.js 有 douyin_video 的 feed 分支（v0.2 推荐流）', indexText.includes('feed'))
    truthy('index.js 引入 formatFeedForQQ（v0.2 推荐流）', indexText.includes('formatFeedForQQ'))
    truthy('index.js 引用 lib/links.mjs 与 lib/douyin-tools.mjs（v0.2）',
      indexText.includes('./lib/links.mjs') && indexText.includes('./lib/douyin-tools.mjs'))
    truthy('index.js 注入 systemPrompt.context（v0.3 共享记忆）', indexText.includes('systemPrompt.context'))
    truthy('index.js 定义 bridgeDigestText（v0.3 共享记忆）', indexText.includes('bridgeDigestText'))
    truthy('index.js 引用 ensureBrowserLogin（v0.3 Cookie 回灌）', indexText.includes('ensureBrowserLogin'))
    truthy('index.js 引入 lib/share.mjs（v0.3 共享记忆）', indexText.includes('./lib/share.mjs'))
  }
  truthy('lib/links.mjs 存在且非空（v0.2 链接解析）', contains(join(ROOT, 'lib', 'links.mjs')))
  truthy('lib/douyin-tools.mjs 存在且非空（v0.2 视频 / 评论）', contains(join(ROOT, 'lib', 'douyin-tools.mjs')))
  const douyinToolsFile = join(ROOT, 'lib', 'douyin-tools.mjs')
  truthy('lib/douyin-tools.mjs 含推荐流脚本入口 forward-pick.py（v0.2 推荐流）',
    existsSync(douyinToolsFile) && readFileSync(douyinToolsFile, 'utf8').includes('forward-pick.py'))
  truthy('lib/douyin-tools.mjs 含 parseCookieHeader（v0.3 Cookie 解析）',
    existsSync(douyinToolsFile) && readFileSync(douyinToolsFile, 'utf8').includes('export function parseCookieHeader'))
  truthy('lib/share.mjs 存在且非空（v0.3 共享记忆）', contains(join(ROOT, 'lib', 'share.mjs')))
  const shareLibFile = join(ROOT, 'lib', 'share.mjs')
  if (existsSync(shareLibFile)) {
    const shareLibText = readFileSync(shareLibFile, 'utf8')
    truthy('lib/share.mjs 导出 v0.3 四个纯函数', ['pickQqMemories', 'pickDmFacts', 'formatSharedContext', 'readSharedContext']
      .every((name) => shareLibText.includes(`export function ${name}(`)))
  }
  const storeLibFile = join(ROOT, 'lib', 'store.mjs')
  truthy('lib/store.mjs 含 v0.2 linkRecent 字段', existsSync(storeLibFile) && readFileSync(storeLibFile, 'utf8').includes('linkRecent'))
  truthy('lib/store.mjs 含 v0.3 transcript 字段', existsSync(storeLibFile) && readFileSync(storeLibFile, 'utf8').includes('transcript'))
  if (!existsSync(clientFile)) {
    skip('client.js 存在且是设置页模块', 'client.js 还没写完（设置页半端）')
  } else {
    const clientText = readFileSync(clientFile, 'utf8')
    truthy('client.js 非空', clientText.trim() !== '')
    truthy('client.js 用 __ModuleLoader__.load 自注册', clientText.includes('__ModuleLoader__.load'))
    truthy('client.js 注册 id 是 dsh-qq-douyin-bridge', clientText.includes('dsh-qq-douyin-bridge'))
  }
  const readmeFile = join(ROOT, 'README.md')
  truthy('README.md 存在且非空', contains(readmeFile))
  if (existsSync(readmeFile)) {
    const readmeText = readFileSync(readmeFile, 'utf8')
    truthy('README.md 提到自检命令 selfcheck.mjs', readmeText.includes('selfcheck.mjs'))
    truthy('README.md 提到 v0.2 只读工具 douyin_video', readmeText.includes('douyin_video'))
    truthy('README.md 提到 v0.2 链接分享设置 links.autoCard', readmeText.includes('autoCard'))
  }
  truthy('selfcheck.mjs 自身存在（就是本文件）', contains(join(ROOT, 'selfcheck.mjs')))

  // ---- 运行环境 ----
  eq('Node 版本 >= 18（.mjs + fetch）', Number(String(process.versions.node).split('.')[0]) >= 18, true)
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

console.log('dsh-qq-douyin-bridge selfcheck —— 离线（不联网、不依赖 DSH 宿主）')
console.log(`node ${process.version} · ${ROOT}`)

try {
  await group('1. 状态 / 规整 / 读写（lib/store.mjs）', storeTests)
  await group('2. 文案（lib/format.mjs）', formatTests)
  await group('3. 消息段解析（lib/filter.mjs）', segmentTests)
  await group('4. 抖音挑新（pickNewDouyin）', pickNewDouyinTests)
  await group('5. QQ 过滤（pickQqIngest）', pickQqIngestTests)
  await group('6. v0.2 抖音链接识别（lib/links.mjs，假 fetch）', linksTests)
  await group('7. v0.2 抖音视频 / 评论 / 推荐流纯函数（lib/douyin-tools.mjs）', douyinToolsTests)
  await group('8. OneBot 响应规整（lib/onebot.mjs，假 fetch）', onebotTests)
  await group('9. 抖音客户端（lib/douyin.mjs，假 fetch）', douyinClientTests)
  await group('10. 路径与自动发现（lib/paths.mjs / lib/discover.mjs）', pathAndDiscoverTests)
  await group('11. v0.3 共享记忆纯函数（lib/share.mjs）', shareTests)
  await group('12. v0.3 Cookie 头解析（lib/douyin-tools.mjs#parseCookieHeader）', cookieHeaderTests)
  await group('13. v0.7 视频大模型纯函数（lib/video-ai.mjs）', videoAiTests)
  await group('14. 包契约静态检查', staticTests)
} finally {
  if (ORIGINAL_DSH_HOME === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = ORIGINAL_DSH_HOME
  rmSync(TMP, { recursive: true, force: true })
}

console.log('')
if (failureNames.length > 0) {
  console.log('失败的检查：')
  for (const name of failureNames) console.log(`  - ${name}`)
}
if (skipped > 0) console.log(`（跳过 ${skipped} 项：设置页 client.js 还没合入；合入后会自动变成正式检查）`)
console.log(`${passed} passed, ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
