/**
 * dsh-qq-douyin-bridge —— 宿主半端（Host half）。
 * ============================================================================
 * 一个插件，把「一个 QQ 会话」和「一位抖音好友的私信」接成一条双向通道：
 *
 *   抖音好友发来私信  →  宿主发到绑定的 QQ 会话（带 `【抖音·昵称】` 前缀）
 *   QQ 会话里回的话    →  宿主发回抖音好友（默认只转「引用/回复了转发消息」的发言）
 *
 * 两条边都是「用现成程序，不自己开浏览器」：
 *   QQ：SnowLuma OneBot v11 HTTP（`get_login_info` / `get_*_msg_history` / `send_*_msg`）
 *   抖音：同机 dsh-douyin-scroll 的 `/api/douyin-duty/*`（读私信 ~1s；发私信走它的无头 Chrome）
 *
 * 契约见 CONTRACT.md；纯函数在 lib/ 下，selfcheck.mjs 直接测它们。
 */
import { join } from 'node:path'
import { createDouyin } from './lib/douyin.mjs'
import {
  cleanupWorkDir,
  discoverDouyinTools,
  downloadDouyinVideo,
  ensureBrowserLogin,
  extractFramesAndAudio,
  fetchComments,
  fetchFeed,
  fetchVideoDetail,
  formatCount,
  formatFeedDigest,
  formatFeedForQQ,
  formatVideoDigest,
  makeWorkDir,
  openInBrowser,
  shareVideoCard,
  transcribeAudio,
} from './lib/douyin-tools.mjs'
import { aiOverlapOf, listDouyinMemoryPeers, readQqBridgeConfig } from './lib/discover.mjs'
import { clip, formatDouyinForQQ, nowIso } from './lib/format.mjs'
import { douyinFingerprint, looksLikeForwardedMark, pickNewDouyin, pickQqIngest, replyToIdOf, textOf } from './lib/filter.mjs'

/** 判断一句话是不是在明确「要视频」——只有明确要，才把 MP4 发回 QQ。 */
function wantsVideoRequest(text) {
  const t = String(text || '').trim()
  if (t === '') return false
  if (/不(要|用|需要|想).{0,4}视频/.test(t)) return false
  return /(要|发|看|给我|来|下载|传|整段).{0,6}视频|视频.{0,8}(发我|发给我|给我|发一下|发来|传我|看看|来看)|整段视频|视频原片|原视频/i.test(t)
}
import { canonicalVideoUrl, extractTargets, resolveAwemeTarget } from './lib/links.mjs'
import { createOneBot } from './lib/onebot.mjs'
import { bridgeHome } from './lib/paths.mjs'
import { formatSharedContext, readSharedContext } from './lib/share.mjs'
import { describeFrames, modelListForProvider, modelStatePath, ocrFrames, probeVlmModels, readModelState, videoModelConfig, writeModelState } from './lib/video-ai.mjs'
import {
  DEFAULT_PREFIX,
  FILTERS,
  isConfigured,
  loadState,
  MAX_POLL_MS,
  MIN_POLL_MS,
  publicState,
  pushLog,
  saveState,
} from './lib/store.mjs'

/** 需要的宿主服务：HTTP 路由 / 本机连接认证 / 工具注册 / 系统提示注入。 */
export const inject = ['webServer', 'connection', 'tools', 'systemPrompt']

/** 设置页与宿主共享的路由前缀。 */
export const ROUTE_PREFIX = '/api/qq-douyin'

const MAX_FORWARD_PER_ROUND = 5
const QQ_HISTORY_COUNT = 20
const QQ_SEND_GAP_MS = 700
const MAX_BODY_BYTES = 256 * 1024
const HEALTH_TTL = { qq: 60_000, douyin: 30_000, peer: 60_000 }
const MAX_TEXT = 1800

/**
 * 挂载桥：状态、轮询、HTTP 路由、Agent 工具。
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主插件上下文
 */
export function apply(ctx) {
  const loaded = loadState(bridgeHome())
  /** @type {ReturnType<typeof loadState>['state']} */
  let state = loaded.state
  /** @type {NodeJS.Timeout | null} 轮询定时器 */
  let timer = null
  /** @type {NodeJS.Timeout | null} 启动后第一次补跑 */
  let kickTimer = null
  /** 一轮是否正在跑（防重入）。 */
  let tickBusy = false
  /** 插件是否已卸载。 */
  let disposed = false
  /** 状态写盘串行化。 */
  let saveChain = Promise.resolve()
  /** 抖音发送串行队列（同一时刻只跑一个无头 Chrome 发送）。 */
  let douyinSendChain = Promise.resolve()
  /** 链接处理队列（发卡片 / 打开浏览器，串行，不阻塞 QQ 轮询）。 */
  const linkQueue = []
  /** 链接队列是否在跑。 */
  let linkQueueBusy = false
  /** 抖音工具发现结果缓存（60s）。 */
  let douyinToolsCache = null
  /** 共享上下文（QQ 记忆 + 抖音好友 facts）缓存（10s）。 */
  let shareCache = null
  /** 机器人自己的 QQ 号（从最近一次 get_login_info 得到）。 */
  let selfUin = ''
  /** 最近一轮同步的开始时间（展示 `nextSyncInMs` 用）。 */
  let lastTickStartedAt = 0
  /** 本机健康信息缓存。 */
  const healthCache = { qq: null, douyin: null, peer: null }

  const logger = (message) => {
    try {
      ctx.logger?.info?.(`[qq-douyin] ${String(message)}`)
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  // ---------------------------------------------------------------------------
  // 端点发现 / 客户端
  // ---------------------------------------------------------------------------

  /**
   * 解析两边的基址。QQ 从 qq-bridge 配置自动发现；抖音用宿主自己的 origin。
   * @returns {{ qqApiBase: string, qqToken: string, douyinApiBase: string, storePath: string }}
   */
  function bases() {
    const bridge = readQqBridgeConfig()
    const qqApiBase = state.settings.qqApiBase || bridge.httpUrl || 'http://127.0.0.1:3000'
    const origin = (() => {
      try {
        return ctx.webServer.getOrigin()
      } catch {
        return 'http://127.0.0.1'
      }
    })()
    const douyinApiBase = state.settings.douyinApiBase || `${String(origin).replace(/\/+$/, '')}/api/douyin-duty`
    return {
      qqApiBase,
      qqToken: bridge.accessToken,
      douyinApiBase,
      storePath: join(bridgeHome(), 'state.json'),
    }
  }

  /** 每轮新建轻量客户端（构造本身不产生 IO）。 */
  function clients() {
    const base = bases()
    return {
      bases: base,
      onebot: createOneBot({ baseUrl: base.qqApiBase, token: base.qqToken, timeoutMs: 15_000 }),
      douyin: createDouyin({ baseUrl: base.douyinApiBase, timeoutMs: 30_000 }),
    }
  }

  // ---------------------------------------------------------------------------
  // 状态持久化
  // ---------------------------------------------------------------------------

  /** 串行写盘（失败只记日志，不阻塞业务）。 */
  function persist() {
    const snapshot = state
    saveChain = saveChain
      .then(() => {
        const result = saveState(bridgeHome(), snapshot)
        if (!result.ok) logger(`状态写盘失败：${result.error || '未知原因'}`)
      })
      .catch(() => {})
    return saveChain
  }

  /**
   * 改状态 → 写盘。
   * @param {(draft: any) => void} mutate
   */
  async function commit(mutate) {
    try {
      mutate(state)
    } catch (error) {
      logger(`改状态时出错：${String((error && error.message) || error)}`)
    }
    await persist()
    return state
  }

  /**
   * 往「共享对话摘要」里加一条（两边的 AI 都能通过 prompt 上下文看到）。
   * side: douyin = 抖音好友发来的 / qq = QQ 这边发去抖音的 / feed = 推荐视频 / link = 链接分享 / sys。
   * @param {any} draft
   * @param {{ side: 'douyin'|'qq'|'feed'|'link'|'sys', text: string, kind?: string }} row
   */
  function addTranscript(draft, row) {
    const list = Array.isArray(draft.transcript) ? draft.transcript : []
    const text = clip(String(row.text || ''), 300)
    if (text === '') return
    list.push({ at: nowIso(), side: row.side, text, kind: row.kind || '' })
    draft.transcript = list.slice(-40)
  }

  /**
   * QQ 鱼 / 抖音鱼共享的运行时上下文（注入到所有 Agent 的系统提示里）。
   * 没绑定就没内容，避免污染无关会话。
   * @returns {string}
   */
  function bridgeDigestText() {
    if (!isConfigured(state)) return ''
    const lines = ['【QQ × 抖音桥 · 共享记忆】']
    lines.push(`绑定：抖音「${state.douyin.nick || state.douyin.sec_uid.slice(0, 10)}」↔ QQ ${state.qq.kind === 'group' ? '群 ' : '私聊 '}${state.qq.id}；桥${state.enabled ? '开着' : '关着'}。`)
    lines.push('【工具】要查抖音视频/评论/推荐流，用只读工具 douyin_video（action=info/comments/feed，参数 url 或 aweme_id）。qq_douyin_bridge 不在 QQ 白名单里，调它会失败。')
    lines.push('想“看整段视频/动态+听声音+画面理解”：用 douyin_video action=watch（把完整视频+帧+原声发到 QQ，并附视频大模型画面理解 + 本地 Whisper 声音转写）或 action=describe（只看不发消息）。')
    lines.push(state.direction.douyinToQQ !== true
      ? '抖音私聊内容当前**不会**转发到 QQ（方向「抖音→QQ」已关）；QQ→抖音 方向仍可用。'
      : (state.inbound.skipCards
        ? '抖音好友发来的「分享视频/作品卡片」默认**不转**进 QQ（避免刷屏）；要看整段视频/画面/声音，用 douyin_video action=watch 主动搬。'
        : '抖音好友发来的卡片（分享视频）会带可点链接 + 封面图；想“看画面”可用 qq_get_message_images 读那张封面图。'))
    lines.push(state.links.fetchVideo !== false
      ? '在 QQ 里发抖音链接时**不会**自动发视频；只有用户明确说「要视频 / 把视频发我」时，桥才会把 MP4 发回 QQ（单独发一句“要视频”也行，会用最近一条链接）。'
      : '在 QQ 里发抖音链接时自动发视频（MP4）回 QQ 的功能当前是关的（用户要视频也发不了）。')
    lines.push(state.links.autoUnderstand !== false
      ? '同一条链接还会自动做「视频理解」（画面 + 画面文字 + 声音），把结论发回 QQ 并写进共享记忆（当前开）。'
      : 'QQ 链接的自动「视频理解」当前是关的（可用 douyin_video action=describe 手动看）。')
    const recent = (Array.isArray(state.transcript) ? state.transcript : []).slice(-8)
    if (recent.length === 0) {
      lines.push('（还没有互通内容：抖音私信会以【抖音·昵称】前缀转到 QQ，QQ 里的回复会发回抖音。）')
      return lines.join('\n')
    }
    lines.push('最近在两个平台之间互通的内容（两边的 AI 都知情，不要当没发生过）：')
    for (const row of recent) {
      const who = row.side === 'douyin' ? '抖音好友' : row.side === 'qq' ? 'QQ 这边' : row.side === 'feed' ? '抖音推荐' : row.side === 'link' ? '链接分享' : '系统'
      lines.push(`- [${String(row.at || '').slice(11, 16)}] ${who}：${clip(row.text, 120)}`)
    }
    // 两边已有记忆的摘要：QQ 鱼记得的事 + 抖音好友的长期事实（10s 缓存，写盘极便宜）
    try {
      const now = Date.now()
      const cacheKey = `${state.douyin.sec_uid}|${state.qq.kind}`
      if (shareCache === null || shareCache.key !== cacheKey || now - shareCache.at > 10_000) {
        shareCache = { at: now, key: cacheKey, value: readSharedContext({ secUid: state.douyin.sec_uid, limit: 3 }) }
      }
      const sharedLines = formatSharedContext(shareCache.value, { privateSession: state.qq.kind === 'private' })
      if (sharedLines.length > 0) lines.push('两边共享的要点：', ...sharedLines)
    } catch {
      /* 记忆读不到不影响桥 */
    }
    return lines.join('\n')
  }

  ctx.effect(() => ctx.systemPrompt.context({
    name: 'qq-douyin-bridge-shared',
    order: 60,
    text: () => bridgeDigestText(),
  }), 'dsh-qq-douyin-bridge: 共享上下文（QQ 鱼 ↔ 抖音鱼）')

  // ---------------------------------------------------------------------------
  // 健康检查（都带缓存，设置页 10s 轮询也不会把两边打爆）
  // ---------------------------------------------------------------------------

  /** QQ 侧健康（缓存 60s）。 */
  async function checkQq(force = false) {
    const now = Date.now()
    if (!force && healthCache.qq && now - healthCache.qq.at < HEALTH_TTL.qq) return healthCache.qq
    const { onebot } = clients()
    const result = await onebot.loginInfo()
    if (result.ok) {
      const data = result.data !== null && typeof result.data === 'object' ? result.data : {}
      const uin = String(data.user_id ?? '')
      if (uin !== '') selfUin = uin
      healthCache.qq = { ok: true, at: now, uin, nick: String(data.nickname ?? ''), error: '' }
    } else {
      healthCache.qq = { ok: false, at: now, uin: selfUin, nick: '', error: result.error || '连不上 QQ 侧' }
    }
    return healthCache.qq
  }

  /** 抖音侧健康（缓存 30s）。 */
  async function checkDouyin(force = false) {
    const now = Date.now()
    if (!force && healthCache.douyin && now - healthCache.douyin.at < HEALTH_TTL.douyin) return healthCache.douyin
    const { douyin } = clients()
    const result = await douyin.status()
    if (result.ok) {
      const data = result.data
      const account = data.account !== null && typeof data.account === 'object' ? data.account : null
      healthCache.douyin = {
        ok: true,
        at: now,
        loggedIn: data.loggedIn === true,
        nick: account ? String(account.nick || '') : '',
        uid: account ? String(account.uid || '') : '',
        error: data.loggedIn === true ? '' : '抖音还没登录',
      }
    } else {
      healthCache.douyin = { ok: false, at: now, loggedIn: false, nick: '', uid: '', error: result.error || '连不上抖音插件' }
    }
    return healthCache.douyin
  }

  /** 绑定的对端可读性（缓存 60s；一次 ~1s 的 HTTP 快路径）。 */
  async function checkPeer(force = false) {
    const now = Date.now()
    const boundSecUid = String(state.douyin.sec_uid || '')
    if (!force && healthCache.peer && healthCache.peer.secUid === boundSecUid && now - healthCache.peer.at < HEALTH_TTL.peer) {
      return healthCache.peer
    }
    if (!isConfigured(state)) {
      healthCache.peer = { ok: false, at: now, secUid: '', nick: '', count: 0, lastThem: '', error: '还没绑定' }
      return healthCache.peer
    }
    const { douyin } = clients()
    const result = await douyin.read(state.douyin.sec_uid, state.douyin.nick)
    if (!result.ok) {
      healthCache.peer = {
        ok: false,
        at: now,
        secUid: boundSecUid,
        nick: state.douyin.nick,
        count: 0,
        lastThem: '',
        error: result.error || '读不到这个人的私信',
        needLogin: result.needLogin === true,
      }
      return healthCache.peer
    }
    const messages = Array.isArray(result.data.messages) ? result.data.messages : []
    const theirs = messages.filter((m) => m && m.from === 'them')
    const last = theirs.length ? theirs[theirs.length - 1] : null
    healthCache.peer = {
      ok: true,
      at: now,
      secUid: boundSecUid,
      nick: String(result.data.to || state.douyin.nick || ''),
      count: theirs.length,
      lastThem: last ? String(last.text || '') : '',
      lastThemAt: last ? String(last.at || '') : '',
      error: '',
    }
    return healthCache.peer
  }

  /** 汇总健康（设置页 / 工具 / 同步都用它）。 */
  async function buildHealth(force = false) {
    const [qq, douyin] = await Promise.all([checkQq(force), checkDouyin(force)])
    const configured = isConfigured(state)
    const peer = configured ? await checkPeer(force) : { ok: false, nick: '', count: 0, lastThem: '', error: '还没绑定' }
    return {
      qq: { ok: qq.ok, uin: qq.uin, nick: qq.nick, error: qq.error },
      douyin: { ok: douyin.ok, loggedIn: douyin.loggedIn, nick: douyin.nick, uid: douyin.uid, error: douyin.error },
      peer: {
        ok: peer.ok,
        nick: peer.nick,
        count: peer.count,
        lastThem: peer.lastThem,
        error: peer.error,
        ...(peer.needLogin ? { needLogin: true } : {}),
      },
      aiOverlap: configured ? aiOverlapOf(state.qq.kind, state.qq.id) : false,
      douyinTools: (() => {
        const tools = douyinTools()
        return tools.ok === true
          ? { ok: true, dir: tools.dir }
          : { ok: false, error: tools.error }
      })(),
      running: timer !== null,
      nextSyncInMs: timer !== null
        ? (lastTickStartedAt > 0 ? Math.max(0, state.pollMs - (Date.now() - lastTickStartedAt)) : state.pollMs)
        : null,
    }
  }

  // ---------------------------------------------------------------------------
  // 同步一轮
  // ---------------------------------------------------------------------------

  /**
   * 跑一轮同步。
   * @param {{ manual?: boolean }} [options]
   */
  async function runTick(options = {}) {
    const manual = options.manual === true
    if (tickBusy) return { ok: false, busy: true, error: '上一轮同步还没跑完，稍等一下。', dq: emptySide(), qd: emptySide(), errors: ['上一轮还在跑'] }
    if (!manual && state.enabled !== true) return { ok: true, skipped: 'disabled', dq: emptySide('桥是关着的'), qd: emptySide('桥是关着的'), errors: [] }
    if (!isConfigured(state)) return { ok: true, skipped: 'not-bound', dq: emptySide('还没绑定'), qd: emptySide('还没绑定'), errors: [] }

    tickBusy = true
    lastTickStartedAt = Date.now()
    /** @type {{ dq: ReturnType<typeof emptySide>, qd: ReturnType<typeof emptySide>, errors: string[] }} */
    const result = { dq: emptySide(), qd: emptySide(), errors: [] }
    try {
      const [qqHealth, douyinHealth] = await Promise.all([checkQq(), checkDouyin()])
      if (state.direction.douyinToQQ) {
        if (douyinHealth.ok) await tickDouyinToQq(result)
        else result.dq.note = '抖音不可用，跳过'
      } else {
        result.dq.note = '抖音→QQ 已关闭'
      }
      if (state.direction.qqToDouyin) {
        if (qqHealth.ok) await tickQqToDouyin(result, qqHealth.uin || selfUin)
        else result.qd.note = 'QQ 不可用，跳过'
      } else {
        result.qd.note = 'QQ→抖音 已关闭'
      }
    } catch (error) {
      result.errors.push(`同步异常：${String((error && error.message) || error)}`)
    } finally {
      tickBusy = false
    }
    await commit((draft) => {
      draft.stats.lastRunAt = nowIso()
      if (result.errors.length > 0) {
        draft.stats.errors += result.errors.length
        draft.lastError = clip(result.errors[0], 300)
      } else {
        draft.lastError = ''
      }
      // 空转不写日志：每 15 秒一条「本轮没有新消息」会把最近记录刷成噪音。
      const meaningful = result.dq.forwarded > 0 || result.qd.forwarded > 0 || result.errors.length > 0
      if (meaningful) {
        pushLog(draft, {
          at: nowIso(),
          dir: 'sys',
          ok: result.errors.length === 0,
          text: summarizeResult(result),
          note: result.errors.length ? clip(result.errors[0], 160) : '',
        })
      }
    })
    return { ok: result.errors.length === 0, ...result }
  }

  /** 抖音 → QQ。 */
  async function tickDouyinToQq(result) {
    const { douyin, onebot } = clients()
    const read = await douyin.read(state.douyin.sec_uid, state.douyin.nick)
    if (!read.ok) {
      result.errors.push(`抖音读私信：${read.error || '未知原因'}`)
      result.dq.note = '读不到私信'
      return
    }
    const messages = Array.isArray(read.data.messages) ? read.data.messages : []
    const picked = pickNewDouyin({
      messages,
      primed: state.cursors.dq.primed,
      lastAt: state.cursors.dq.lastAt,
      keys: state.cursors.dq.keys,
      // v0.6：默认跳过「分享视频/作品」卡片，不往 QQ 发
      skipCards: state.inbound.skipCards !== false,
    })
    // 对端健康顺手刷新（这轮刚真读过，别再额外探一次）
    const theirs = messages.filter((m) => m && m.from === 'them')
    const last = theirs.length ? theirs[theirs.length - 1] : null
    healthCache.peer = {
      ok: true,
      at: Date.now(),
      secUid: state.douyin.sec_uid,
      nick: String(read.data.to || state.douyin.nick || ''),
      count: theirs.length,
      lastThem: last ? String(last.text || '') : '',
      lastThemAt: last ? String(last.at || '') : '',
      error: '',
    }
    if (!state.cursors.dq.primed) {
      await commit((draft) => {
        draft.cursors.dq = picked.next
      })
      result.dq.note = '首轮对表（不补发历史消息）'
      return
    }
    if (picked.fresh.length === 0) {
      await commit((draft) => {
        draft.cursors.dq = picked.next
      })
      return
    }
    result.dq.found = picked.fresh.length
    const sentIds = []
    let forwarded = 0
    for (const message of picked.fresh.slice(0, MAX_FORWARD_PER_ROUND)) {
      const text = formatDouyinForQQ({
        nick: state.douyin.nick || healthCache.peer.nick || '抖音好友',
        text: message.text,
        kind: message.kind,
        item_id: message.item_id,
      })
      const sent = state.qq.kind === 'group'
        ? await onebot.sendGroup(state.qq.id, text)
        : await onebot.sendPrivate(state.qq.id, text)
      if (sent.ok) {
        forwarded += 1
        const messageId = sent.data !== null && typeof sent.data === 'object' ? sent.data.message_id : undefined
        if (messageId !== undefined && messageId !== null) sentIds.push(String(messageId))
        await commit((draft) => {
          pushLog(draft, { at: nowIso(), dir: 'dq', ok: true, text: clip(text, 160), note: '已发到 QQ' })
          addTranscript(draft, { side: 'douyin', text: message.text, kind: message.kind })
          draft.stats.dq += 1
          draft.stats.lastDqAt = nowIso()
        })
        // v0.4：卡片消息附上视频封面图（QQ 里能直接看到画面；QQ 的 AI 可用 qq_get_message_images 读）
        if (String(message.cover || '') !== '') {
          const imageSent = state.qq.kind === 'group'
            ? await onebot.sendGroupImage(state.qq.id, message.cover)
            : await onebot.sendPrivateImage(state.qq.id, message.cover)
          await commit((draft) => {
            pushLog(draft, {
              at: nowIso(),
              dir: 'dq',
              ok: imageSent.ok,
              text: clip(`[封面] ${message.text}`, 160),
              note: imageSent.ok ? '已发封面图到 QQ' : clip(`封面没发出：${imageSent.error || ''}`, 160),
            })
            if (imageSent.ok && imageSent.data !== null && typeof imageSent.data === 'object') {
              const imgId = imageSent.data.message_id
              if (imgId !== undefined && imgId !== null) {
                sentIds.push(String(imgId))
                // 把封面图的消息 id 写进共享记忆：QQ 的鱼可以据此直接调用 qq_get_message_images 看画面
                addTranscript(draft, {
                  side: 'douyin',
                  text: `（封面图 messageId=${imgId}，QQ 里的鱼可用 qq_get_message_images 读这张图看画面）`,
                })
              }
            } else if (!imageSent.ok) {
              draft.stats.errors += 1
            }
          })
          await sleep(QQ_SEND_GAP_MS)
        }
      } else {
        await commit((draft) => {
          pushLog(draft, { at: nowIso(), dir: 'dq', ok: false, text: clip(text, 160), note: clip(sent.error || 'QQ 发送失败', 160) })
          draft.stats.errors += 1
        })
        result.errors.push(`QQ 发送失败：${sent.error || '未知原因'}`)
      }
      await sleep(QQ_SEND_GAP_MS)
    }
    result.dq.forwarded = forwarded
    result.dq.skipped = Math.max(0, picked.fresh.length - forwarded)
    // 超出单轮上限的那几条：从「已见」里摘掉，并把水位回退到最后一条已转发消息，
    // 下一轮会重新挑到它们 —— 既不一屏刷爆 QQ，也不丢消息。
    const overflow = picked.fresh.slice(MAX_FORWARD_PER_ROUND)
    const next = { ...picked.next, keys: [...picked.next.keys] }
    if (overflow.length > 0) {
      const dropKeys = new Set(overflow.map((message) => douyinFingerprint(message)))
      next.keys = next.keys.filter((key) => !dropKeys.has(key))
      const lastForwarded = picked.fresh[Math.min(MAX_FORWARD_PER_ROUND, picked.fresh.length) - 1]
      if (lastForwarded && lastForwarded.at) next.lastAt = lastForwarded.at
      result.dq.note = `本轮上限 ${MAX_FORWARD_PER_ROUND} 条，剩 ${overflow.length} 条下一轮继续`
    }
    await commit((draft) => {
      draft.cursors.dq = next
      if (sentIds.length > 0) {
        draft.forwardedQqIds = [...sentIds, ...draft.forwardedQqIds].filter(Boolean).slice(0, 60)
      }
    })
  }

  /** QQ → 抖音。 */
  async function tickQqToDouyin(result, uin) {
    const { onebot } = clients()
    const read = state.qq.kind === 'group'
      ? await onebot.groupHistory(state.qq.id, QQ_HISTORY_COUNT)
      : await onebot.friendHistory(state.qq.id, QQ_HISTORY_COUNT)
    if (!read.ok) {
      result.errors.push(`QQ 读历史：${read.error || '未知原因'}`)
      result.qd.note = '读不到 QQ 历史'
      return
    }
    const messages = Array.isArray(read.data.messages) ? read.data.messages : []

    // ── v0.2：抖音链接处理（独立于 filter；链接消息不再当纯文本重复转发）──
    const linkSkipIds = []
    const linkScanEnabled = state.links.autoCard === true || state.links.autoOpen !== 'off'
    if (state.cursors.qq.primed && linkScanEnabled) {
      const seenIds = new Set(state.cursors.qq.ids.map(String))
      for (const raw of messages) {
        if (raw === null || typeof raw !== 'object') continue
        const messageId = String(raw.message_id ?? raw.real_id ?? '')
        if (messageId === '' || seenIds.has(messageId)) continue
        const sender = raw.sender !== null && typeof raw.sender === 'object' ? raw.sender : {}
        const senderId = String(sender.user_id ?? raw.user_id ?? '')
        if (senderId === String(uin || selfUin || '')) continue
        const text = textOf(raw.message)
        // 单独一句「要视频」：没有新链接时，补发最近 30 分钟内那条链接的视频
        if (!/douyin\.com/i.test(text)) {
          if (wantsVideoRequest(text)) {
            const recentMap = state.linkRecent !== null && typeof state.linkRecent === 'object' ? state.linkRecent : {}
            const latest = Object.entries(recentMap)
              .filter(([k]) => /^\d{19}$/.test(String(k)))
              .sort((a, b) => Number(b[1]) - Number(a[1]))[0]
            if (latest !== undefined && Date.now() - Number(latest[1]) < 30 * 60 * 1000) {
              enqueueLinkJob({ aweme_id: String(latest[0]), display: text, wantsVideo: true })
              await commit((draft) => pushLog(draft, {
                at: nowIso(),
                dir: 'sys',
                ok: true,
                text: clip(`[要视频] ${text}`, 160),
                note: '按最近一条链接补发视频',
              }))
            }
          }
          continue
        }
        if (extractTargets(text).length === 0) continue
        linkSkipIds.push(messageId)
        const queued = await enqueueMessageLinks(raw)
        if (queued > 0) {
          await commit((draft) => pushLog(draft, {
            at: nowIso(),
            dir: 'sys',
            ok: true,
            text: clip(`[链接] ${text}`, 160),
            note: `识别到抖音链接 ${queued} 条，已排进处理队列`,
          }))
        }
      }
    }

    // 引用判定兜底：reply 段 id 不认识时，用 get_msg 看被引消息原文是不是我们转过去的那条。
    const quotedOk = []
    if (state.filter === 'quote') {
      const unknownIds = []
      for (const raw of messages) {
        if (raw === null || typeof raw !== 'object') continue
        const replyId = replyToIdOf(raw.message)
        if (replyId === null) continue
        if (state.forwardedQqIds.includes(replyId)) continue
        if (!unknownIds.includes(replyId)) unknownIds.push(replyId)
      }
      for (const replyId of unknownIds.slice(0, 3)) {
        const got = await onebot.getMsg(replyId)
        if (!got.ok) continue
        const data = got.data !== null && typeof got.data === 'object' ? got.data : {}
        const rawText = String(data.raw_message ?? '') || textOf(data.message)
        if (looksLikeForwardedMark(rawText)) quotedOk.push(replyId)
      }
    }

    const picked = pickQqIngest({
      messages,
      selfUin: String(uin || selfUin || ''),
      primed: state.cursors.qq.primed,
      lastTime: state.cursors.qq.lastTime,
      ids: state.cursors.qq.ids,
      filter: state.filter,
      prefix: state.prefix,
      forwardedIds: state.forwardedQqIds,
      quotedOk,
      skipIds: linkSkipIds,
      limit: MAX_FORWARD_PER_ROUND,
    })
    if (!state.cursors.qq.primed) {
      await commit((draft) => {
        draft.cursors.qq = picked.next
      })
      result.qd.note = '首轮对表（不补发历史消息）'
      return
    }
    if (picked.items.length === 0) {
      await commit((draft) => {
        draft.cursors.qq = picked.next
      })
      if (picked.filtered > 0) result.qd.note = `过滤掉 ${picked.filtered} 条（规则：${state.filter}）`
      return
    }
    result.qd.found = picked.items.length
    let forwarded = 0
    for (const item of picked.items) {
      const sent = await enqueueDouyinSend(item.text)
      if (sent.ok) {
        forwarded += 1
        await commit((draft) => {
          pushLog(draft, { at: nowIso(), dir: 'qd', ok: true, text: clip(item.text, 160), note: `→ 抖音（${labelOfVia(item.via)}）` })
          addTranscript(draft, { side: 'qq', text: item.text })
          draft.stats.qd += 1
          draft.stats.lastQdAt = nowIso()
        })
      } else {
        await commit((draft) => {
          pushLog(draft, { at: nowIso(), dir: 'qd', ok: false, text: clip(item.text, 160), note: clip(sent.error || '抖音发送失败', 160) })
          draft.stats.errors += 1
        })
        result.errors.push(`抖音发送失败：${sent.error || '未知原因'}`)
      }
    }
    result.qd.forwarded = forwarded
    result.qd.skipped = Math.max(0, picked.items.length - forwarded + picked.overLimit)
    // 同理：超出单轮上限的 QQ 消息从「已处理」里摘掉，下一轮继续转。
    const next = { ...picked.next, ids: [...picked.next.ids] }
    const overflow = Array.isArray(picked.overflowItems) ? picked.overflowItems : []
    if (overflow.length > 0) {
      const dropIds = new Set(overflow.map((item) => String(item.id)))
      next.ids = next.ids.filter((id) => !dropIds.has(id))
      result.qd.note = `本轮上限 ${MAX_FORWARD_PER_ROUND} 条，剩 ${overflow.length} 条下一轮继续`
    }
    await commit((draft) => {
      draft.cursors.qq = next
    })
  }

  /** 抖音发送串行队列（无头 Chrome 同一时刻只允许一个）。 */
  function enqueueDouyinSend(text) {
    const content = clip(text, MAX_TEXT)
    const run = async () => {
      // 每次现取客户端：端点/登录态可能变了
      const { douyin } = clients()
      const first = await douyin.send(state.douyin.sec_uid, state.douyin.nick, content)
      if (first.ok) return first
      // 浏览器掉登录时发送器会「没返回可解析结果」；自动把 Cookie 灌回无头浏览器后重试一次
      if (!/发送器没返回|浏览器|登录|扫码|超时|没响应/.test(String(first.error || ''))) return first
      const login = await ensureBrowserLogin({ tools: douyinTools() })
      if (login.ok !== true) return first
      return douyin.send(state.douyin.sec_uid, state.douyin.nick, content)
    }
    const next = douyinSendChain.then(run, run)
    douyinSendChain = next.then(() => undefined, () => undefined)
    return next
  }

  // ---------------------------------------------------------------------------
  // 抖音内容能力（复用「刷抖音」插件的脚本，不自己开浏览器）
  // ---------------------------------------------------------------------------

  /** 发现「刷抖音」插件目录 / python / node（缓存 60s）。 */
  function douyinTools(force = false) {
    const now = Date.now()
    if (!force && douyinToolsCache !== null && now - douyinToolsCache.at < 60_000) return douyinToolsCache.value
    const value = discoverDouyinTools()
    douyinToolsCache = { at: now, value }
    return value
  }

  /**
   * 查一条抖音视频：详情（~1–3s）+ 热评（~10–20s，可选）。
   * @param {{ awemeId: string, wantComments?: boolean, commentLimit?: number }} input
   */
  async function queryVideo(input) {
    const awemeId = String(input.awemeId || '').trim()
    if (awemeId === '') return { ok: false, error: 'aweme_id 是空的' }
    const tools = douyinTools()
    if (tools.ok !== true) return { ok: false, error: tools.error }
    const detail = await fetchVideoDetail(awemeId, { tools })
    const limit = Math.max(1, Math.min(Number(input.commentLimit) || 8, 20))
    const comments = input.wantComments === false ? { ok: false, error: '跳过评论' } : await fetchComments(awemeId, { tools, limit })
    if (!detail.ok && !comments.ok) {
      return { ok: false, error: [detail.error, comments.error].filter(Boolean).join('；') }
    }
    const video = detail.ok ? detail.video : null
    const parsed = comments.ok ? comments.parsed : null
    return {
      ok: true,
      aweme_id: awemeId,
      canonical: video !== null && video.canonical ? video.canonical : canonicalVideoUrl(awemeId),
      video,
      comments: parsed,
      text: formatVideoDigest(video, parsed, { limit }),
      warn: !detail.ok ? String(detail.error || '视频详情没取到') : (!comments.ok ? String(comments.error || '评论没取到') : ''),
    }
  }

  /**
   * 拉一轮「抖音上刷到的视频」（推荐流），可选拉热评、可选直接发到绑定的 QQ 会话。
   * @param {{ top?: number, withComments?: number, push?: boolean, commentLimit?: number }} [input]
   */
  async function queryFeed(input = {}) {
    const tools = douyinTools()
    if (tools.ok !== true) return { ok: false, error: tools.error }
    const top = Math.max(1, Math.min(Number(input.top) || 5, 10))
    const feed = await fetchFeed({ top, tools })
    if (feed.ok !== true) return feed
    const withComments = Math.max(0, Math.min(Number(input.withComments) || 0, 2))
    const commentLimit = Math.max(1, Math.min(Number(input.commentLimit) || 5, 10))
    const rows = []
    for (let index = 0; index < feed.rows.length; index++) {
      const row = { ...feed.rows[index] }
      if (index < withComments) {
        const commentRes = await fetchComments(row.aweme_id, { tools, limit: commentLimit })
        if (commentRes.ok) {
          row.top_comments = commentRes.parsed.comments.slice(0, 5).map((c) => ({ nick: c.nick, text: c.text, digg: c.digg }))
        }
      }
      rows.push(row)
    }
    let pushed = 0
    const notes = []
    if (input.push === true) {
      if (!isConfigured(state)) {
        return {
          ok: true,
          rows,
          pushed: 0,
          text: formatFeedDigest(rows, { limit: top }),
          warn: '想发到 QQ 需要先绑定 QQ 会话；这次只返回清单。',
        }
      }
      const { onebot } = clients()
      const count = Math.min(rows.length, 3)
      for (let index = 0; index < count; index++) {
        const row = rows[index]
        const text = formatFeedForQQ(row)
        const sent = state.qq.kind === 'group'
          ? await onebot.sendGroup(state.qq.id, text)
          : await onebot.sendPrivate(state.qq.id, text)
        if (sent.ok) {
          pushed += 1
          await commit((draft) => {
            pushLog(draft, { at: nowIso(), dir: 'dq', ok: true, text: clip(`[推荐] ${row.desc}`, 160), note: '已发到 QQ' })
            addTranscript(draft, { side: 'feed', text: `${row.desc} ${row.web_url}` })
            draft.stats.dq += 1
            draft.stats.lastDqAt = nowIso()
          })
        } else {
          await commit((draft) => {
            pushLog(draft, { at: nowIso(), dir: 'dq', ok: false, text: clip(`[推荐] ${row.desc}`, 160), note: clip(sent.error || 'QQ 发送失败', 160) })
            draft.stats.errors += 1
          })
          notes.push(`发到 QQ 失败：${sent.error || '未知原因'}`)
        }
        await sleep(QQ_SEND_GAP_MS)
      }
    }
    return {
      ok: true,
      rows,
      pushed,
      text: formatFeedDigest(rows, { limit: top }),
      ...(notes.length > 0 ? { warn: notes.join('；') } : {}),
    }
  }

  /**
   * 下载整段视频 + 抽帧 + 原声 + 本地语音转写 + 视觉大模型「画面理解」。
   * **不发任何消息**；返回 workDir，调用方负责 cleanupWorkDir。
   * @param {{ url?: string, aweme_id?: string, text?: string, frames?: number }} input
   */
  async function analyzeVideoMedia(input = {}) {
    const target = await resolveAwemeTarget({ url: input.url, aweme_id: input.aweme_id, text: input.text })
    if (target.ok !== true) return { ok: false, error: target.error }
    const tools = douyinTools()
    if (tools.ok !== true) return { ok: false, error: tools.error }
    const detail = await fetchVideoDetail(target.aweme_id, { tools })
    if (detail.ok !== true) return { ok: false, error: detail.error }
    const video = detail.video || null
    if (video === null || String(video.play_url || '') === '') {
      return { ok: false, error: '这条没有可下载地址（可能是图文，或视频已删除/被限流）' }
    }
    const workDir = makeWorkDir()
    const downloaded = await downloadDouyinVideo(video, { dir: workDir })
    if (downloaded.ok !== true) return { ok: false, error: downloaded.error, workDir }
    const media = await extractFramesAndAudio(downloaded.file, {
      tools,
      frames: Math.max(3, Math.min(Number(input.frames) || 6, 10)),
      outDir: join(workDir, 'out'),
    })
    if (media.ok !== true) return { ok: false, error: media.error, workDir }
    // 声音 → 文字（本地 Whisper）
    const asr = media.audio !== '' ? await transcribeAudio(media.audio, { tools }) : { ok: false, error: '视频没有音轨' }
    // 画面文字：qwen-vl-ocr（消耗 OCR 模型的免费额度；比 VLM 认字更准，也把它的额度用起来）
    const ocr = await ocrFrames({ frames: media.frames.slice(0, 4) })
    // 画面帧 + 文案 + 转写 + OCR 文字 → 视觉大模型（DashScope Qwen-VL，复用宿主环境变量里的 key）
    const vlm = await describeFrames({
      frames: media.frames,
      title: video.desc,
      author: video.author,
      transcript: asr.ok ? asr.text : '',
      captions: video.captions,
      ocrText: ocr.ok ? ocr.text : '',
    })
    return { ok: true, workDir, video, downloaded, media, asr, ocr, vlm }
  }

  /** 把「分析结果」拼成给模型看的几行文字（watch / describe 共用）。 */
  function formatAnalysisLines(analysis, options = {}) {
    const { video, media, asr, ocr, vlm } = analysis
    const title = String(video.desc || '').replace(/\s+/g, ' ').slice(0, 80)
    const seconds = Math.max(1, Math.round(Number(media.duration) || Number(video.duration_ms) / 1000))
    const lines = [
      `${options.header || '【视频理解】'}${title || '（无文案）'}`,
      `@${video.author || '未知'} · ${seconds}s · 赞${formatCount(video.digg)} 评${formatCount(video.comment_count)}`,
    ]
    if (vlm && vlm.ok) {
      lines.push(`画面理解（视频大模型 ${vlm.model}，基于 ${media.frames.length} 张抽样帧）：${vlm.text.slice(0, 1200)}`)
    } else {
      lines.push(`视频大模型没接上：${(vlm && vlm.error) || '未知原因'}`)
    }
    if (ocr && ocr.ok && ocr.text !== '') {
      lines.push(`画面文字（OCR ${ocr.model}）：${ocr.text.replace(/\s+/g, ' ').slice(0, 500)}`)
    }
    const captions = Array.isArray(video.captions) ? video.captions.filter(Boolean) : []
    if (asr.ok && asr.text !== '') {
      lines.push(`声音转写（本地 Whisper ${asr.model || ''}）：${asr.text.slice(0, 800)}`)
    } else if (captions.length > 0) {
      lines.push(`抖音自动字幕（声音内容）：${captions.join(' ').slice(0, 800)}`)
    } else {
      lines.push(`声音没能转成文字（${asr.error || '无字幕'}）`)
    }
    return lines
  }

  /**
   * 「只看不搬」：分析整段视频（画面理解 + 声音转写），**不往 QQ 发任何消息**。
   * @param {{ url?: string, aweme_id?: string, text?: string, frames?: number }} input
   */
  async function describeVideo(input = {}) {
    const analysis = await analyzeVideoMedia(input)
    try {
      if (analysis.ok !== true) return { ok: false, error: analysis.error }
      const lines = formatAnalysisLines(analysis)
      return {
        ok: true,
        video: analysis.video,
        vision: analysis.vlm && analysis.vlm.ok ? analysis.vlm.text : '',
        asr: analysis.asr && analysis.asr.ok ? analysis.asr.text : '',
        text: lines.join('\n'),
      }
    } finally {
      cleanupWorkDir(analysis.workDir)
    }
  }

  /**
   * 「搬整段视频」：把完整 mp4 发到 QQ（用户能看动态+听原声），再抽 N 帧发到 QQ
   * （QQ 里的鱼可用 qq_get_message_images 逐帧看），原声再发一条语音。
   * 返回里还附「视频大模型」对抽样帧的画面理解 + 本地 Whisper 声音转写。
   * @param {{ url?: string, aweme_id?: string, text?: string, frames?: number }} input
   */
  async function watchVideo(input = {}) {
    if (!isConfigured(state)) return { ok: false, error: '要把视频搬进 QQ，需要先绑定 QQ 会话' }
    const analysis = await analyzeVideoMedia(input)
    /** @type {{ video: string | null, frames: string[], audio: string | null, errors: string[] }} */
    const sent = { video: null, frames: [], audio: null, errors: [] }
    try {
      if (analysis.ok !== true) return { ok: false, error: analysis.error }
      const { video, downloaded, media, asr, vlm } = analysis
      const { onebot } = clients()
      const group = state.qq.kind === 'group'
      const videoRes = group
        ? await onebot.sendGroupVideo(state.qq.id, downloaded.file)
        : await onebot.sendPrivateVideo(state.qq.id, downloaded.file)
      if (videoRes.ok && videoRes.data !== null && typeof videoRes.data === 'object' && videoRes.data.message_id !== undefined) {
        sent.video = String(videoRes.data.message_id)
      } else {
        sent.errors.push(`完整视频没发出：${videoRes.error || '未知原因'}`)
      }
      await sleep(QQ_SEND_GAP_MS)
      for (const frame of media.frames.slice(0, 8)) {
        const r = group
          ? await onebot.sendGroupImage(state.qq.id, frame)
          : await onebot.sendPrivateImage(state.qq.id, frame)
        if (r.ok && r.data !== null && typeof r.data === 'object' && r.data.message_id !== undefined) {
          sent.frames.push(String(r.data.message_id))
        } else {
          sent.errors.push(`画面帧没发出：${r.error || '未知原因'}`)
        }
        await sleep(QQ_SEND_GAP_MS)
      }
      if (media.audio !== '') {
        const audioRes = group
          ? await onebot.sendGroupVoice(state.qq.id, media.audio)
          : await onebot.sendPrivateVoice(state.qq.id, media.audio)
        if (audioRes.ok && audioRes.data !== null && typeof audioRes.data === 'object' && audioRes.data.message_id !== undefined) {
          sent.audio = String(audioRes.data.message_id)
        } else {
          sent.errors.push(`原声语音没发出：${audioRes.error || '未知原因'}`)
        }
      }
      const title = String(video.desc || '').replace(/\s+/g, ' ').slice(0, 80)
      const lines = formatAnalysisLines(analysis, { header: '【整段视频已搬进 QQ】' })
      lines.push(`完整视频消息：${sent.video || '（失败）'}；原声语音：${sent.audio || '（无）'}；画面帧：${sent.frames.length} 张`)
      if (sent.frames.length > 0) {
        lines.push(`帧消息 id：${sent.frames.join(', ')}（QQ 里的鱼可用 qq_get_message_images 逐帧复核画面）`)
      }
      if (sent.errors.length > 0) lines.push(`部分失败：${sent.errors.join('；')}`)
      const asrNote = asr.ok && asr.text !== '' ? `；声音转写「${asr.text.slice(0, 60)}」` : ''
      const visionNote = vlm && vlm.ok ? ' · 画面理解 ✓' : ''
      await commit((draft) => {
        pushLog(draft, {
          at: nowIso(),
          dir: 'dq',
          ok: sent.errors.length === 0,
          text: clip(`[整段视频] ${title}`, 160),
          note: `视频 ${sent.video ? '✓' : '✗'} · 帧 ${sent.frames.length} 张 · 原声 ${sent.audio ? '✓' : '—'}${visionNote}${asr.ok && asr.text !== '' ? ' · 转写 ✓' : ''}`,
        })
        addTranscript(draft, { side: 'douyin', text: `（整段视频已搬进 QQ：${title}；帧 ${sent.frames.length} 张；原声语音 ${sent.audio || '无'}${asrNote}${visionNote}）` })
        if (sent.errors.length > 0) draft.stats.errors += sent.errors.length
      })
      return {
        ok: true,
        video,
        sent,
        vision: vlm && vlm.ok ? vlm.text : '',
        asr: asr.ok ? asr.text : '',
        text: lines.join('\n'),
      }
    } finally {
      cleanupWorkDir(analysis.workDir)
    }
  }

  /**
   * v0.7「发链接 → 直接得到视频」：只下载 MP4，把整段视频发回绑定的 QQ 会话（不抽帧、不转写）。
   * @param {string} awemeId
   * @returns {Promise<{ ok: boolean, title?: string, size_mb?: number, message_id?: string, error?: string }>}
   */
  async function sendVideoToQq(awemeId) {
    if (!isConfigured(state)) return { ok: false, error: '还没绑定 QQ 会话和抖音好友' }
    const { tools } = { tools: douyinTools() }
    if (tools.ok !== true) return { ok: false, error: tools.error }
    const detail = await fetchVideoDetail(awemeId, { tools })
    if (detail.ok !== true) return { ok: false, error: detail.error }
    const video = detail.video || null
    if (video === null || String(video.play_url || '') === '') {
      return { ok: false, error: '这条没有可下载地址（可能是图文，或视频已删除/被限流）' }
    }
    const workDir = makeWorkDir()
    try {
      const downloaded = await downloadDouyinVideo(video, { dir: workDir })
      if (downloaded.ok !== true) return { ok: false, error: downloaded.error }
      const { onebot } = clients()
      const group = state.qq.kind === 'group'
      const sent = group
        ? await onebot.sendGroupVideo(state.qq.id, downloaded.file)
        : await onebot.sendPrivateVideo(state.qq.id, downloaded.file)
      if (sent.ok !== true) return { ok: false, error: `视频没发出：${sent.error || '未知原因'}` }
      const title = String(video.desc || '').replace(/\s+/g, ' ').slice(0, 80)
      const sizeMb = Math.round((downloaded.bytes / 1024 / 1024) * 10) / 10
      const messageId = sent.data !== null && typeof sent.data === 'object' && sent.data.message_id !== undefined
        ? String(sent.data.message_id)
        : ''
      await commit((draft) => {
        pushLog(draft, {
          at: nowIso(),
          dir: 'qd',
          ok: true,
          text: clip(`[视频] ${title}`, 160),
          note: `已把视频发到 QQ（${sizeMb} MB）`,
        })
        addTranscript(draft, { side: 'link', text: `下载视频并发到 QQ：${title} ${canonicalVideoUrl(awemeId)}` })
      })
      return { ok: true, title, size_mb: sizeMb, message_id: messageId }
    } finally {
      cleanupWorkDir(workDir)
    }
  }

  /** 队列里塞一个链接任务（发卡片 / 打开浏览器 / 发视频回 QQ）。 */
  function enqueueLinkJob(job) {
    if (linkQueue.length >= 20) return
    linkQueue.push(job)
    void processLinkQueue()
  }

  /** 串行处理链接任务，逐条写日志（不阻塞 QQ 轮询）。 */
  async function processLinkQueue() {
    if (linkQueueBusy) return
    linkQueueBusy = true
    try {
      while (linkQueue.length > 0) {
        const job = linkQueue.shift()
        try {
          if (job === undefined) continue
          const resolved = job.aweme_id
            ? { ok: true, aweme_id: job.aweme_id, canonical: job.canonical || canonicalVideoUrl(job.aweme_id) }
            : await resolveAwemeTarget({ url: job.short_url })
          if (resolved.ok !== true) {
            await commit((draft) => pushLog(draft, {
              at: nowIso(),
              dir: 'sys',
              ok: false,
              text: clip(job.display || job.short_url, 160),
              note: clip(resolved.error || '链接解析失败', 160),
            }))
            continue
          }
          const awemeId = resolved.aweme_id
          const link = resolved.canonical || canonicalVideoUrl(awemeId)
          const links = state.links
          let didSomething = false
          // ⓪ v0.7「发链接 → 直接得到视频」：只有用户明确说要视频时才发（默认不再自动发）
          if (links.fetchVideo !== false && job.wantsVideo === true) {
            const fetched = await sendVideoToQq(awemeId)
            didSomething = didSomething || fetched.ok
            if (!fetched.ok) {
              await commit((draft) => pushLog(draft, {
                at: nowIso(),
                dir: 'sys',
                ok: false,
                text: clip(`[视频] ${link}`, 160),
                note: clip(`视频没发出：${fetched.error || ''}`, 160),
              }))
            }
          }
          // ⓪.5 v0.11：QQ 链接自动「理解视频」——画面 + 画面文字 + 声音，结论发回 QQ 并写共享记忆
          if (links.autoUnderstand !== false) {
            const understood = await describeVideo({ aweme_id: awemeId, frames: 4 })
            didSomething = didSomething || understood.ok
            if (understood.ok === true) {
              const msg = `【抖音视频理解】\n${understood.text}`
              const { onebot } = clients()
              const sent = state.qq.kind === 'group'
                ? await onebot.sendGroup(state.qq.id, msg)
                : await onebot.sendPrivate(state.qq.id, msg)
              await commit((draft) => {
                pushLog(draft, {
                  at: nowIso(),
                  dir: 'dq',
                  ok: sent.ok,
                  text: clip(`[自动理解] ${understood.video ? understood.video.desc : link}`, 160),
                  note: sent.ok ? '视频理解已发回 QQ' : clip(`理解结论没发出：${sent.error || ''}`, 160),
                })
                if (sent.ok) {
                  addTranscript(draft, {
                    side: 'link',
                    text: `QQ 链接自动理解：${String(understood.vision || '').replace(/\s+/g, ' ').slice(0, 120)}`,
                  })
                }
              })
            } else {
              await commit((draft) => pushLog(draft, {
                at: nowIso(),
                dir: 'sys',
                ok: false,
                text: clip(`[自动理解] ${link}`, 160),
                note: clip(`理解失败：${understood.error || ''}`, 160),
              }))
            }
          }
          // ① 分享卡片发给绑定的抖音好友
          if (links.autoCard === true) {
            if (isConfigured(state)) {
              const card = await shareVideoCard(awemeId, { to: state.douyin.nick, toId: state.douyin.sec_uid })
              didSomething = didSomething || card.ok
              await commit((draft) => {
                pushLog(draft, {
                  at: nowIso(),
                  dir: 'qd',
                  ok: card.ok,
                  text: clip(`[链接卡片] ${link}`, 160),
                  note: card.ok ? '已发分享卡片到抖音' : `卡片没发出：${clip(card.error || '', 120)}`,
                })
                if (card.ok) addTranscript(draft, { side: 'link', text: `分享卡片：${link}` })
                if (!card.ok) draft.stats.errors += 1
              })
            } else {
              await commit((draft) => pushLog(draft, { at: nowIso(), dir: 'sys', ok: false, text: clip(link, 160), note: '跳过发卡片：还没绑定抖音好友' }))
            }
          }
          // ② 本机默认浏览器打开
          const openMode = state.links.autoOpen
          const openWanted = openMode === 'always' || (openMode === 'private' && state.qq.kind === 'private')
          if (openWanted) {
            const opened = openInBrowser(link)
            didSomething = didSomething || opened.ok
            await commit((draft) => pushLog(draft, {
              at: nowIso(),
              dir: 'sys',
              ok: opened.ok,
              text: clip(`[本机打开] ${link}`, 160),
              note: opened.ok ? '已在默认浏览器打开' : clip(opened.error || '打开失败', 120),
            }))
          }
          if (!didSomething) {
            await commit((draft) => pushLog(draft, { at: nowIso(), dir: 'sys', ok: false, text: clip(link, 160), note: '链接已识别，但卡片/打开都关着或不可用' }))
          }
        } catch (error) {
          logger(`链接任务出错：${String((error && error.message) || error)}`)
        }
      }
    } finally {
      linkQueueBusy = false
    }
  }

  /**
   * 把一条新 QQ 消息里的抖音链接排进队列（带冷却去重）。
   * @param {Record<string, any>} message
   * @returns {Promise<number>} 排进队列的条数
   */
  async function enqueueMessageLinks(message) {
    const text = textOf(message?.message)
    if (text === '' || !/douyin\.com/i.test(text)) return 0
    const targets = extractTargets(text)
    if (targets.length === 0) return 0
    if (state.links.autoCard !== true && state.links.autoOpen === 'off'
      && state.links.fetchVideo === false && state.links.autoUnderstand === false) return 0
    const cooldownMs = Math.max(10, Number(state.links.cooldownSec) || 60) * 1000
    const now = Date.now()
    const recent = state.linkRecent !== null && typeof state.linkRecent === 'object' ? state.linkRecent : {}
    let queued = 0
    for (const target of targets.slice(0, 3)) {
      if (queued >= 3) break
      const key = target.aweme_id ? String(target.aweme_id) : String(target.short_url || '')
      if (key === '') continue
      const last = Number(recent[key] || 0)
      if (last > 0 && now - last < cooldownMs) continue
      queued += 1
      await commit((draft) => {
        const next = { ...(draft.linkRecent || {}) }
        next[key] = now
        const entries = Object.entries(next).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 50)
        draft.linkRecent = Object.fromEntries(entries)
      })
      enqueueLinkJob({
        aweme_id: target.aweme_id,
        canonical: target.canonical,
        short_url: target.short_url,
        display: text,
        wantsVideo: wantsVideoRequest(text),
      })
    }
    return queued
  }

  // ---------------------------------------------------------------------------
  // 轮询定时器
  // ---------------------------------------------------------------------------

  /** 停掉轮询。 */
  function stopLoop() {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  /** 按当前 pollMs 重启轮询。 */
  function startLoop() {
    stopLoop()
    if (disposed) return
    timer = setInterval(() => {
      void runTick().catch(() => {})
    }, state.pollMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  ctx.effect(() => {
    startLoop()
    return () => {
      disposed = true
      stopLoop()
      if (kickTimer !== null) {
        clearTimeout(kickTimer)
        kickTimer = null
      }
    }
  }, 'dsh-qq-douyin-bridge: 轮询定时器')

  if (loaded.recovered) logger('状态文件损坏，已备份并回默认值')
  logger(`已挂载（状态：${join(bridgeHome(), 'state.json')}；${state.enabled ? '桥开着' : '桥关着'}）`)
  if (state.enabled && isConfigured(state)) {
    kickTimer = setTimeout(() => {
      void runTick().catch(() => {})
    }, 4_000)
    if (typeof kickTimer.unref === 'function') kickTimer.unref()
  }

  // ---------------------------------------------------------------------------
  // 操作：绑定 / 解绑 / 配置 / 手动发 / 对端列表
  // ---------------------------------------------------------------------------

  /** 取抖音面板里的私信对象列表（慢接口），失败时退回本机记忆。 */
  async function listPeers() {
    const { douyin } = clients()
    const live = await douyin.dmPeople()
    if (live.ok) {
      const raw = Array.isArray(live.data.people) ? live.data.people : []
      const people = raw
        .filter((row) => row !== null && typeof row === 'object')
        .map((row) => ({
          nick: String(row.nick || ''),
          sec_uid: String(row.sec_uid || ''),
          has_id: row.has_id === true,
          is_group: row.is_group === true,
          duplicate: row.duplicate === true,
        }))
      return { ok: true, people, count: people.length, via: 'live' }
    }
    const memory = listDouyinMemoryPeers()
    if (memory.length > 0) {
      return { ok: true, people: memory, count: memory.length, via: 'memory', warning: `抖音面板列表读不到（${live.error}），这是本机聊过的人` }
    }
    return { ok: false, error: live.error || '读不到抖音会话列表', needLogin: live.needLogin === true }
  }

  /** 改配置（开关 / 方向 / 规则 / 前缀 / 间隔）。 */
  async function handleConfig(body) {
    const patch = body !== null && typeof body === 'object' ? body : {}
    const warnings = []
    if (typeof patch.enabled === 'boolean') state.enabled = patch.enabled
    if (patch.direction !== null && typeof patch.direction === 'object') {
      if (typeof patch.direction.douyinToQQ === 'boolean') state.direction.douyinToQQ = patch.direction.douyinToQQ
      if (typeof patch.direction.qqToDouyin === 'boolean') state.direction.qqToDouyin = patch.direction.qqToDouyin
    }
    if (patch.filter !== undefined) {
      if (!FILTERS.includes(String(patch.filter))) return { ok: false, error: `转发规则只能是 ${FILTERS.join(' / ')}` }
      state.filter = String(patch.filter)
    }
    if (patch.prefix !== undefined) state.prefix = clip(String(patch.prefix || '').trim(), 20) || DEFAULT_PREFIX
    if (patch.pollMs !== undefined) {
      const value = Math.round(Number(patch.pollMs) || 0)
      if (!Number.isFinite(value) || value < MIN_POLL_MS || value > MAX_POLL_MS) {
        return { ok: false, error: `同步间隔要在 ${MIN_POLL_MS / 1000}–${MAX_POLL_MS / 1000} 秒之间` }
      }
      if (value !== state.pollMs) {
        state.pollMs = value
        startLoop()
      }
    }
    if (patch.links !== null && typeof patch.links === 'object') {
      const incoming = patch.links
      if (typeof incoming.autoCard === 'boolean') state.links.autoCard = incoming.autoCard
      if (incoming.autoOpen !== undefined) {
        if (!['off', 'private', 'always'].includes(String(incoming.autoOpen))) {
          return { ok: false, error: 'autoOpen 只能是 off / private / always' }
        }
        state.links.autoOpen = String(incoming.autoOpen)
      }
      if (incoming.cooldownSec !== undefined) {
        const value = Math.round(Number(incoming.cooldownSec) || 0)
        if (!Number.isFinite(value) || value < 10 || value > 600) {
          return { ok: false, error: '链接冷却时间要在 10–600 秒之间' }
        }
        state.links.cooldownSec = value
      }
      if (incoming.fetchVideo !== undefined) {
        if (typeof incoming.fetchVideo !== 'boolean') return { ok: false, error: 'links.fetchVideo 只能是 true/false' }
        state.links.fetchVideo = incoming.fetchVideo
      }
      if (incoming.autoUnderstand !== undefined) {
        if (typeof incoming.autoUnderstand !== 'boolean') return { ok: false, error: 'links.autoUnderstand 只能是 true/false' }
        state.links.autoUnderstand = incoming.autoUnderstand
      }
    }
    // v0.6：抖音私信收进来时的过滤（skipCards：分享视频卡片不转 QQ）
    if (patch.inbound !== null && typeof patch.inbound === 'object') {
      const incoming = patch.inbound
      if (incoming.skipCards !== undefined) {
        if (typeof incoming.skipCards !== 'boolean') return { ok: false, error: 'inbound.skipCards 只能是 true/false' }
        state.inbound.skipCards = incoming.skipCards
      }
    }
    if (state.enabled && !isConfigured(state)) warnings.push('桥已打开，但还没绑定 QQ 会话和抖音好友，暂时不会转发。')
    await commit((draft) => {
      pushLog(draft, { at: nowIso(), dir: 'sys', ok: true, text: '配置已更新', note: '' })
    })
    return { ok: true, state: publicState(state, describeBases()), ...(warnings.length ? { warnings } : {}) }
  }

  /** 绑定 QQ 会话 ↔ 抖音好友。 */
  async function handleBind(body) {
    const patch = body !== null && typeof body === 'object' ? body : {}
    const qqKind = patch.qq_kind === 'group' ? 'group' : 'private'
    const qqId = String(patch.qq_id ?? '').replace(/\D/g, '')
    if (!/^\d{5,12}$/.test(qqId)) return { ok: false, error: 'QQ 号 / 群号应该是 5–12 位数字' }
    const secUid = String(patch.douyin_sec_uid ?? '').trim()
    if (secUid.length < 6) return { ok: false, error: '抖音 sec_uid 不对（在抖音里点「读取会话列表」拿，别手猜）' }
    if (patch.filter !== undefined && !FILTERS.includes(String(patch.filter))) {
      return { ok: false, error: `转发规则只能是 ${FILTERS.join(' / ')}` }
    }

    // ① QQ 侧先验通
    const qqHealth = await checkQq(true)
    if (!qqHealth.ok) return { ok: false, error: `QQ 侧连不上：${qqHealth.error || '未知原因'}` }

    // ② 抖音侧验登录
    const douyinHealth = await checkDouyin(true)
    if (!douyinHealth.ok) return { ok: false, error: `抖音侧不可用：${douyinHealth.error || '未知原因'}`, needLogin: douyinHealth.loggedIn !== true }
    if (douyinHealth.loggedIn !== true) return { ok: false, error: '抖音还没登录：先到「设置 → 刷抖音」扫码登录', needLogin: true }

    // ③ 试读一次对端：读不到就不让绑定（除非显式 force）
    const nick = String(patch.douyin_nick ?? '').trim()
    let preview = null
    if (patch.force !== true) {
      const { douyin } = clients()
      const probe = await douyin.read(secUid, nick)
      if (!probe.ok) {
        return {
          ok: false,
          error: `读不到这位好友的私信：${probe.error || '未知原因'}`,
          detail: '确认 sec_uid 是「已经聊过天」的那个人（陌生人会话读不到）；确定没问题可以强制绑定。',
          canForce: true,
        }
      }
      const messages = Array.isArray(probe.data.messages) ? probe.data.messages : []
      const theirs = messages.filter((m) => m && m.from === 'them')
      const last = theirs.length ? theirs[theirs.length - 1] : null
      preview = {
        peer_nick: String(probe.data.to || nick || ''),
        them_count: theirs.length,
        last_them_text: last ? String(last.text || '') : '',
      }
    }

    const peerNick = String(preview?.peer_nick || nick || '').trim()
    await commit((draft) => {
      draft.qq = { kind: qqKind, id: qqId, label: clip(String(patch.qq_label ?? '').trim(), 60) }
      draft.douyin = { sec_uid: secUid, nick: peerNick }
      if (patch.filter !== undefined) draft.filter = String(patch.filter)
      if (patch.prefix !== undefined) draft.prefix = clip(String(patch.prefix || '').trim(), 20) || DEFAULT_PREFIX
      if (patch.direction !== null && typeof patch.direction === 'object') {
        if (typeof patch.direction.douyinToQQ === 'boolean') draft.direction.douyinToQQ = patch.direction.douyinToQQ
        if (typeof patch.direction.qqToDouyin === 'boolean') draft.direction.qqToDouyin = patch.direction.qqToDouyin
      }
      // 重新绑定 = 重新对表（别把旧水位带过来）
      draft.cursors.dq = { primed: false, lastAt: '', keys: [] }
      draft.cursors.qq = { primed: false, lastTime: 0, ids: [] }
      draft.forwardedQqIds = []
      pushLog(draft, {
        at: nowIso(),
        dir: 'sys',
        ok: true,
        text: `已绑定：抖音「${peerNick || secUid.slice(0, 10)}」 ↔ QQ ${qqKind === 'group' ? '群' : ''}${qqId}`,
        note: '',
      })
    })
    healthCache.peer = null
    return { ok: true, state: publicState(state, describeBases()), preview }
  }

  /** 解绑。 */
  async function handleUnbind() {
    await commit((draft) => {
      draft.enabled = false
      draft.douyin = { sec_uid: '', nick: '' }
      draft.qq = { kind: 'private', id: '', label: '' }
      draft.cursors.dq = { primed: false, lastAt: '', keys: [] }
      draft.cursors.qq = { primed: false, lastTime: 0, ids: [] }
      draft.forwardedQqIds = []
      pushLog(draft, { at: nowIso(), dir: 'sys', ok: true, text: '已解绑，桥也关了', note: '' })
    })
    healthCache.peer = null
    return { ok: true, state: publicState(state, describeBases()) }
  }

  /** 手动发一条（QQ 或抖音）。发送类操作必须 `confirm === true`。 */
  async function handleSend(body) {
    const patch = body !== null && typeof body === 'object' ? body : {}
    const side = patch.side === 'douyin' ? 'douyin' : 'qq'
    const text = clip(String(patch.text ?? '').trim(), MAX_TEXT)
    if (text === '') return { ok: false, error: '正文是空的' }
    if (patch.confirm !== true) return { ok: false, needsConfirm: true, draft: text, side }
    if (side === 'qq') {
      if (String(state.qq.id || '') === '') return { ok: false, error: '还没绑定 QQ 会话' }
      const { onebot } = clients()
      const sent = state.qq.kind === 'group'
        ? await onebot.sendGroup(state.qq.id, text)
        : await onebot.sendPrivate(state.qq.id, text)
      if (!sent.ok) return { ok: false, error: sent.error || 'QQ 发送失败' }
      await commit((draft) => {
        pushLog(draft, { at: nowIso(), dir: 'qd', ok: true, text: clip(`[手动] ${text}`, 160), note: '手动发到 QQ' })
        addTranscript(draft, { side: 'sys', text: `手动发到 QQ：${text}` })
      })
      return { ok: true, sent: true, side, detail: sent.data }
    }
    if (String(state.douyin.sec_uid || '') === '') return { ok: false, error: '还没绑定抖音好友' }
    const sent = await enqueueDouyinSend(text)
    if (!sent.ok) return { ok: false, error: sent.error || '抖音发送失败' }
    await commit((draft) => {
      pushLog(draft, { at: nowIso(), dir: 'dq', ok: true, text: clip(`[手动] ${text}`, 160), note: '手动发到抖音' })
      addTranscript(draft, { side: 'sys', text: `手动发到抖音：${text}` })
    })
    return { ok: true, sent: true, side, detail: sent.data }
  }

  /** 给公共状态补充端点信息（不把 token 放进去）。 */
  function describeBases() {
    const base = bases()
    return { qqApiBase: base.qqApiBase, douyinApiBase: base.douyinApiBase, storePath: base.storePath }
  }

  /** 完整的状态响应（设置页 `/state`）。 */
  async function handleState() {
    return {
      ok: true,
      state: publicState(state, describeBases()),
      health: await buildHealth(),
      log: state.log.slice(0, 20),
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP 路由（设置页用；全部同源认证）
  // ---------------------------------------------------------------------------

  /** @type {Array<{ method: 'GET'|'POST', suffix: string, action: string }>} */
  const routeTable = [
    { method: 'GET', suffix: '/state', action: 'state' },
    { method: 'POST', suffix: '/config', action: 'config' },
    { method: 'POST', suffix: '/bind', action: 'bind' },
    { method: 'POST', suffix: '/unbind', action: 'unbind' },
    { method: 'POST', suffix: '/sync', action: 'sync' },
    { method: 'POST', suffix: '/test', action: 'test' },
    { method: 'POST', suffix: '/send', action: 'send' },
    { method: 'GET', suffix: '/peers', action: 'peers' },
    { method: 'GET', suffix: '/log', action: 'log' },
  ]

  ctx.effect(() => {
    const disposers = routeTable.map((route) => ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}${route.suffix}`,
      handler: (req, res) => {
        void handleRoute(req, res, route)
      },
    }))
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 已释放就算了 */
        }
      }
    }
  }, 'dsh-qq-douyin-bridge: 设置页路由')

  /**
   * 一条 HTTP 请求：认证 → 读 body → 分发 → 答 JSON。
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {{ method: 'GET'|'POST', suffix: string, action: string }} route
   */
  async function handleRoute(req, res, route) {
    try {
      const rejection = ctx.connection.requestRejection({ headers: req.headers })
      if (rejection !== undefined) {
        writeJson(res, rejection, { ok: false, error: '请求未通过本机连接认证' })
        return
      }
      if (req.method !== route.method) {
        writeJson(res, 405, { ok: false, error: `仅支持 ${route.method} 请求` })
        return
      }
      let body = {}
      if (route.method === 'POST') {
        const contentType = String(req.headers['content-type'] || '').toLowerCase()
        if (!contentType.startsWith('application/json')) {
          writeJson(res, 415, { ok: false, error: '请求必须是 application/json' })
          return
        }
        const raw = await readBody(req)
        if (raw.trim() !== '') {
          try {
            body = JSON.parse(raw)
          } catch {
            writeJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
            return
          }
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          writeJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象' })
          return
        }
      }
      writeJson(res, 200, await dispatch(route.action, body))
    } catch (error) {
      logger(`路由 ${route.suffix} 出错：${String((error && error.message) || error)}`)
      writeJson(res, 200, { ok: false, error: `内部错误：${String((error && error.message) || error)}` })
    }
  }

  /**
   * 分发一条业务动作。
   * @param {string} action
   * @param {Record<string, any>} body
   */
  async function dispatch(action, body) {
    switch (action) {
      case 'state':
        return await handleState()
      case 'config':
        return await handleConfig(body)
      case 'bind':
        return await handleBind(body)
      case 'unbind':
        return await handleUnbind()
      case 'sync': {
        const result = await runTick({ manual: true })
        return { ok: true, state: publicState(state, describeBases()), result }
      }
      case 'test': {
        const health = await buildHealth(true)
        return { ok: true, checks: { qq: health.qq, douyin: health.douyin, peer: health.peer }, state: publicState(state, describeBases()) }
      }
      case 'send':
        return await handleSend(body)
      case 'peers':
        return await listPeers()
      case 'log':
        return { ok: true, log: state.log.slice(0, 50) }
      default:
        return { ok: false, error: `未知动作：${action}` }
    }
  }

  // ---------------------------------------------------------------------------
  // Agent 工具
  // ---------------------------------------------------------------------------

  ctx.effect(() => ctx.tools.register({
    name: 'qq_douyin_bridge',
    description: [
      'QQ × 抖音桥：把一个 QQ 会话和一位抖音好友的私信接成一条双向通道。',
      '抖音发来的私信会以「【抖音·昵称】…」转进 QQ；QQ 里按规则回复的话会发回抖音。',
      '用之前先 status 看现状（绑定、开关、两侧是否可用）。',
      'action 取值：',
      '- status：看绑定、开关、QQ/抖音是否可用、累计转发条数、最近几条记录。',
      '- bind：绑定，参数 qq_kind（private/group）、qq_id（QQ号/群号）、douyin_sec_uid、douyin_nick（可选）、',
      '  filter（all/quote/prefix，可选，默认 quote=只转引用回复）、prefix（可选）、force（读不到对端的私信时强制绑）。',
      '- unbind：解绑并关桥。',
      '- enable：开关桥，参数 enabled（true/false）。',
      '- sync：立即同步一轮，返回这一轮转了几条、有没有报错。',
      '- peers：列抖音里聊过的人（昵称 + sec_uid，慢，最多 40 秒）。',
      '- send：手动发一条，参数 side（qq/douyin）、text、confirm（必须 true，要用户当场同意）。',
      '- video / comments：查一条抖音视频的详情 / 热评，参数 url（抖音链接，短链也认）、aweme_id 或 text（含链接的一段文字）；',
      '  参数 limit 控制热评条数（默认 info 6 条、comments 10 条）。只读，不发任何东西。',
      '- open：在本机默认浏览器打开这条抖音视频（参数 url / aweme_id），仅在用户明确要求时用。',
      '- fetch_video：⭐ 「要视频才发」：只下载 MP4 并把整段视频发回绑定的 QQ 会话（不抽帧、不转写），',
      '  参数 url / aweme_id / text；只在用户明确要视频时才用，QQ 里发链接不再自动发视频。',
      '- share_card：把这条视频以「抖音分享卡片」发给绑定的抖音好友（抖音里文字链接点不开，卡片能点）；',
      '  参数 url / aweme_id + confirm（必须 true，要用户当场同意，否则只回预览）。',
      '- link_config：改「QQ 里出现抖音链接」的自动处理，参数 links（{autoCard,autoOpen,cooldownSec,fetchVideo,autoUnderstand}）。',
      '- inbound_config：改「抖音私信转进 QQ」的过滤，参数 inbound（{skipCards}）：skipCards=true（默认）时',
      '  抖音好友发来的「分享视频/作品卡片」不转进 QQ；false 则照常转（带链接+封面）。',
      '- vlm_status：视频大模型「逐个模型体检」——按便宜→贵顺序每个模型发一条最小请求，',
      '  告诉你哪个可用/哪个免费额度没开或已用完；参数 vlm_reset（可选，true=清掉冷却记录）、vlm_models（可选，指定模型列表）。',
      '- log：最近记录，参数 limit（默认 10）。',
      '注意：绑定需要抖音已登录、且对方是「已经聊过天」的人（陌生人会话读不到）；QQ 侧用的是本机 QQ 桥接里的机器人账号。',
      '如果只是想知道一条视频讲了什么/评论怎么说，用只读的 video/comments；不要为了看一眼就去分享。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'bind', 'unbind', 'enable', 'sync', 'peers', 'send', 'log', 'video', 'comments', 'open', 'share_card', 'fetch_video', 'link_config', 'inbound_config', 'vlm_status'],
          description: '要执行的操作。',
        },
        qq_kind: { type: 'string', enum: ['private', 'group'], description: 'bind：QQ 侧是私聊还是群。' },
        qq_id: { type: 'string', description: 'bind：好友 QQ 号或群号（纯数字）。' },
        qq_label: { type: 'string', description: 'bind：QQ 侧显示名（可选）。' },
        douyin_sec_uid: { type: 'string', description: 'bind：抖音好友的 sec_uid（稳定 id，不是昵称）。' },
        douyin_nick: { type: 'string', description: 'bind：抖音好友昵称（只用于显示）。' },
        filter: { type: 'string', enum: FILTERS, description: 'bind/config：QQ→抖音 的转发规则。' },
        prefix: { type: 'string', description: 'bind：filter=prefix 时使用的前缀（默认「回：」）。' },
        force: { type: 'boolean', description: 'bind：读不到对方私信时也强制绑定。' },
        enabled: { type: 'boolean', description: 'enable：开关桥。' },
        side: { type: 'string', enum: ['qq', 'douyin'], description: 'send：发给哪一边。' },
        text: { type: 'string', description: 'send：正文；video/comments/fetch_video：含抖音链接的一段文字。' },
        url: { type: 'string', description: 'video/comments/open/share_card/fetch_video：抖音视频链接（完整链接或 v.douyin.com 短链）。' },
        aweme_id: { type: 'string', description: 'video/comments/open/share_card/fetch_video：抖音视频 ID（19 位数字）。' },
        links: {
          type: 'object',
          description: 'link_config：链接自动处理设置。',
          properties: {
            autoCard: { type: 'boolean', description: 'QQ 里出现抖音链接时自动发分享卡片给绑定的抖音好友。' },
            autoOpen: { type: 'string', enum: ['off', 'private', 'always'], description: '自动在本机浏览器打开：off/private/always。' },
            cooldownSec: { type: 'number', description: '同一视频的冷却秒数（10–600）。' },
            fetchVideo: { type: 'boolean', description: 'QQ 里出现抖音链接时，自动把视频（MP4）发回这个 QQ 会话（默认 true）。' },
            autoUnderstand: { type: 'boolean', description: 'QQ 里出现抖音链接时，自动做「视频理解」（画面+画面文字+声音）并把结论发回 QQ、写共享记忆（默认 true）。' },
          },
          additionalProperties: false,
        },
        inbound: {
          type: 'object',
          description: 'inbound_config：抖音私信转进 QQ 的过滤设置。',
          properties: {
            skipCards: { type: 'boolean', description: 'true（默认）= 抖音的「分享视频/作品卡片」不转进 QQ；false = 照常转。' },
          },
          additionalProperties: false,
        },
        vlm_reset: { type: 'boolean', description: 'vlm_status：true = 清掉所有模型的冷却记录（重新逐个试）。' },
        vlm_models: {
          type: 'array',
          items: { type: 'string' },
          description: 'vlm_status：只体检这些模型（默认按 QQDY_VLM_MODELS 或内置便宜→贵顺序）。',
        },
        confirm: { type: 'boolean', description: 'send / share_card：必须由用户当场同意后传 true，否则只回草稿。' },
        limit: { type: 'number', description: 'log：最多几条（默认 10，最多 50）；video/comments：热评条数。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: String((value && value.text) || '（没有结果）') }],
    },
    isConcurrencySafe: () => false,
    execute: async (rawArgs) => {
      const args = rawArgs !== null && typeof rawArgs === 'object' ? rawArgs : {}
      const action = String(args.action || '')
      try {
        switch (action) {
          case 'status': {
            const health = await buildHealth()
            const lines = [
              `桥：${state.enabled ? '开着' : '关着'}${isConfigured(state) ? '' : '（还没绑定）'}`,
              isConfigured(state)
                ? `绑定：抖音「${state.douyin.nick || state.douyin.sec_uid.slice(0, 10)}」 ↔ QQ ${state.qq.kind === 'group' ? '群 ' : '私聊 '}${state.qq.id}`
                : '绑定：无',
              `规则：${labelOfFilter(state.filter)}${state.filter === 'prefix' ? `（前缀「${state.prefix}」）` : ''}；方向：${state.direction.douyinToQQ ? '抖音→QQ' : ''}${state.direction.douyinToQQ && state.direction.qqToDouyin ? '、' : ''}${state.direction.qqToDouyin ? 'QQ→抖音' : ''}`,
              `QQ：${health.qq.ok ? `在线（${health.qq.nick || health.qq.uin}）` : `不可用（${health.qq.error}）`}`,
              `抖音：${health.douyin.ok ? `${health.douyin.loggedIn ? '已登录' : '未登录'}${health.douyin.nick ? `（${health.douyin.nick}）` : ''}` : `不可用（${health.douyin.error}）`}`,
              `对端：${health.peer.ok ? `可读，最近对方说「${clip(health.peer.lastThem, 40) || '（没有消息）'}」` : `读不到（${health.peer.error}）`}`,
              health.aiOverlap ? '提醒：这个 QQ 会话同时接了 AI，建议 filter=quote（只转引用回复）或改用专用群。' : '',
              `累计：抖音→QQ ${state.stats.dq} 条，QQ→抖音 ${state.stats.qd} 条；最近一轮：${state.stats.lastRunAt || '还没跑过'}`,
            ].filter(Boolean)
            const recent = state.log.slice(0, 3).map((row) => `· ${row.at.slice(11, 19)} ${dirArrow(row.dir)} ${clip(row.text, 60)}${row.ok ? '' : '（失败）'}`)
            if (recent.length) lines.push('最近：', ...recent)
            return { ok: true, text: lines.join('\n') }
          }
          case 'bind': {
            const result = await handleBind({
              qq_kind: args.qq_kind,
              qq_id: args.qq_id,
              qq_label: args.qq_label,
              douyin_sec_uid: args.douyin_sec_uid,
              douyin_nick: args.douyin_nick,
              filter: args.filter,
              prefix: args.prefix,
              force: args.force === true,
            })
            if (!result.ok) return { ok: false, text: `绑定失败：${result.error}${result.detail ? `\n${result.detail}` : ''}${result.canForce ? '\n确认没问题可以再加 force=true 重试。' : ''}` }
            return {
              ok: true,
              text: `已绑定：抖音「${state.douyin.nick || state.douyin.sec_uid.slice(0, 10)}」 ↔ QQ ${state.qq.kind === 'group' ? '群 ' : '私聊 '}${state.qq.id}。${result.preview ? `\n预览：对方最近 ${result.preview.them_count} 条消息，最后一条「${clip(result.preview.last_them_text, 40)}」` : ''}\n现在可以用 enable 打开桥（或者先 sync 手动跑一轮看看）。`,
            }
          }
          case 'unbind': {
            const result = await handleUnbind()
            return { ok: result.ok, text: result.ok ? '已解绑，桥也关了。' : `解绑失败：${result.error}` }
          }
          case 'enable': {
            if (typeof args.enabled !== 'boolean') return { ok: false, text: 'enable 需要 enabled=true/false。' }
            const result = await handleConfig({ enabled: args.enabled })
            if (!result.ok) return { ok: false, text: `操作失败：${result.error}` }
            return { ok: true, text: args.enabled ? '桥已打开。' : '桥已关闭。' }
          }
          case 'sync': {
            const result = await runTick({ manual: true })
            if (result.busy) return { ok: false, text: result.error }
            if (result.skipped) return { ok: true, text: result.skipped === 'disabled' ? '桥是关着的；先 enable。' : '还没绑定；先 bind。' }
            const lines = [
              `这一轮：抖音→QQ ${result.dq.forwarded}/${result.dq.found} 条，QQ→抖音 ${result.qd.forwarded}/${result.qd.found} 条。`,
            ]
            if (result.dq.note) lines.push(`抖音→QQ：${result.dq.note}`)
            if (result.qd.note) lines.push(`QQ→抖音：${result.qd.note}`)
            if (result.errors.length) lines.push('报错：', ...result.errors.map((msg) => `· ${msg}`))
            return { ok: result.errors.length === 0, text: lines.join('\n') }
          }
          case 'peers': {
            const result = await listPeers()
            if (!result.ok) return { ok: false, text: `读不到会话列表：${result.error}` }
            const lines = result.people.slice(0, 20).map((row, index) => {
              const bad = !row.has_id || row.is_group
              return `${index + 1}. ${row.nick || '（没名字）'}${bad ? '（不能绑：群或没有稳定 id）' : ''}\n   sec_uid: ${row.sec_uid || '—'}`
            })
            return { ok: true, text: [`抖音里聊过的人（共 ${result.count} 个${result.via === 'memory' ? '，来自本机记忆' : ''}）：`, ...lines, result.warning ? `注：${result.warning}` : ''].filter(Boolean).join('\n') }
          }
          case 'send': {
            const result = await handleSend({ side: args.side, text: args.text, confirm: args.confirm === true })
            if (result.needsConfirm) return { ok: false, text: `还没发：需要用户当场同意后带 confirm=true 再调一次。\n草稿：${result.draft}` }
            if (!result.ok) return { ok: false, text: `发送失败：${result.error}` }
            return { ok: true, text: `已发送（${result.side === 'qq' ? 'QQ' : '抖音'}）。` }
          }
          case 'video':
          case 'comments': {
            const target = await resolveAwemeTarget({ url: args.url, aweme_id: args.aweme_id, text: args.text })
            if (target.ok !== true) return { ok: false, text: `没认出抖音视频：${target.error}` }
            const limit = Math.max(1, Math.min(Number(args.limit) || (action === 'comments' ? 10 : 6), 20))
            const info = await queryVideo({ awemeId: target.aweme_id, wantComments: true, commentLimit: limit })
            if (info.ok !== true) return { ok: false, text: `没查到：${info.error}` }
            return { ok: true, text: info.warn ? `${info.text}\n（注：${info.warn}）` : info.text }
          }
          case 'open': {
            const target = await resolveAwemeTarget({ url: args.url, aweme_id: args.aweme_id, text: args.text })
            if (target.ok !== true) return { ok: false, text: `没认出抖音视频：${target.error}` }
            const opened = openInBrowser(target.canonical)
            if (opened.ok !== true) return { ok: false, text: `打开失败：${opened.error}` }
            return { ok: true, text: `已在默认浏览器打开：${target.canonical}` }
          }
          case 'share_card': {
            const target = await resolveAwemeTarget({ url: args.url, aweme_id: args.aweme_id, text: args.text })
            if (target.ok !== true) return { ok: false, text: `没认出抖音视频：${target.error}` }
            if (!isConfigured(state)) return { ok: false, text: '还没绑定抖音好友：先 bind（并确认对方已有私信会话）。' }
            if (args.confirm !== true) {
              const preview = await queryVideo({ awemeId: target.aweme_id, wantComments: false, commentLimit: 3 })
              const head = preview.ok === true ? preview.text.split('\n').slice(0, 3).join('\n') : `视频 ID：${target.aweme_id}`
              return {
                ok: false,
                needsConfirm: true,
                text: `还没发 —— 先给用户确认：\n收件人：抖音「${state.douyin.nick || state.douyin.sec_uid.slice(0, 10)}」\n${head}\n用户同意后带 confirm=true 再调一次。`,
              }
            }
            const sent = await shareVideoCard(target.aweme_id, { to: state.douyin.nick, toId: state.douyin.sec_uid })
            await commit((draft) => pushLog(draft, {
              at: nowIso(),
              dir: 'qd',
              ok: sent.ok,
              text: clip(`[手动分享卡片] ${target.canonical}`, 160),
              note: sent.ok ? '已发分享卡片到抖音' : clip(sent.error || '', 120),
            }))
            if (sent.ok !== true) return { ok: false, text: `发分享卡片失败：${sent.error}` }
            return { ok: true, text: `已把视频以分享卡片发给抖音「${state.douyin.nick || state.douyin.sec_uid.slice(0, 10)}」。` }
          }
          case 'fetch_video': {
            const target = await resolveAwemeTarget({ url: args.url, aweme_id: args.aweme_id, text: args.text })
            if (target.ok !== true) return { ok: false, text: `没认出抖音视频：${target.error}` }
            const fetched = await sendVideoToQq(target.aweme_id)
            if (fetched.ok !== true) return { ok: false, text: `视频没发出去：${fetched.error}` }
            return {
              ok: true,
              text: `已把视频发到绑定的 QQ 会话：${fetched.title || target.aweme_id}（${fetched.size_mb || '?'} MB${fetched.message_id ? `，消息 id ${fetched.message_id}` : ''}）。`,
              video: fetched,
            }
          }
          case 'link_config': {
            if (args.links === null || typeof args.links !== 'object') {
              return { ok: false, text: 'link_config 需要 links 对象，例如 {"autoCard":true,"autoOpen":"private","cooldownSec":60,"fetchVideo":true,"autoUnderstand":true}。' }
            }
            const result = await handleConfig({ links: args.links })
            if (result.ok !== true) return { ok: false, text: `改链接设置失败：${result.error}` }
            return { ok: true, text: `链接设置已更新：自动卡片=${state.links.autoCard ? '开' : '关'}，自动打开=${state.links.autoOpen}，冷却=${state.links.cooldownSec}s，发视频到QQ=${state.links.fetchVideo !== false ? '开' : '关'}，自动视频理解=${state.links.autoUnderstand !== false ? '开' : '关'}。` }
          }
          case 'inbound_config': {
            if (args.inbound === null || typeof args.inbound !== 'object') {
              return { ok: false, text: 'inbound_config 需要 inbound 对象，例如 {"skipCards":true}。' }
            }
            const result = await handleConfig({ inbound: args.inbound })
            if (result.ok !== true) return { ok: false, text: `改收信过滤失败：${result.error}` }
            return {
              ok: true,
              text: state.inbound.skipCards
                ? '已设置：抖音分享视频/作品卡片不转进 QQ（普通文字私信照常转）。'
                : '已设置：抖音分享视频/作品卡片照常转进 QQ（带可点链接 + 封面图）。',
            }
          }
          case 'vlm_status': {
            const config = videoModelConfig(process.env)
            if (!config.available) return { ok: false, text: '还没配视频模型 key（DASHSCOPE_API_KEY / GEMINI_API_KEY / vlm-key.txt）。' }
            const stateFile = modelStatePath()
            if (args.vlm_reset === true) writeModelState({ preferred: '', exhausted: {}, throttled: {} }, stateFile)
            const stateBefore = readModelState(stateFile)
            const explicit = Array.isArray(args.vlm_models) ? args.vlm_models.map(String).filter(Boolean) : []
            const list = explicit.length > 0 ? explicit : modelListForProvider(config.provider, process.env)
            const results = await probeVlmModels({ models: list, stateFile })
            const lines = [
              `视频模型逐个体检（provider=${config.provider}，顺序=便宜→贵，免费额度优先）：`,
            ]
            for (const row of results) {
              if (row.ok) {
                lines.push(`- ${row.model}: ✅ 可用（${row.ms}ms）`)
              } else {
                const why = row.errorType === 'quota'
                  ? '额度用完 / 未开通（去百炼控制台给这个模型开免费额度）'
                  : (row.errorType === 'missing'
                    ? '模型不存在 / 当前账号没这个模型（跳过，别费劲开）'
                    : (row.errorType === 'throttle' ? '限流/并发' : (row.errorType === 'auth' ? 'key 鉴权失败' : '其他错误')))
                lines.push(`- ${row.model}: ❌ ${why}（HTTP ${row.status}）${row.detail ? `：${clip(row.detail, 120)}` : ''}`)
              }
            }
            const stateAfter = readModelState(stateFile)
            const preferred = stateAfter.preferred || stateBefore.preferred || '（还没有）'
            const cooling = Object.keys(stateAfter.exhausted || {})
            lines.push('')
            lines.push(`当前优先模型：${preferred}${cooling.length ? `；已冷却：${cooling.join('、')}` : ''}`)
            lines.push('想「一个个开启免费额度」：去 阿里云百炼控制台 → 模型广场 → 逐个点「开通」并领取免费额度，每开一个就回来跑一次 vlm_status；全绿后 describe/watch 会自动按顺序用它们。')
            return { ok: true, text: lines.join('\n'), models: results }
          }
          case 'log': {
            const limit = Math.max(1, Math.min(Number(args.limit) || 10, 50))
            const rows = state.log.slice(0, limit)
            if (rows.length === 0) return { ok: true, text: '还没有记录。' }
            return { ok: true, text: rows.map((row) => `${row.at.slice(11, 19)} ${dirArrow(row.dir)} ${row.ok ? '成功' : '失败'} ${clip(row.text, 80)}${row.note ? `（${row.note}）` : ''}`).join('\n') }
          }
          default:
            return { ok: false, text: `未知 action：${action || '(空)'}。可用：status/bind/unbind/enable/sync/peers/send/log/video/comments/open/share_card/fetch_video/link_config/inbound_config/vlm_status。` }
        }
      } catch (error) {
        return { ok: false, text: `工具执行出错：${String((error && error.message) || error)}` }
      }
    },
  }), 'dsh-qq-douyin-bridge: 工具 qq_douyin_bridge')

  // ---------------------------------------------------------------------------
  // 只读内容工具 —— 给 QQ 会话里的 AI 用（白名单只放这个，不放上面那个）
  // ---------------------------------------------------------------------------

  ctx.effect(() => ctx.tools.register({
    name: 'douyin_video',
    description: [
      '抖音内容查询 / 搬运（基本只读；watch 会把媒体发到用户自己的 QQ 会话）：',
      '① 给一个抖音视频链接（完整链接或 v.douyin.com 短链）或 aweme_id，查这条视频的标题/作者/点赞评论数，以及热门评论（谁说了什么、多少赞）；',
      '② action=feed：拉一轮「用户抖音上刷到的视频」（推荐流），可以只返回清单，也可以 push=true 直接发到绑定的 QQ 会话里当聊天内容；',
      '③ action=describe：**只看不搬** —— 下载整段视频 → 抽 6 帧 → 本地 Whisper 转写声音 → 交给视频大模型（DashScope Qwen-VL）',
      '   做「画面理解」，返回标题/作者/统计 + 结构化画面描述（场景/动作/画面文字/声音概要）；**不往 QQ 发任何消息**。',
      '④ action=watch：把「整段视频」搬进 QQ —— 发完整 mp4（用户能看到动态画面和原声）、再抽 6 帧画面发成图片、原声再发一条语音，',
      '   并附上视频大模型画面理解 + 本地 Whisper 语音转写（声音→文字）；返回里给出帧图片的消息 id，可用 qq_get_message_images 逐帧看。',
      '不会点赞、不分享、不打开浏览器；只查资料 +（watch 时）把用户自己的视频搬进自己的 QQ。',
      '参数：url（推荐）或 aweme_id 或 text；feed 用 top（默认 5）、with_comments（0–2）、push；describe/watch 用 frames（帧数，默认 6，最多 10）。',
      'action=info（默认）返回视频信息+热评；action=comments 只返回热评；limit 控制热评条数（默认 info 6、comments 10）。',
      '耗时：视频信息 1–3 秒；热评 10–20 秒；feed 10–20 秒；describe 约 20–60 秒；watch（下载+抽帧+发媒体）约 20–70 秒。查不到会如实说，不会编造。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['info', 'comments', 'feed', 'describe', 'watch'], description: 'info = 视频信息+热评；comments = 只查热评；feed = 拉「抖音上刷到的视频」；describe = 整段视频理解（不发消息）；watch = 把整段视频+帧+原声搬进 QQ。' },
        url: { type: 'string', description: '抖音视频链接（完整或 v.douyin.com 短链）。' },
        aweme_id: { type: 'string', description: '抖音视频 ID（19 位数字）。' },
        text: { type: 'string', description: '含抖音链接的一段文字。' },
        limit: { type: 'number', description: '热评条数（默认 info 6、comments 10，最多 20）。' },
        top: { type: 'number', description: 'feed：返回几条推荐视频（默认 5，最多 10）。' },
        with_comments: { type: 'number', description: 'feed：给前几条拉热评（0–2，默认 0）。' },
        push: { type: 'boolean', description: 'feed：是否把前 3 条直接发到绑定的 QQ 会话（默认 false）。' },
        frames: { type: 'number', description: 'watch：抽几帧画面（默认 6，3–10）。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: String((value && value.text) || '（没有结果）') }],
    },
    isConcurrencySafe: () => false,
    execute: async (rawArgs) => {
      const args = rawArgs !== null && typeof rawArgs === 'object' ? rawArgs : {}
      const rawAction = String(args.action || '')
      const action = rawAction === 'comments' ? 'comments'
        : (rawAction === 'feed' ? 'feed'
          : (rawAction === 'watch' ? 'watch' : (rawAction === 'describe' ? 'describe' : 'info')))
      try {
        if (action === 'describe') {
          const described = await describeVideo({
            url: args.url,
            aweme_id: args.aweme_id,
            text: args.text,
            frames: args.frames,
          })
          if (described.ok !== true) return { ok: false, text: `看视频失败：${described.error}` }
          return { ok: true, text: described.text, vision: described.vision, asr: described.asr }
        }
        if (action === 'watch') {
          const watched = await watchVideo({
            url: args.url,
            aweme_id: args.aweme_id,
            text: args.text,
            frames: args.frames,
          })
          if (watched.ok !== true) return { ok: false, text: `搬视频失败：${watched.error}` }
          return { ok: true, text: watched.text, sent: watched.sent }
        }
        if (action === 'feed') {
          const feed = await queryFeed({
            top: args.top,
            withComments: args.with_comments,
            push: args.push === true,
          })
          if (feed.ok !== true) return { ok: false, text: `没拉到推荐流：${feed.error}` }
          const lines = [feed.text]
          if (feed.pushed > 0) lines.push(`\n已把前 ${feed.pushed} 条发到绑定的 QQ 会话（用户可以直接引用着聊）。`)
          if (feed.warn) lines.push(`\n（注：${feed.warn}）`)
          return { ok: true, text: lines.join(''), rows: feed.rows }
        }
        const target = await resolveAwemeTarget({ url: args.url, aweme_id: args.aweme_id, text: args.text })
        if (target.ok !== true) return { ok: false, text: `没认出抖音视频：${target.error}` }
        const limit = Math.max(1, Math.min(Number(args.limit) || (action === 'comments' ? 10 : 6), 20))
        const info = await queryVideo({ awemeId: target.aweme_id, wantComments: true, commentLimit: limit })
        if (info.ok !== true) return { ok: false, text: `没查到：${info.error}` }
        return { ok: true, text: info.warn ? `${info.text}\n（注：${info.warn}）` : info.text }
      } catch (error) {
        return { ok: false, text: `查询出错：${String((error && error.message) || error)}` }
      }
    },
  }), 'dsh-qq-douyin-bridge: 工具 douyin_video')
}

// -----------------------------------------------------------------------------
// 小工具（模块级纯函数）
// -----------------------------------------------------------------------------

function emptySide(note = '') {
  return { found: 0, forwarded: 0, skipped: 0, note }
}

function labelOfFilter(filter) {
  if (filter === 'all') return '全部转发'
  if (filter === 'prefix') return '只转带前缀的'
  return '只转引用回复的'
}

function labelOfVia(via) {
  if (via === 'all') return '全部'
  if (via === 'prefix') return '前缀'
  return '引用'
}

function dirArrow(dir) {
  if (dir === 'dq') return '抖音→QQ'
  if (dir === 'qd') return 'QQ→抖音'
  return '系统'
}

function summarizeResult(result) {
  const dq = result.dq.forwarded > 0 ? `抖音→QQ ${result.dq.forwarded} 条` : ''
  const qd = result.qd.forwarded > 0 ? `QQ→抖音 ${result.qd.forwarded} 条` : ''
  if (dq === '' && qd === '') return result.errors.length > 0 ? '本轮没有转发（有报错）' : '本轮没有新消息'
  return `本轮转发：${[dq, qd].filter(Boolean).join('，')}`
}

/** 睡一会儿（不阻塞事件循环以外的定时器）。 */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

/**
 * 读请求体（有上限）。
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * 写 JSON 响应。
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {Record<string, unknown>} payload
 */
function writeJson(res, status, payload) {
  try {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    res.end(body)
  } catch {
    try {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: '响应写不出来' }))
    } catch {
      /* 连接已经断了 */
    }
  }
}
