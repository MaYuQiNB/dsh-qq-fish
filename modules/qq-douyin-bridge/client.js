/**
 * dsh-qq-douyin-bridge —— 浏览器半端（设置里的一页：「QQ × 抖音桥」）
 * ============================================================================
 * 只做一件事：把 CONTRACT.md §1 的 HTTP 路由包成一页设置界面。
 * 唯一权威是 CONTRACT.md；宿主 index.js 与本文件的字段必须对齐。
 *
 * 设计约束（来自 CONTRACT §2，改之前先读契约）：
 *   · 非 ESM：window.__ModuleLoader__.load({ id, factory: (require) => ... })；
 *     除 require('react') 外不依赖任何东西，也不写 JSX。
 *   · 注册到 settings.section：{ id:'qq-douyin', order:32, label: t('title') }。
 *   · 中英文案全部走 ctx.locale（register + bind），两套 key 完全一致。
 *   · 整个页面包在 error boundary 里：子组件抛错只显示「这页出错了」+「重试」，
 *     绝不让整页消失（dsh-douyin-scroll 踩过这个坑：一处 TDZ 整块白）。
 *   · 样式 <style data-plugin-css="dsh-qq-douyin-bridge">，只用 --dsw-alias-* 主题
 *     token（带中性 fallback），类名统一 qqdy- 前缀，不写死深/浅色背景。
 *   · 所有请求 fetch('/api/qq-douyin/…', { credentials:'same-origin' })；
 *     宿主一律 HTTP 200 + { ok }，失败靠 ok 判断；404/网络错误给人话。
 *   · 进页面拉一次 state，之后每 10 秒轮询（页面隐藏时停），操作后立即刷新。
 *   · 本文件不主动发任何真实消息；「发测试消息」必须 window.confirm 后才调 /send。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-qq-douyin-bridge',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /** locale 命名空间 = 插件包名。 */
    const NS = 'dsh-qq-douyin-bridge'
    /** 宿主路由前缀（CONTRACT §1）。 */
    const API = '/api/qq-douyin'
    /** 轮询间隔：CONTRACT §2 要求 10 秒；页面隐藏时暂停。 */
    const POLL_INTERVAL_MS = 10000
    /** 「最近记录」只显示最近 8 条（CONTRACT §2）。 */
    const LOG_LIMIT = 8
    /** filter=prefix 时的默认前缀（CONTRACT §4）。 */
    const DEFAULT_PREFIX = '回：'
    /** 绑定表单的空值；也用于「解绑」后的复位。 */
    const EMPTY_FORM = {
      douyinNick: '',
      secUid: '',
      qqKind: 'private',
      qqId: '',
      qqLabel: '',
      filter: 'quote',
      prefix: DEFAULT_PREFIX,
      douyinToQQ: true,
      qqToDouyin: true,
    }

    /**
     * 链接分享设置的默认值（CONTRACT §7.1 / §7.5）：宿主没给 `state.links`，
     * 或者只给了部分字段时，页面按这个显示。
     */
    const DEFAULT_LINKS = { autoCard: true, autoOpen: 'private', cooldownSec: 60, skipCards: true, fetchVideo: true, autoUnderstand: true }
    /**
     * 链接分享表单的初始草稿。冷却秒数用字符串保存：数字输入框的中间态
     * （空串、刚敲了一个数字）不会被 Number('') = 0 吞掉。
     */
    const EMPTY_LINKS_FORM = {
      autoCard: DEFAULT_LINKS.autoCard,
      autoOpen: DEFAULT_LINKS.autoOpen,
      cooldownSec: String(DEFAULT_LINKS.cooldownSec),
      skipCards: DEFAULT_LINKS.skipCards,
      fetchVideo: DEFAULT_LINKS.fetchVideo,
      autoUnderstand: DEFAULT_LINKS.autoUnderstand,
    }
    /** 同一视频冷却秒数的上下限（CONTRACT §7.1：10–600 的整数）。 */
    const LINK_COOLDOWN_MIN = 10
    const LINK_COOLDOWN_MAX = 600

    // =========================================================================
    // 文案 —— 所有用户可见文字都在这里，中英 key 必须完全一致
    // =========================================================================

    const zh = {
      'title': 'QQ × 抖音桥',
      'subtitle': '把一个 QQ 会话和一位抖音好友的私信接成双向通道：抖音来的私信转到 QQ，你在 QQ 里回的话再发回抖音。',
      'loading': '正在读取桥的状态…',
      'loadFailed': '桥的状态没读出来',
      'loadFailedHint': '看看上面的报错，然后点「重试」。',
      'retry': '重试',
      'refresh': '刷新',
      'refreshing': '刷新中…',
      'dismiss': '知道了',
      'error.hostMissing': '宿主半端没加载或没响应 —— 刷新一下页面，或者重启一次 dsh。',
      'error.network': '连不上宿主半端（没响应，或者页面刚重载）。稍等一下再试。',
      'error.http': '宿主返回了 HTTP {status}。',
      'error.badPayload': '宿主返回的数据不认识，可能是版本不一致。',
      'error.badState': '宿主返回的状态不完整。',
      'error.withDetail': '{message}（细节：{detail}）',
      'error.boundaryTitle': '这页出错了',
      'error.boundaryBody': '子组件抛了个错 —— 整页还在。下面是错误信息，点「重试」重新加载这页。',
      'error.boundaryRetry': '重试',

      'status.on': '桥开着',
      'status.off': '桥关着',
      'status.running': '轮询中',
      'status.stopped': '没在轮询',
      'status.bound': '已绑定',
      'status.unbound': '未绑定',
      'status.toggle': '总开关',
      'status.toggleHint': '关掉后两个方向都暂停转发；绑定和记录都还留着。',
      'status.turnedOn': '桥开了：两个方向开始转发。',
      'status.turnedOff': '桥关了：暂停转发，绑定和记录都还在。',
      'status.summaryDouyin': '抖音 · {nick}',
      'status.summaryQq': 'QQ · {label}',
      'status.kindPrivate': '私聊',
      'status.kindGroup': '群',
      'status.summary': '{douyin} ↔ {qq}（{kind}）',
      'status.summaryUnbound': '还没绑定：在下面选一位抖音好友和一个 QQ 会话，保存后开始。',
      'status.stats': '累计：抖音→QQ {dq} 条 · QQ→抖音 {qd} 条',
      'status.poll': '页面每 {sec} 秒刷新一次状态；切到后台就暂停。',

      'bind.title': '绑定',
      'bind.overwriteHint': '已经绑过：保存会用新的选择覆盖当前绑定。',
      'bind.unboundDraft': '当前还没有生效的绑定；把两侧填好再点「保存并绑定」。',
      'bind.douyinTitle': '抖音这一侧',
      'bind.douyinHint': '只能绑「私聊好友」：要有稳定 id；群和没有稳定 id 的行绑不了。',
      'bind.douyinNick': '抖音昵称',
      'bind.douyinNickPlaceholder': '例如：小王（只用于显示）',
      'bind.secUid': '稳定 id（sec_uid）',
      'bind.secUidPlaceholder': 'MS4wLjABAAAA…',
      'bind.secUidHint': '不知道也正常：点「读取抖音会话列表」，从里面点一个。',
      'bind.readPeers': '读取抖音会话列表',
      'bind.readingPeers': '正在读取…',
      'bind.peersSlow': '要开无头浏览器，最多 40 秒；按钮转圈是正常的，别重复点。',
      'bind.peersTitle': '点一个好友，自动填进上面的框',
      'bind.peersAgain': '再读一次',
      'bind.peersClose': '收起',
      'bind.peersFound': '找到 {count} 人',
      'bind.peersEmpty': '没读到会话里的人。',
      'bind.peerUnnamed': '（没昵称）',
      'bind.peerDuplicate': '重名',
      'bind.peerGroup': '群',
      'bind.peerNoId': '没稳定 id',
      'bind.peerGroupDisabled': '群不能绑，只能选私聊好友。',
      'bind.peerNoIdDisabled': '这个人没有稳定 id，不能绑。',
      'bind.peersDisabledHint': '带「群」或「没稳定 id」的行不能绑：桥只接私聊好友。',
      'bind.pickedPeer': '已把「{nick}」填进抖音那栏。',
      'bind.needLogin': '抖音没登录 —— 先去「设置 → 刷抖音」扫码登录，再回来读会话列表。',
      'bind.qqTitle': 'QQ 这一侧',
      'bind.qqKindPrivate': '私聊好友',
      'bind.qqKindGroup': '群',
      'bind.qqIdPrivate': 'QQ 号',
      'bind.qqIdGroup': '群号',
      'bind.qqIdPlaceholder': '例如：<OWNER_QQ>',
      'bind.qqLabel': '备注名（可选）',
      'bind.qqLabelPlaceholder': '例如：西嗨',
      'bind.ruleTitle': '转发规则（QQ → 抖音）',
      'bind.filter': '只转这些发言',
      'bind.filterAll': '全部：别人说的都转',
      'bind.filterQuote': '只转引用回复（推荐）',
      'bind.filterPrefix': '只转带前缀的',
      'bind.filterHintAll': '目标会话里所有「别人发的」消息都会转走。适合专用群；记得把该群从 QQ 桥接白名单里拿掉，否则 AI 也会看到。',
      'bind.filterHintQuote': '只转发「引用了那条【抖音·…】消息」的发言 —— 最安全，AI 也在同一个会话时用它。',
      'bind.filterHintPrefix': '只转发以指定前缀开头的发言，转发时会自动剥掉前缀。',
      'bind.prefix': '前缀',
      'bind.prefixPlaceholder': '回：',
      'bind.prefixHint': '只对「只转带前缀的」生效：比如「回：」就只转以「回：」开头的消息，转发时会把前缀去掉。',
      'bind.prefixDisabled': '选了「只转带前缀的」才能改。',
      'bind.directionTitle': '方向',
      'bind.directionDq': '抖音 → QQ',
      'bind.directionQd': 'QQ → 抖音',
      'bind.directionHint': '两个都勾上才是双向。',
      'bind.save': '保存并绑定',
      'bind.saving': '正在保存…',
      'bind.incomplete': '抖音稳定 id 和 QQ 号码都要填，才能绑定。',
      'bind.qqIdInvalid': 'QQ 号 / 群号应该是 5–12 位数字。',
      'bind.secUidInvalid': '抖音 sec_uid 不像对的（太短）：点「读取抖音会话列表」选一个，别手猜。',
      'bind.canForceHint': '宿主读不到这位好友的私信（可能是新好友，或者还没聊过天）。确认 sec_uid 没问题的话，可以强制绑定。',
      'bind.force': '仍然强制绑定',
      'bind.prefixRequired': '选了「只转带前缀的」，前缀不能是空的。',
      'bind.saved': '已绑定：{summary}',
      'bind.savedPreview': '已绑定。对端有 {count} 条对方消息，最近一条「{text}」',
      'bind.savedShort': '已保存绑定。',

      'links.title': '链接分享',
      'links.autoCard': '抖音链接自动发分享卡片',
      'links.skipCards': '抖音分享的视频不转 QQ（私信里发来的卡片）',
      'links.fetchVideo': 'QQ 里发抖音链接 → 直接把视频（MP4）发回 QQ',
      'links.autoUnderstand': 'QQ 里发抖音链接 → 自动理解视频（画面+文字+声音）并回一条结论',
      'links.autoOpen': '自动在本机打开',
      'links.autoOpenOff': '不打开',
      'links.autoOpenPrivate': '仅 QQ 私聊',
      'links.autoOpenAlways': '总是',
      'links.cooldown': '同一视频冷却（秒）',
      'links.hint': 'QQ 里出现抖音视频链接时按上面的设置处理；QQ 里的 AI 也能用只读工具 douyin_video 查视频信息、热门评论，或 action=watch 把整段视频搬进 QQ。',
      'links.save': '保存链接设置',
      'links.saving': '正在保存…',
      'links.saved': '链接设置已保存。',
      'links.saveFailed': '链接设置没保存成功。',
      'links.cooldownInvalid': '冷却时间要是 {min}–{max} 之间的整数秒。',

      'mark.ok': '✓',
      'mark.bad': '✗',
      'health.title': '连通性',
      'health.check': '检测一次',
      'health.checking': '检测中…',
      'health.qq': 'QQ',
      'health.douyin': '抖音',
      'health.peer': '对端',
      'health.qqOk': 'QQ 已连上：{nick}（{uin}）',
      'health.qqBad': 'QQ 连不上：{error}',
      'health.douyinOk': '抖音已登录：{nick}',
      'health.douyinNotLoggedIn': '抖音没登录 —— 先去「设置 → 刷抖音」扫码。',
      'health.douyinBad': '抖音读不到：{error}',
      'health.peerOk': '能读到 {nick} 的私信（{count} 条对方消息），最近一条：{text}',
      'health.peerEmpty': '能读到 {nick} 的私信，但对方还没发过消息。',
      'health.peerBad': '对端读不到：{error}',
      'health.peerUnbound': '还没绑定，没有对端可读。',
      'health.aiOverlap': '这个 QQ 会话同时被 QQ 桥接接给了 AI：AI 可能和桥抢着回话。建议改成「只转引用回复」，或者换一个专用 QQ 群。',
      'health.running': '每 {sec} 秒同步一轮，约 {next} 秒后下一轮。',
      'health.stopped': '轮询没在跑（桥关着，或者刚启动还没转起来）。',
      'health.errors': '累计出错 {count} 次。',
      'health.lastError': '最近一次错误：{error}',
      'health.testOk': '检测完成：QQ ✓ · 抖音 ✓ · 对端 ✓',
      'health.testMixed': '检测完成：QQ {qq} · 抖音 {douyin} · 对端 {peer}',
      'health.testHint': '「检测一次」只读状态，不会发任何消息。',

      'actions.title': '操作',
      'actions.sync': '立即同步',
      'actions.syncing': '同步中…',
      'actions.syncDisabled': '绑定齐了才能同步。',
      'actions.syncDone': '同步完成：抖音→QQ 转 {dq} 条（跳过 {dqSkip}）、QQ→抖音 转 {qd} 条（跳过 {qdSkip}）',
      'actions.syncErrors': '；本轮出错 {count} 次',
      'actions.test': '发测试消息',
      'actions.testSide': '发到',
      'actions.sideQq': 'QQ 会话',
      'actions.sideDouyin': '抖音好友',
      'actions.testText': '【测试】QQ × 抖音桥的测试消息，请忽略。',
      'actions.testConfirm': '确定要发一条测试消息到「{side}」吗？\n\n{text}',
      'actions.testing': '发送中…',
      'actions.testSent': '测试消息已发出。',
      'actions.testNeedsConfirm': '宿主没发：它还要一次确认。',
      'actions.unbind': '解绑',
      'actions.unbindConfirm': '再点一次解绑',
      'actions.unbinding': '正在解绑…',
      'actions.unbound': '已解绑。',
      'actions.cancel': '取消',
      'actions.unbindHint': '解绑只清绑定，状态和记录都还留着。',
      'actions.notBound': '还没绑定：先在上面保存一次。',
      'actions.testHint': '会真的发一条消息出去，所以点之前会先问你。',

      'log.title': '最近记录',
      'log.count': '{count} 条',
      'log.empty': '还没有记录 —— 同步过一轮之后这里会有。',
      'log.dirDq': '抖音→QQ',
      'log.dirQd': 'QQ→抖音',
      'log.dirSys': '系统',
      'log.failed': '失败',

      'safety.title': '安全说明',
      'safety.ai': 'QQ 私聊同时接给了 AI 时，AI 和这座桥可能抢着回话：建议把转发规则改成「只转引用回复」，或者干脆用一个专用 QQ 群。',
      'safety.group': '用专用群的话，记得把群从 QQ 桥接的白名单里拿掉 —— 否则 AI 也会看到转发内容。',
      'safety.prime': '绑定 / 启用后的第一轮只记水位、不补发历史；以后重启也不会把旧消息重播一遍。',
      'safety.local': '绑定、水位和记录都存在本机（状态文件里不存任何 token / Cookie）。',
    }

    const en = {
      'title': 'QQ × Douyin Bridge',
      'subtitle': 'Connects one QQ conversation with one Douyin friend in both directions: new Douyin DMs are relayed to QQ, and what you reply in QQ is sent back to Douyin.',
      'loading': 'Reading the bridge state…',
      'loadFailed': 'The bridge state did not load',
      'loadFailedHint': 'Read the message above, then press Retry.',
      'retry': 'Retry',
      'refresh': 'Refresh',
      'refreshing': 'Refreshing…',
      'dismiss': 'Dismiss',
      'error.hostMissing': 'The host half is not loaded or not responding — refresh the page, or restart dsh.',
      'error.network': 'Could not reach the host half (no response, or the page just reloaded). Try again in a moment.',
      'error.http': 'The host returned HTTP {status}.',
      'error.badPayload': 'The host returned data this page does not understand; the versions may differ.',
      'error.badState': 'The host returned an incomplete state.',
      'error.withDetail': '{message} (detail: {detail})',
      'error.boundaryTitle': 'This page crashed',
      'error.boundaryBody': 'A child component threw. The page is still here. See the error below, then press Retry to reload it.',
      'error.boundaryRetry': 'Retry',

      'status.on': 'Bridge on',
      'status.off': 'Bridge off',
      'status.running': 'Polling',
      'status.stopped': 'Not polling',
      'status.bound': 'Bound',
      'status.unbound': 'Not bound',
      'status.toggle': 'Master switch',
      'status.toggleHint': 'When off, both directions stop forwarding; the binding and history stay.',
      'status.turnedOn': 'Bridge on: both directions are forwarding.',
      'status.turnedOff': 'Bridge off: forwarding paused; the binding and history stay.',
      'status.summaryDouyin': 'Douyin · {nick}',
      'status.summaryQq': 'QQ · {label}',
      'status.kindPrivate': 'private chat',
      'status.kindGroup': 'group chat',
      'status.summary': '{douyin} ↔ {qq} ({kind})',
      'status.summaryUnbound': 'Not bound yet: pick a Douyin friend and a QQ conversation below, then save.',
      'status.stats': 'Totals: Douyin→QQ {dq} · QQ→Douyin {qd}',
      'status.poll': 'The page refreshes the state every {sec}s; it pauses in the background.',

      'bind.title': 'Binding',
      'bind.overwriteHint': 'Already bound: saving will replace the current binding.',
      'bind.unboundDraft': 'No active binding yet; fill in both sides and press Save.',
      'bind.douyinTitle': 'Douyin side',
      'bind.douyinHint': 'Only a private-chat friend with a stable id can be bound; groups and rows without an id cannot.',
      'bind.douyinNick': 'Douyin nickname',
      'bind.douyinNickPlaceholder': 'e.g. Alice (display only)',
      'bind.secUid': 'Stable id (sec_uid)',
      'bind.secUidPlaceholder': 'MS4wLjABAAAA…',
      'bind.secUidHint': 'Do not know it? Press Read Douyin conversations and click one row.',
      'bind.readPeers': 'Read Douyin conversations',
      'bind.readingPeers': 'Reading…',
      'bind.peersSlow': 'This launches a headless browser and can take up to 40 seconds; the spinning button is normal, do not press it twice.',
      'bind.peersTitle': 'Click a friend to fill the fields above',
      'bind.peersAgain': 'Read again',
      'bind.peersClose': 'Hide',
      'bind.peersFound': '{count} found',
      'bind.peersEmpty': 'No one was found in the conversation list.',
      'bind.peerUnnamed': '(no nickname)',
      'bind.peerDuplicate': 'Duplicate name',
      'bind.peerGroup': 'Group',
      'bind.peerNoId': 'No stable id',
      'bind.peerGroupDisabled': 'Groups cannot be bound; pick a private-chat friend.',
      'bind.peerNoIdDisabled': 'This person has no stable id and cannot be bound.',
      'bind.peersDisabledHint': 'Rows tagged Group or No stable id cannot be bound: the bridge only works with private-chat friends.',
      'bind.pickedPeer': 'Filled in {nick}.',
      'bind.needLogin': 'Douyin is not logged in — open Settings → Douyin Scroll, scan the QR code first, then read the list again.',
      'bind.qqTitle': 'QQ side',
      'bind.qqKindPrivate': 'Private chat',
      'bind.qqKindGroup': 'Group',
      'bind.qqIdPrivate': 'QQ number',
      'bind.qqIdGroup': 'Group number',
      'bind.qqIdPlaceholder': 'e.g. <OWNER_QQ>',
      'bind.qqLabel': 'Label (optional)',
      'bind.qqLabelPlaceholder': 'e.g. Alice',
      'bind.ruleTitle': 'Forwarding rule (QQ → Douyin)',
      'bind.filter': 'Forward only',
      'bind.filterAll': 'Everything others say',
      'bind.filterQuote': 'Quote replies only (recommended)',
      'bind.filterPrefix': 'Messages with a prefix only',
      'bind.filterHintAll': 'Every message from other people in the target conversation is forwarded. Fits a dedicated group; remember to remove that group from the QQ bridge allowlist or the AI will see it too.',
      'bind.filterHintQuote': 'Only forwards messages that quote the 【Douyin·…】 message — the safest choice when the AI also shares the conversation.',
      'bind.filterHintPrefix': 'Only forwards messages that start with the given prefix; the prefix is stripped before sending.',
      'bind.prefix': 'Prefix',
      'bind.prefixPlaceholder': 'Reply:',
      'bind.prefixHint': 'Only used by the prefix rule: with "Reply:" only messages starting with it are forwarded, and the prefix is removed.',
      'bind.prefixDisabled': 'Pick the prefix rule to edit this.',
      'bind.directionTitle': 'Directions',
      'bind.directionDq': 'Douyin → QQ',
      'bind.directionQd': 'QQ → Douyin',
      'bind.directionHint': 'Tick both for a two-way bridge.',
      'bind.save': 'Save and bind',
      'bind.saving': 'Saving…',
      'bind.incomplete': 'Both the Douyin stable id and the QQ number are required.',
      'bind.qqIdInvalid': 'The QQ or group number should be 5–12 digits.',
      'bind.secUidInvalid': 'That Douyin sec_uid looks too short — press Read Douyin conversations and click a row instead of guessing.',
      'bind.canForceHint': 'The host could not read this friend (new friend, or no chat yet). If you are sure the sec_uid is right, you can force the binding.',
      'bind.force': 'Force bind anyway',
      'bind.prefixRequired': 'The prefix rule needs a non-empty prefix.',
      'bind.saved': 'Bound: {summary}',
      'bind.savedPreview': 'Bound. The peer has {count} messages from them; the latest one: {text}',
      'bind.savedShort': 'Binding saved.',

      'links.title': 'Link sharing',
      'links.autoCard': 'Auto-send a share card for Douyin links',
      'links.skipCards': 'Do not forward Douyin shared videos to QQ (cards sent via DM)',
      'links.fetchVideo': 'Send the video (MP4) back to QQ when a Douyin link is posted',
      'links.autoUnderstand': 'Understand the video (visual + on-screen text + audio) and reply with a summary',
      'links.autoOpen': 'Open on this computer',
      'links.autoOpenOff': 'Do not open',
      'links.autoOpenPrivate': 'QQ private chats only',
      'links.autoOpenAlways': 'Always',
      'links.cooldown': 'Cooldown per video (seconds)',
      'links.hint': 'Douyin video links in QQ follow the settings above; the AI in QQ can also use the read-only tool douyin_video to look up video info and top comments, or action=watch to move a whole video into QQ.',
      'links.save': 'Save link settings',
      'links.saving': 'Saving…',
      'links.saved': 'Link settings saved.',
      'links.saveFailed': 'Link settings were not saved.',
      'links.cooldownInvalid': 'The cooldown must be a whole number between {min} and {max} seconds.',

      'mark.ok': '✓',
      'mark.bad': '✗',
      'health.title': 'Health',
      'health.check': 'Check now',
      'health.checking': 'Checking…',
      'health.qq': 'QQ',
      'health.douyin': 'Douyin',
      'health.peer': 'Peer',
      'health.qqOk': 'QQ connected: {nick} ({uin})',
      'health.qqBad': 'QQ unreachable: {error}',
      'health.douyinOk': 'Douyin logged in: {nick}',
      'health.douyinNotLoggedIn': 'Douyin is not logged in — scan the QR code in Settings → Douyin Scroll first.',
      'health.douyinBad': 'Douyin unreadable: {error}',
      'health.peerOk': 'Can read {nick} ({count} messages from them); latest: {text}',
      'health.peerEmpty': 'Can read {nick}, but they have not sent anything yet.',
      'health.peerBad': 'Peer unreadable: {error}',
      'health.peerUnbound': 'Not bound yet, so there is no peer to read.',
      'health.aiOverlap': 'This QQ conversation is also handed to the AI by the QQ bridge: both may answer at the same time. Switch to quote replies, or use a dedicated group.',
      'health.running': 'One sync round every {sec}s; next one in about {next}s.',
      'health.stopped': 'The poller is not running (bridge off, or it just started).',
      'health.errors': '{count} errors so far.',
      'health.lastError': 'Last error: {error}',
      'health.testOk': 'Check finished: QQ ✓ · Douyin ✓ · Peer ✓',
      'health.testMixed': 'Check finished: QQ {qq} · Douyin {douyin} · Peer {peer}',
      'health.testHint': 'Check now only reads status; it sends nothing.',

      'actions.title': 'Actions',
      'actions.sync': 'Sync now',
      'actions.syncing': 'Syncing…',
      'actions.syncDisabled': 'Bind both sides before syncing.',
      'actions.syncDone': 'Sync finished: Douyin→QQ forwarded {dq} (skipped {dqSkip}), QQ→Douyin forwarded {qd} (skipped {qdSkip})',
      'actions.syncErrors': '; {count} error(s) this round',
      'actions.test': 'Send test message',
      'actions.testSide': 'To',
      'actions.sideQq': 'QQ conversation',
      'actions.sideDouyin': 'Douyin friend',
      'actions.testText': '【Test】Test message from the QQ × Douyin bridge; please ignore.',
      'actions.testConfirm': 'Send a test message to "{side}"?\n\n{text}',
      'actions.testing': 'Sending…',
      'actions.testSent': 'Test message sent.',
      'actions.testNeedsConfirm': 'The host did not send it: it wants one more confirmation.',
      'actions.unbind': 'Unbind',
      'actions.unbindConfirm': 'Click again to unbind',
      'actions.unbinding': 'Unbinding…',
      'actions.unbound': 'Unbound.',
      'actions.cancel': 'Cancel',
      'actions.unbindHint': 'Unbinding only clears the binding; status and history stay.',
      'actions.notBound': 'Not bound yet: save a binding above first.',
      'actions.testHint': 'This sends a real message, so you are asked first.',

      'log.title': 'Recent activity',
      'log.count': '{count} entries',
      'log.empty': 'Nothing yet — records appear after the first sync round.',
      'log.dirDq': 'Douyin to QQ',
      'log.dirQd': 'QQ to Douyin',
      'log.dirSys': 'System',
      'log.failed': 'Failed',

      'safety.title': 'Safety notes',
      'safety.ai': 'When the same QQ private chat is also handed to the AI, the AI and this bridge may both reply. Switch the rule to quote replies, or use a dedicated QQ group.',
      'safety.group': 'With a dedicated group, remove it from the QQ bridge allowlist first; otherwise the AI sees the forwarded messages too.',
      'safety.prime': 'The first round after binding or enabling only records the watermark; it does not replay history, and a restart will not replay old messages.',
      'safety.local': 'The binding, watermarks and history stay on this machine (the state file stores no token or cookie).',
    }

    // =========================================================================
    // 样式 —— 只用 --dsw-alias-* 主题 token（带中性 fallback），qqdy- 前缀
    // =========================================================================

    const CSS = `
.qqdy-page{display:flex;flex-direction:column;gap:12px;width:100%;max-width:760px;box-sizing:border-box;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary,inherit);min-width:0}
.qqdy-card{display:flex;flex-direction:column;gap:10px;min-width:0;box-sizing:border-box;padding:14px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.24));background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.06))}
.qqdy-head{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:8px 12px;min-width:0}
.qqdy-headText{display:flex;flex-direction:column;gap:2px;flex:1 1 260px;min-width:0}
.qqdy-title{margin:0;font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary,inherit)}
h2.qqdy-title{font-size:14px;line-height:22px}
.qqdy-sub{margin:0;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,inherit)}
.qqdy-hint{margin:0;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,inherit)}
.qqdy-meta{margin:0;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary,inherit)}
.qqdy-summary{margin:0;font-size:13px;line-height:20px;font-weight:500;overflow-wrap:anywhere}
.qqdy-labelStrong{margin:0;font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-secondary,inherit);display:flex;align-items:center;gap:6px}
.qqdy-divider{height:1px;border:0;margin:2px 0;background:var(--dsw-alias-border-l2,rgba(128,128,128,.24))}
.qqdy-badges{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.qqdy-badge{display:inline-flex;align-items:center;padding:1px 7px;border-radius:6px;font-size:11px;line-height:17px;white-space:nowrap;background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));color:var(--dsw-alias-label-secondary,inherit)}
.qqdy-badge[data-tone=ok]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2eb872) 16%,transparent);color:var(--dsw-alias-state-success-primary,#2eb872)}
.qqdy-badge[data-tone=warn]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#e0a10a) 18%,transparent);color:var(--dsw-alias-state-warn-primary,#e0a10a)}
.qqdy-badge[data-tone=busy]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4f8cff) 16%,transparent);color:var(--dsw-alias-state-business-primary,#4f8cff)}
.qqdy-badge[data-tone=off]{background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));color:var(--dsw-alias-label-tertiary,inherit)}
.qqdy-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;min-width:0}
.qqdy-grow{flex:1 1 180px;min-width:0}
.qqdy-gap{flex:1 1 20px}
.qqdy-grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:10px;min-width:0}
.qqdy-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.qqdy-inlineField{display:inline-flex;align-items:center;gap:6px;min-width:0}
.qqdy-fieldLabel{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,inherit);white-space:nowrap}
.qqdy-input,.qqdy-select{box-sizing:border-box;width:100%;height:30px;padding:4px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,.3));background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.08));color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:13px;line-height:20px;outline:none}
.qqdy-select{appearance:auto;cursor:pointer;padding-right:4px}
.qqdy-selectMini{width:auto;height:26px;font-size:12px}
.qqdy-input::placeholder{color:var(--dsw-alias-label-caption,inherit)}
.qqdy-input:focus,.qqdy-select:focus{border-color:var(--dsw-alias-state-business-primary,#4f8cff);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary,#4f8cff)}
.qqdy-input:disabled,.qqdy-select:disabled{opacity:.55;cursor:default}
.qqdy-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.qqdy-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;white-space:nowrap}
.qqdy-check input{margin:0;accent-color:var(--dsw-alias-state-business-primary,#4f8cff)}
.qqdy-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.1));color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer;appearance:none}
.qqdy-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.2))}
.qqdy-btn:disabled{opacity:.45;cursor:default}
.qqdy-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4f8cff);outline-offset:2px}
.qqdy-btn[data-primary]{background:var(--dsw-alias-button-primary-fill,#4f8cff);border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}
.qqdy-btn[data-primary]:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#3d7bf5)}
.qqdy-btn[data-danger]{color:var(--dsw-alias-state-error-primary,#e5534b)}
.qqdy-btn[data-danger]:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5534b) 12%,transparent)}
.qqdy-btnMini{height:24px;padding:0 8px;font-size:11px;border-radius:7px}
.qqdy-switchRow{display:inline-flex;align-items:center;gap:8px;border:0;background:transparent;color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:12px;line-height:18px;padding:0;cursor:pointer;white-space:nowrap}
.qqdy-switchRow:disabled{cursor:default;opacity:.5}
.qqdy-switchRow:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4f8cff);outline-offset:2px}
.qqdy-switch{position:relative;display:inline-block;flex:none;width:36px;height:20px;border-radius:10px;background:var(--dsw-alias-state-idle-primary,rgba(128,128,128,.5));transition:background-color .15s}
.qqdy-switch[data-on=true]{background:var(--dsw-alias-state-business-primary,#4f8cff)}
.qqdy-switchThumb{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground,#fff);transition:transform .15s}
.qqdy-switch[data-on=true] .qqdy-switchThumb{transform:translateX(16px)}
.qqdy-bar{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:9px;border:1px solid transparent;font-size:12px;line-height:18px}
.qqdy-barText{flex:1;min-width:0;overflow-wrap:anywhere}
.qqdy-bar[data-tone=ok]{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2eb872) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2eb872) 8%,transparent);color:var(--dsw-alias-state-success-primary,#2eb872)}
.qqdy-bar[data-tone=warn]{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#e0a10a) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#e0a10a) 10%,transparent);color:var(--dsw-alias-state-warn-primary,#e0a10a)}
.qqdy-barError{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5534b) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5534b) 8%,transparent);color:var(--dsw-alias-state-error-primary,#e5534b)}
.qqdy-loading{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;min-height:200px;text-align:center}
.qqdy-center{align-items:center;text-align:center}
.qqdy-spinner{width:20px;height:20px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-top-color:var(--dsw-alias-state-business-primary,#4f8cff);animation:qqdy-spin .8s linear infinite}
@keyframes qqdy-spin{to{transform:rotate(360deg)}}
.qqdy-peers{display:flex;flex-direction:column;gap:8px;min-width:0;padding:10px;border-radius:9px;border:1px dashed var(--dsw-alias-border-l2,rgba(128,128,128,.3));background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.05))}
.qqdy-peerList{display:flex;flex-direction:column;gap:2px;min-width:0;max-height:240px;overflow:auto}
.qqdy-peer{display:flex;align-items:center;gap:8px;box-sizing:border-box;width:100%;min-width:0;padding:6px 8px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:12px;line-height:18px;text-align:left;cursor:pointer;appearance:none}
.qqdy-peer:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.2))}
.qqdy-peer:disabled{opacity:.5;cursor:default}
.qqdy-peer:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4f8cff);outline-offset:1px}
.qqdy-peer[data-picked]{border-color:var(--dsw-alias-state-business-primary,#4f8cff);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4f8cff) 12%,transparent)}
.qqdy-peerName{flex:none;max-width:140px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qqdy-peerSub{flex:1;min-width:0;font-size:11px;color:var(--dsw-alias-label-caption,inherit);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qqdy-healthList{display:flex;flex-direction:column;gap:6px;min-width:0}
.qqdy-healthRow{display:flex;align-items:flex-start;gap:8px;min-width:0}
.qqdy-healthLabel{flex:none;width:44px;font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary,inherit)}
.qqdy-healthText{flex:1;min-width:0;font-size:12px;line-height:18px;overflow-wrap:anywhere}
.qqdy-healthText[data-tone=ok]{color:var(--dsw-alias-state-success-primary,#2eb872)}
.qqdy-healthText[data-tone=warn]{color:var(--dsw-alias-state-warn-primary,#e0a10a)}
.qqdy-healthText[data-tone=bad]{color:var(--dsw-alias-state-error-primary,#e5534b)}
.qqdy-healthText[data-tone=off]{color:var(--dsw-alias-label-tertiary,inherit)}
.qqdy-warnText{margin:0;padding:7px 9px;border-radius:8px;font-size:11px;line-height:17px;color:var(--dsw-alias-state-warn-primary,#e0a10a);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#e0a10a) 10%,transparent);overflow-wrap:anywhere}
.qqdy-errorText{margin:0;font-size:11px;line-height:17px;color:var(--dsw-alias-state-error-primary,#e5534b);overflow-wrap:anywhere}
.qqdy-logList{display:flex;flex-direction:column;gap:3px;margin:0;padding:0;list-style:none;min-width:0;max-height:240px;overflow:auto}
.qqdy-logRow{display:flex;align-items:baseline;gap:8px;min-width:0;padding:4px 6px;border-radius:6px;background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.06))}
.qqdy-logTime{flex:none;font-size:11px;line-height:17px;color:var(--dsw-alias-label-caption,inherit);font-variant-numeric:tabular-nums}
.qqdy-logDir{flex:none;width:16px;text-align:center;font-size:12px;line-height:17px;color:var(--dsw-alias-state-business-primary,#4f8cff)}
.qqdy-logDir[data-dir=qd]{color:var(--dsw-alias-state-success-primary,#2eb872)}
.qqdy-logDir[data-dir=sys]{color:var(--dsw-alias-label-tertiary,inherit)}
.qqdy-logText{flex:1;min-width:0;font-size:12px;line-height:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qqdy-logFail{flex:none;font-size:10px;line-height:16px;padding:0 5px;border-radius:5px;color:var(--dsw-alias-state-error-primary,#e5534b);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5534b) 12%,transparent)}
.qqdy-bullets{display:flex;flex-direction:column;gap:4px;margin:0;padding-left:18px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,inherit)}
.qqdy-bullets li{overflow-wrap:anywhere}
.qqdy-pre{margin:0;padding:8px 10px;max-height:180px;overflow:auto;border-radius:8px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:16px;white-space:pre-wrap;word-break:break-word;background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.1));color:var(--dsw-alias-label-secondary,inherit)}
@media (prefers-reduced-motion:reduce){.qqdy-switch,.qqdy-switchThumb{transition:none}.qqdy-spinner{animation:none}}
`

    // =========================================================================
    // 小工具（纯函数，不碰 React）
    // =========================================================================

    /** 安全取字符串。 */
    function asString(value) {
      return typeof value === 'string' ? value : ''
    }

    /** 安全取有限数字。 */
    function asNumber(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value : 0
    }

    /** 安全取对象（数组 / null 都当空对象）。 */
    function asObject(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
    }

    /** 把宿主返回的 `binding` 规整成固定形状（缺什么都给默认值）。 */
    function normalizeBinding(raw) {
      const source = asObject(raw)
      const douyin = asObject(source.douyin)
      const qq = asObject(source.qq)
      return {
        douyin: { nick: asString(douyin.nick), sec_uid: asString(douyin.sec_uid) },
        qq: {
          kind: qq.kind === 'group' ? 'group' : 'private',
          id: asString(qq.id),
          label: asString(qq.label),
        },
      }
    }

    /** 方向开关：缺省都开着（与宿主默认一致）。 */
    function normalizeDirection(raw) {
      const source = asObject(raw)
      return { douyinToQQ: source.douyinToQQ !== false, qqToDouyin: source.qqToDouyin !== false }
    }

    /**
     * 链接分享设置（CONTRACT §7.1 / §7.6）：宿主没给 `links`、缺字段、给了越界值时
     * 都回默认，不让页面拿半截字段渲染。`autoCard` / `skipCards` 只有明确 false 才算关。
     * `skipCards` 来自 `state.inbound`（v0.6：抖音分享视频卡片不转 QQ）。
     */
    function normalizeLinks(raw, rawInbound) {
      const source = asObject(raw)
      const inbound = asObject(rawInbound)
      const autoOpen = source.autoOpen === 'off' || source.autoOpen === 'always'
        ? source.autoOpen
        : 'private'
      const rawCooldown = source.cooldownSec
      const cooldownSec = typeof rawCooldown === 'number' && Number.isFinite(rawCooldown)
        ? Math.min(LINK_COOLDOWN_MAX, Math.max(LINK_COOLDOWN_MIN, Math.round(rawCooldown)))
        : DEFAULT_LINKS.cooldownSec
      return { autoCard: source.autoCard !== false, autoOpen, cooldownSec, skipCards: inbound.skipCards !== false, fetchVideo: source.fetchVideo !== false, autoUnderstand: source.autoUnderstand !== false }
    }

    /**
     * 规整 PublicState（CONTRACT §1）。结构不对返回 null，让调用方报「不完整」，
     * 而不是拿半截字段去渲染。
     */
    function normalizeState(raw) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
      const binding = normalizeBinding(raw.binding)
      const stats = asObject(raw.stats)
      const filter = raw.filter === 'all' || raw.filter === 'prefix' || raw.filter === 'quote'
        ? raw.filter
        : 'quote'
      const pollMs = asNumber(raw.pollMs)
      return {
        version: asNumber(raw.version),
        enabled: raw.enabled === true,
        configured: raw.configured === true
          || (binding.douyin.sec_uid !== '' && binding.qq.id !== ''),
        binding,
        filter,
        prefix: asString(raw.prefix) === '' ? DEFAULT_PREFIX : asString(raw.prefix),
        direction: normalizeDirection(raw.direction),
        links: normalizeLinks(raw.links, raw.inbound),
        pollMs: pollMs >= 1000 ? pollMs : 15000,
        stats: {
          dq: asNumber(stats.dq),
          qd: asNumber(stats.qd),
          lastRunAt: asString(stats.lastRunAt) === '' ? null : asString(stats.lastRunAt),
          lastDqAt: asString(stats.lastDqAt) === '' ? null : asString(stats.lastDqAt),
          lastQdAt: asString(stats.lastQdAt) === '' ? null : asString(stats.lastQdAt),
          errors: asNumber(stats.errors),
        },
        lastError: asString(raw.lastError),
        qqApiBase: asString(raw.qqApiBase),
        douyinApiBase: asString(raw.douyinApiBase),
        storePath: asString(raw.storePath),
      }
    }

    /** 规整 Health（CONTRACT §1）。 */
    function normalizeHealth(raw) {
      const source = asObject(raw)
      const qq = asObject(source.qq)
      const douyin = asObject(source.douyin)
      const peer = asObject(source.peer)
      const next = source.nextSyncInMs
      return {
        qq: {
          ok: qq.ok === true,
          uin: asString(qq.uin),
          nick: asString(qq.nick),
          error: asString(qq.error),
        },
        douyin: {
          ok: douyin.ok === true,
          loggedIn: douyin.loggedIn === true,
          nick: asString(douyin.nick),
          uid: asString(douyin.uid),
          error: asString(douyin.error),
        },
        peer: {
          ok: peer.ok === true,
          nick: asString(peer.nick),
          count: asNumber(peer.count),
          lastThem: asString(peer.lastThem),
          error: asString(peer.error),
        },
        aiOverlap: source.aiOverlap === true,
        running: source.running === true,
        nextSyncInMs: typeof next === 'number' && Number.isFinite(next) ? next : null,
      }
    }

    /** 规整 LogRow[]（CONTRACT §1），坏行直接丢。 */
    function normalizeLog(raw) {
      if (!Array.isArray(raw)) return []
      const rows = []
      for (const item of raw) {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
        const dir = item.dir === 'dq' || item.dir === 'qd' || item.dir === 'sys' ? item.dir : 'sys'
        rows.push({
          at: asString(item.at),
          dir,
          ok: item.ok !== false,
          text: asString(item.text),
          note: asString(item.note),
        })
      }
      return rows
    }

    /** 规整 PeerRow[]（CONTRACT §1）：不给人点不该点的东西。 */
    function normalizePeers(raw) {
      if (!Array.isArray(raw)) return []
      const rows = []
      for (const item of raw) {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
        const secUid = asString(item.sec_uid)
        const nick = asString(item.nick)
        if (secUid === '' && nick === '') continue
        rows.push({
          nick,
          sec_uid: secUid,
          // has_id / is_group 由宿主判定（CONTRACT §1：这两种不能绑）；
          // 不在这里「猜」——宿主要是不给，就当不能绑。
          has_id: item.has_id === true,
          duplicate: item.duplicate === true,
          is_group: item.is_group === true,
        })
      }
      return rows
    }

    /** ISO 时间 → 本地 HH:mm:ss（CONTRACT §2 要求）。 */
    function formatClock(value) {
      if (value === '') return '--:--:--'
      const date = new Date(value)
      if (!Number.isFinite(date.getTime())) return '--:--:--'
      const pad = (number) => (number < 10 ? '0' + number : String(number))
      return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
    }

    /** 从失败响应里抽一句人话（CONTRACT §1：error 可能是字符串或对象）。 */
    function payloadError(payload, t) {
      const source = asObject(payload)
      let message = ''
      let detail = ''
      const raw = source.error
      if (typeof raw === 'string') {
        message = raw
      } else if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        message = asString(raw.message) === '' ? asString(raw.error) : asString(raw.message)
        detail = asString(raw.detail)
      }
      if (asString(source.detail) !== '') detail = asString(source.detail)
      if (message === '') message = t('error.badPayload')
      return detail === '' ? message : t('error.withDetail', { message, detail })
    }

    /** 状态 → 绑定表单（首次加载 / 绑定 / 解绑后同步一次）。 */
    function formFromState(state) {
      return {
        douyinNick: state.binding.douyin.nick,
        secUid: state.binding.douyin.sec_uid,
        qqKind: state.binding.qq.kind,
        qqId: state.binding.qq.id,
        qqLabel: state.binding.qq.label,
        filter: state.filter,
        prefix: state.prefix,
        douyinToQQ: state.direction.douyinToQQ,
        qqToDouyin: state.direction.qqToDouyin,
      }
    }

    /** `state.links`（+ `state.inbound`）→ 链接分享表单草稿（冷却秒数转字符串，数字输入框里好编辑）。 */
    function formFromLinks(links) {
      return {
        autoCard: links.autoCard === true,
        autoOpen: links.autoOpen,
        cooldownSec: String(links.cooldownSec),
        skipCards: links.skipCards === true,
        fetchVideo: links.fetchVideo !== false,
        autoUnderstand: links.autoUnderstand !== false,
      }
    }

    /** 冷却秒数：10–600 的整数；空串 / 小数 / 越界都返回 null（保存前拦下来）。 */
    function parseCooldownSec(value) {
      const text = asString(value).trim()
      if (!/^\d+$/.test(text)) return null
      const number = Number(text)
      if (number < LINK_COOLDOWN_MIN || number > LINK_COOLDOWN_MAX) return null
      return number
    }

    /** 宿主的 links 与当前草稿内容一致吗（草稿里的冷却秒是字符串）。 */
    function sameLinksDraft(links, draft) {
      return links.autoCard === draft.autoCard
        && links.autoOpen === draft.autoOpen
        && links.cooldownSec === parseCooldownSec(draft.cooldownSec)
        && links.skipCards === draft.skipCards
        && links.fetchVideo === draft.fetchVideo
        && links.autoUnderstand === draft.autoUnderstand
    }

    /** 绑定摘要：「抖音 · 小王 ↔ QQ · 西嗨（私聊）」；没绑齐返回空串。 */
    function bindingSummary(state, t) {
      const douyin = state.binding.douyin
      const qq = state.binding.qq
      if (douyin.sec_uid === '' || qq.id === '') return ''
      const left = t('status.summaryDouyin', { nick: douyin.nick === '' ? '—' : douyin.nick })
      const right = t('status.summaryQq', { label: qq.label === '' ? qq.id : qq.label })
      const kind = t(qq.kind === 'group' ? 'status.kindGroup' : 'status.kindPrivate')
      return t('status.summary', { douyin: left, qq: right, kind })
    }

    /**
     * 一次 JSON 往返。绝不 throw：网络错误、404、非 200、ok:false 都变成
     * `{ ok:false, message }`，组件只负责显示。
     */
    async function requestJson(path, options, t) {
      const init = { credentials: 'same-origin', cache: 'no-store' }
      if (options !== undefined && options !== null) {
        if (options.method === 'POST') {
          init.method = 'POST'
          init.headers = { 'content-type': 'application/json' }
          init.body = JSON.stringify(options.body === undefined ? {} : options.body)
        }
      }
      let response
      try {
        response = await fetch(API + path, init)
      } catch (error) {
        return { ok: false, message: t('error.network') }
      }
      let payload = null
      try {
        payload = await response.json()
      } catch (error) {
        payload = null
      }
      // 路由不存在 = 宿主半端没加载（CONTRACT §1 前缀是全的，404 只可能是这个）。
      if (response.status === 404) {
        return { ok: false, message: t('error.hostMissing'), hostMissing: true }
      }
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        return {
          ok: false,
          message: response.ok ? t('error.badPayload') : t('error.http', { status: response.status }),
        }
      }
      if (payload.ok !== true) {
        return {
          ok: false,
          message: payloadError(payload, t),
          needLogin: payload.needLogin === true,
          payload,
        }
      }
      return { ok: true, payload }
    }

    /** 把 CONTRACT §1 的路由包成一组方法；只给这一页用。 */
    function createApi(t) {
      const call = (path, options) => requestJson(path, options, t)
      return {
        getState: () => call('/state'),
        getLog: () => call('/log'),
        getPeers: () => call('/peers'),
        setConfig: (patch) => call('/config', { method: 'POST', body: patch }),
        bind: (body) => call('/bind', { method: 'POST', body }),
        unbind: () => call('/unbind', { method: 'POST', body: {} }),
        sync: () => call('/sync', { method: 'POST', body: {} }),
        test: () => call('/test', { method: 'POST', body: {} }),
        send: (body) => call('/send', { method: 'POST', body }),
      }
    }

    // =========================================================================
    // 小组件
    // =========================================================================

    function Badge({ tone, children }) {
      return h('span', { className: 'qqdy-badge', 'data-tone': tone === undefined ? 'neutral' : tone }, children)
    }

    function ErrorStrip({ message, onDismiss, t }) {
      return h('div', { className: 'qqdy-bar qqdy-barError', role: 'alert' },
        h('span', { className: 'qqdy-barText' }, message),
        h('button', {
          type: 'button',
          className: 'qqdy-btn qqdy-btnMini',
          onClick: onDismiss,
        }, t('dismiss')))
    }

    function NoticeBar({ tone, text, onDismiss, t }) {
      return h('div', { className: 'qqdy-bar', 'data-tone': tone === undefined ? 'ok' : tone },
        h('span', { className: 'qqdy-barText' }, text),
        h('button', {
          type: 'button',
          className: 'qqdy-btn qqdy-btnMini',
          onClick: onDismiss,
        }, t('dismiss')))
    }

    function SwitchControl({ t, checked, disabled, onToggle, label, hint }) {
      // label/hint 可覆盖默认的「总开关」文案；不传就保持原来的总开关行为。
      const labelText = label === undefined ? t('status.toggle') : label
      const titleText = hint !== undefined ? hint : (label === undefined ? t('status.toggleHint') : undefined)
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked === true,
        className: 'qqdy-switchRow',
        disabled: disabled === true,
        title: titleText,
        onClick: onToggle,
      },
      h('span', null, labelText),
      h('span', { className: 'qqdy-switch', 'data-on': checked === true, 'aria-hidden': 'true' },
        h('span', { className: 'qqdy-switchThumb' })))
    }

    function TextField({ label, value, placeholder, onChange, disabled, mono }) {
      return h('label', { className: 'qqdy-field' },
        h('span', { className: 'qqdy-fieldLabel' }, label),
        h('input', {
          type: 'text',
          className: mono === true ? 'qqdy-input qqdy-mono' : 'qqdy-input',
          value: value === undefined || value === null ? '' : value,
          placeholder: placeholder === undefined ? '' : placeholder,
          spellCheck: false,
          disabled: disabled === true,
          onChange: (event) => onChange(event.target.value),
        }))
    }

    function RadioOption({ name, checked, label, onChange }) {
      return h('label', { className: 'qqdy-check' },
        h('input', {
          type: 'radio',
          name,
          checked: checked === true,
          onChange: () => onChange(true),
        }),
        h('span', null, label))
    }

    function CheckOption({ checked, label, onChange }) {
      return h('label', { className: 'qqdy-check' },
        h('input', {
          type: 'checkbox',
          checked: checked === true,
          onChange: (event) => onChange(event.target.checked),
        }),
        h('span', null, label))
    }

    function healthRow(label, text, tone) {
      return h('div', { className: 'qqdy-healthRow' },
        h('span', { className: 'qqdy-healthLabel' }, label),
        h('span', { className: 'qqdy-healthText', 'data-tone': tone }, text))
    }

    // =========================================================================
    // 页面五个区
    // =========================================================================

    /** ① 顶部状态条：总开关 + 运行/绑定徽标 + 绑定摘要。 */
    function StatusCard({ t, state, health, busy, onToggle }) {
      const summary = bindingSummary(state, t)
      // 这行说的是「页面」的刷新节奏（固定 10s），不是宿主的轮询节奏。
      const pageSec = Math.max(1, Math.round(POLL_INTERVAL_MS / 1000))
      return h('section', { className: 'qqdy-card' },
        h('div', { className: 'qqdy-head' },
          h('div', { className: 'qqdy-headText' },
            h('h2', { className: 'qqdy-title' }, t('title')),
            h('p', { className: 'qqdy-sub' }, t('subtitle'))),
          h(SwitchControl, {
            t,
            checked: state.enabled,
            disabled: busy === 'config',
            onToggle,
          })),
        h('div', { className: 'qqdy-badges' },
          h(Badge, { tone: state.enabled ? 'ok' : 'off' },
            t(state.enabled ? 'status.on' : 'status.off')),
          h(Badge, { tone: health.running ? 'busy' : 'off' },
            t(health.running ? 'status.running' : 'status.stopped')),
          h(Badge, { tone: state.configured ? 'ok' : 'warn' },
            t(state.configured ? 'status.bound' : 'status.unbound'))),
        h('p', { className: 'qqdy-summary' },
          summary === '' ? t('status.summaryUnbound') : summary),
        h('p', { className: 'qqdy-meta' },
          t('status.stats', { dq: state.stats.dq, qd: state.stats.qd })),
        h('p', { className: 'qqdy-hint' },
          t('status.poll', { sec: pageSec })))
    }

    /** ② 绑定卡片：抖音侧 + QQ 侧 + 规则 + 方向 + 保存。 */
    function BindCard({
      t,
      state,
      form,
      busy,
      peers,
      peersOpen,
      canForce,
      onUpdateForm,
      onReadPeers,
      onTogglePeers,
      onPickPeer,
      onSave,
      onForceBind,
    }) {
      const busyPeers = busy === 'peers'
      const busyBind = busy === 'bind'
      const filterHint = form.filter === 'all'
        ? t('bind.filterHintAll')
        : (form.filter === 'prefix' ? t('bind.filterHintPrefix') : t('bind.filterHintQuote'))
      return h('section', { className: 'qqdy-card' },
        h('div', { className: 'qqdy-head' },
          h('div', { className: 'qqdy-headText' },
            h('h3', { className: 'qqdy-title' }, t('bind.title')),
            h('p', { className: 'qqdy-sub' },
              state.configured ? t('bind.overwriteHint') : t('bind.unboundDraft')))),

        h('hr', { className: 'qqdy-divider' }),
        h('h4', { className: 'qqdy-labelStrong' }, t('bind.douyinTitle')),
        h('p', { className: 'qqdy-hint' }, t('bind.douyinHint')),
        h('div', { className: 'qqdy-grid2' },
          h(TextField, {
            label: t('bind.douyinNick'),
            value: form.douyinNick,
            placeholder: t('bind.douyinNickPlaceholder'),
            onChange: (value) => onUpdateForm({ douyinNick: value }),
          }),
          h(TextField, {
            label: t('bind.secUid'),
            value: form.secUid,
            placeholder: t('bind.secUidPlaceholder'),
            mono: true,
            onChange: (value) => onUpdateForm({ secUid: value }),
          })),
        h('p', { className: 'qqdy-hint' }, t('bind.secUidHint')),
        h('div', { className: 'qqdy-row' },
          h('button', {
            type: 'button',
            className: 'qqdy-btn',
            disabled: busyPeers || busy !== '',
            onClick: onReadPeers,
          }, busyPeers ? t('bind.readingPeers') : t('bind.readPeers')),
          h('span', { className: 'qqdy-grow qqdy-hint' }, t('bind.peersSlow'))),
        peersOpen === true
          ? h(PeerPicker, {
            t,
            peers,
            form,
            busy,
            onPickPeer,
            onReload: onReadPeers,
            onClose: onTogglePeers,
          })
          : null,

        h('hr', { className: 'qqdy-divider' }),
        h('h4', { className: 'qqdy-labelStrong' }, t('bind.qqTitle')),
        h('div', { className: 'qqdy-row' },
          h(RadioOption, {
            name: 'qqdy-qq-kind',
            checked: form.qqKind === 'private',
            label: t('bind.qqKindPrivate'),
            onChange: () => onUpdateForm({ qqKind: 'private' }),
          }),
          h(RadioOption, {
            name: 'qqdy-qq-kind',
            checked: form.qqKind === 'group',
            label: t('bind.qqKindGroup'),
            onChange: () => onUpdateForm({ qqKind: 'group' }),
          })),
        h('div', { className: 'qqdy-grid2' },
          h(TextField, {
            label: form.qqKind === 'group' ? t('bind.qqIdGroup') : t('bind.qqIdPrivate'),
            value: form.qqId,
            placeholder: t('bind.qqIdPlaceholder'),
            mono: true,
            onChange: (value) => onUpdateForm({ qqId: value }),
          }),
          h(TextField, {
            label: t('bind.qqLabel'),
            value: form.qqLabel,
            placeholder: t('bind.qqLabelPlaceholder'),
            onChange: (value) => onUpdateForm({ qqLabel: value }),
          })),

        h('hr', { className: 'qqdy-divider' }),
        h('h4', { className: 'qqdy-labelStrong' }, t('bind.ruleTitle')),
        h('div', { className: 'qqdy-grid2' },
          h('label', { className: 'qqdy-field' },
            h('span', { className: 'qqdy-fieldLabel' }, t('bind.filter')),
            h('select', {
              className: 'qqdy-select',
              value: form.filter,
              onChange: (event) => onUpdateForm({ filter: event.target.value }),
            },
            h('option', { value: 'all' }, t('bind.filterAll')),
            h('option', { value: 'quote' }, t('bind.filterQuote')),
            h('option', { value: 'prefix' }, t('bind.filterPrefix')))),
          h(TextField, {
            label: t('bind.prefix'),
            value: form.prefix,
            placeholder: t('bind.prefixPlaceholder'),
            disabled: form.filter !== 'prefix',
            onChange: (value) => onUpdateForm({ prefix: value }),
          })),
        h('p', { className: 'qqdy-hint' }, filterHint),
        form.filter !== 'prefix'
          ? h('p', { className: 'qqdy-hint' }, t('bind.prefixDisabled'))
          : h('p', { className: 'qqdy-hint' }, t('bind.prefixHint')),

        h('hr', { className: 'qqdy-divider' }),
        h('h4', { className: 'qqdy-labelStrong' }, t('bind.directionTitle')),
        h('div', { className: 'qqdy-row' },
          h(CheckOption, {
            checked: form.douyinToQQ,
            label: t('bind.directionDq'),
            onChange: (checked) => onUpdateForm({ douyinToQQ: checked }),
          }),
          h(CheckOption, {
            checked: form.qqToDouyin,
            label: t('bind.directionQd'),
            onChange: (checked) => onUpdateForm({ qqToDouyin: checked }),
          }),
          h('span', { className: 'qqdy-hint' }, t('bind.directionHint'))),
        h('div', { className: 'qqdy-row' },
          h('button', {
            type: 'button',
            className: 'qqdy-btn',
            'data-primary': '',
            disabled: busyBind || busy !== '',
            onClick: () => onSave(),
          }, busyBind ? t('bind.saving') : t('bind.save'))),
        canForce === true
          ? h('div', { className: 'qqdy-row' },
            h('p', { className: 'qqdy-warnText qqdy-grow' }, t('bind.canForceHint')),
            h('button', {
              type: 'button',
              className: 'qqdy-btn',
              disabled: busy !== '',
              onClick: onForceBind,
            }, t('bind.force')))
          : null)
    }

    /** ②-1 抖音会话点选列表（慢接口，加载中要把话说清楚）。 */
    function PeerPicker({ t, peers, form, busy, onPickPeer, onReload, onClose }) {
      const loading = peers !== null && peers.loading === true
      const rows = peers !== null && Array.isArray(peers.rows) ? peers.rows : []
      const errorText = peers !== null && asString(peers.error) !== '' ? peers.error : ''
      // 宿主读不到抖音面板时会退回本机聊过的人，并带一句 warning —— 原样展示。
      const warningText = peers !== null && asString(peers.warning) !== '' ? peers.warning : ''
      return h('div', { className: 'qqdy-peers' },
        h('div', { className: 'qqdy-row' },
          h('span', { className: 'qqdy-labelStrong' },
            loading ? t('bind.readingPeers') : t('bind.peersTitle')),
          h('span', { className: 'qqdy-gap' }),
          rows.length > 0 ? h('span', { className: 'qqdy-hint' },
            t('bind.peersFound', { count: rows.length })) : null,
          h('button', {
            type: 'button',
            className: 'qqdy-btn qqdy-btnMini',
            disabled: loading || busy !== '',
            onClick: onReload,
          }, t('bind.peersAgain')),
          h('button', {
            type: 'button',
            className: 'qqdy-btn qqdy-btnMini',
            onClick: onClose,
          }, t('bind.peersClose'))),
        loading ? h('p', { className: 'qqdy-hint' }, t('bind.peersSlow')) : null,
        !loading && errorText !== '' ? h('p', { className: 'qqdy-errorText' }, errorText) : null,
        !loading && warningText !== '' ? h('p', { className: 'qqdy-warnText' }, warningText) : null,
        !loading && errorText === '' && rows.length === 0
          ? h('p', { className: 'qqdy-hint' }, t('bind.peersEmpty'))
          : null,
        rows.length > 0
          ? h('div', { className: 'qqdy-peerList' },
            rows.map((peer, index) => {
              const usable = peer.has_id === true && peer.is_group !== true
              const picked = form.secUid !== '' && form.secUid === peer.sec_uid
              const reason = peer.is_group === true
                ? t('bind.peerGroupDisabled')
                : (peer.has_id !== true ? t('bind.peerNoIdDisabled') : '')
              return h('button', {
                key: 'qqdy-peer-' + index + '-' + peer.sec_uid,
                type: 'button',
                className: 'qqdy-peer',
                'data-picked': picked ? '' : undefined,
                disabled: !usable || busy !== '',
                title: reason === '' ? (peer.nick === '' ? peer.sec_uid : peer.nick) : reason,
                onClick: () => onPickPeer(peer),
              },
              h('span', { className: 'qqdy-peerName' },
                peer.nick === '' ? t('bind.peerUnnamed') : peer.nick),
              peer.duplicate ? h('span', { className: 'qqdy-badge' },
                t('bind.peerDuplicate')) : null,
              peer.is_group ? h('span', { className: 'qqdy-badge' },
                t('bind.peerGroup')) : null,
              peer.has_id !== true ? h('span', { className: 'qqdy-badge' },
                t('bind.peerNoId')) : null,
              h('span', { className: 'qqdy-peerSub' }, peer.sec_uid))
            }))
          : null,
        !loading && rows.length > 0
          ? h('p', { className: 'qqdy-hint' }, t('bind.peersDisabledHint'))
          : null)
    }

    /** ②-2 链接分享卡片：QQ 里出现的抖音视频链接怎么处理（CONTRACT §7.5）。 */
    function LinksCard({ t, form, busy, onUpdateForm, onSave }) {
      const saving = busy === 'links'
      return h('section', { className: 'qqdy-card' },
        h('h3', { className: 'qqdy-title' }, t('links.title')),
        h('div', { className: 'qqdy-row' },
          h(SwitchControl, {
            t,
            checked: form.autoCard === true,
            disabled: saving,
            label: t('links.autoCard'),
            onToggle: () => onUpdateForm({ autoCard: form.autoCard !== true }),
          })),
        h('div', { className: 'qqdy-row' },
          h(SwitchControl, {
            t,
            checked: form.fetchVideo === true,
            disabled: saving,
            label: t('links.fetchVideo'),
            onToggle: () => onUpdateForm({ fetchVideo: form.fetchVideo !== true }),
          })),
        h('div', { className: 'qqdy-row' },
          h(SwitchControl, {
            t,
            checked: form.autoUnderstand === true,
            disabled: saving,
            label: t('links.autoUnderstand'),
            onToggle: () => onUpdateForm({ autoUnderstand: form.autoUnderstand !== true }),
          })),
        h('div', { className: 'qqdy-row' },
          h(SwitchControl, {
            t,
            checked: form.skipCards === true,
            disabled: saving,
            label: t('links.skipCards'),
            onToggle: () => onUpdateForm({ skipCards: form.skipCards !== true }),
          })),
        h('div', { className: 'qqdy-grid2' },
          h('label', { className: 'qqdy-field' },
            h('span', { className: 'qqdy-fieldLabel' }, t('links.autoOpen')),
            h('select', {
              className: 'qqdy-select',
              value: form.autoOpen,
              disabled: saving,
              onChange: (event) => onUpdateForm({ autoOpen: event.target.value }),
            },
            h('option', { value: 'off' }, t('links.autoOpenOff')),
            h('option', { value: 'private' }, t('links.autoOpenPrivate')),
            h('option', { value: 'always' }, t('links.autoOpenAlways')))),
          h('label', { className: 'qqdy-field' },
            h('span', { className: 'qqdy-fieldLabel' }, t('links.cooldown')),
            h('input', {
              type: 'number',
              className: 'qqdy-input',
              value: form.cooldownSec,
              min: LINK_COOLDOWN_MIN,
              max: LINK_COOLDOWN_MAX,
              step: 1,
              inputMode: 'numeric',
              disabled: saving,
              onChange: (event) => onUpdateForm({ cooldownSec: event.target.value }),
            }))),
        h('p', { className: 'qqdy-hint' }, t('links.hint')),
        h('div', { className: 'qqdy-row' },
          h('button', {
            type: 'button',
            className: 'qqdy-btn',
            'data-primary': '',
            disabled: busy !== '',
            onClick: onSave,
          }, saving ? t('links.saving') : t('links.save'))))
    }

    /** ③ 健康卡片：QQ / 抖音 / 对端 / aiOverlap 提醒。 */
    function HealthCard({ t, state, health, busy, onCheck }) {
      const checking = busy === 'check'
      const qqText = health.qq.ok === true
        ? t('health.qqOk', {
          nick: health.qq.nick === '' ? '—' : health.qq.nick,
          uin: health.qq.uin === '' ? '—' : health.qq.uin,
        })
        : t('health.qqBad', { error: health.qq.error === '' ? '—' : health.qq.error })
      let douyinText
      let douyinTone
      if (health.douyin.ok === true && health.douyin.loggedIn === true) {
        douyinTone = 'ok'
        douyinText = t('health.douyinOk', {
          nick: health.douyin.nick === '' ? '—' : health.douyin.nick,
        })
      } else if (health.douyin.ok === true && health.douyin.loggedIn !== true) {
        douyinTone = 'warn'
        douyinText = t('health.douyinNotLoggedIn')
      } else {
        douyinTone = 'bad'
        douyinText = t('health.douyinBad', {
          error: health.douyin.error === '' ? '—' : health.douyin.error,
        })
      }
      let peerText
      let peerTone
      if (state.configured !== true) {
        peerTone = 'off'
        peerText = t('health.peerUnbound')
      } else if (health.peer.ok === true) {
        peerTone = 'ok'
        peerText = health.peer.count > 0
          ? t('health.peerOk', {
            nick: health.peer.nick === '' ? '—' : health.peer.nick,
            count: health.peer.count,
            text: health.peer.lastThem === '' ? '—' : health.peer.lastThem,
          })
          : t('health.peerEmpty', {
            nick: health.peer.nick === '' ? '—' : health.peer.nick,
          })
      } else {
        peerTone = 'bad'
        peerText = t('health.peerBad', {
          error: health.peer.error === '' ? '—' : health.peer.error,
        })
      }
      const pollSec = Math.max(1, Math.round(state.pollMs / 1000))
      const runText = health.running === true
        ? t('health.running', {
          sec: pollSec,
          next: health.nextSyncInMs === null ? '—' : Math.max(0, Math.round(health.nextSyncInMs / 1000)),
        })
        : t('health.stopped')
      return h('section', { className: 'qqdy-card' },
        h('div', { className: 'qqdy-head' },
          h('div', { className: 'qqdy-headText' },
            h('h3', { className: 'qqdy-title' }, t('health.title'))),
          h('button', {
            type: 'button',
            className: 'qqdy-btn qqdy-btnMini',
            disabled: checking || busy !== '',
            onClick: onCheck,
          }, checking ? t('health.checking') : t('health.check'))),
        h('div', { className: 'qqdy-healthList' },
          healthRow(t('health.qq'), qqText, health.qq.ok === true ? 'ok' : 'bad'),
          healthRow(t('health.douyin'), douyinText, douyinTone),
          healthRow(t('health.peer'), peerText, peerTone)),
        health.aiOverlap === true
          ? h('p', { className: 'qqdy-warnText' }, t('health.aiOverlap'))
          : null,
        h('p', { className: 'qqdy-hint' }, runText),
        state.stats.errors > 0
          ? h('p', { className: 'qqdy-hint' }, t('health.errors', { count: state.stats.errors }))
          : null,
        state.lastError !== ''
          ? h('p', { className: 'qqdy-errorText' },
            t('health.lastError', { error: state.lastError }))
          : null,
        h('p', { className: 'qqdy-hint' }, t('health.testHint')))
    }

    /** ④ 操作行：立即同步 / 发测试消息（二次确认）/ 解绑（两步）。 */
    function ActionsCard({
      t,
      state,
      busy,
      testSide,
      onTestSideChange,
      onSync,
      onSendTest,
      onUnbind,
      confirmUnbind,
      onCancelUnbind,
    }) {
      const idle = busy === ''
      const syncDisabled = state.configured !== true || !idle
      const sendDisabled = !idle
      const hint = confirmUnbind
        ? t('actions.unbindHint')
        : (state.configured === true ? t('actions.testHint') : t('actions.notBound'))
      return h('section', { className: 'qqdy-card' },
        h('h3', { className: 'qqdy-title' }, t('actions.title')),
        h('div', { className: 'qqdy-row' },
          h('button', {
            type: 'button',
            className: 'qqdy-btn',
            'data-primary': '',
            disabled: syncDisabled,
            title: state.configured === true ? '' : t('actions.syncDisabled'),
            onClick: onSync,
          }, busy === 'sync' ? t('actions.syncing') : t('actions.sync')),
          h('label', { className: 'qqdy-inlineField' },
            h('span', { className: 'qqdy-fieldLabel' }, t('actions.testSide')),
            h('select', {
              className: 'qqdy-select qqdy-selectMini',
              value: testSide,
              disabled: !idle,
              onChange: (event) => onTestSideChange(event.target.value === 'douyin' ? 'douyin' : 'qq'),
            },
            h('option', { value: 'qq' }, t('actions.sideQq')),
            h('option', { value: 'douyin' }, t('actions.sideDouyin')))),
          h('button', {
            type: 'button',
            className: 'qqdy-btn',
            disabled: sendDisabled,
            onClick: onSendTest,
          }, busy === 'send' ? t('actions.testing') : t('actions.test')),
          h('span', { className: 'qqdy-gap' }),
          confirmUnbind
            ? h(React.Fragment, null,
              h('button', {
                type: 'button',
                className: 'qqdy-btn',
                'data-danger': '',
                disabled: !idle,
                onClick: onUnbind,
              }, busy === 'unbind' ? t('actions.unbinding') : t('actions.unbindConfirm')),
              h('button', {
                type: 'button',
                className: 'qqdy-btn qqdy-btnMini',
                disabled: !idle,
                onClick: onCancelUnbind,
              }, t('actions.cancel')))
            : h('button', {
              type: 'button',
              className: 'qqdy-btn',
              'data-danger': '',
              disabled: !idle,
              onClick: onUnbind,
            }, t('actions.unbind'))),
        h('p', { className: 'qqdy-hint' }, hint))
    }

    /** ⑤ 最近记录：最近 8 条，HH:mm:ss + 方向箭头 + 文本省略。 */
    function LogCard({ t, log, busy, onRefresh }) {
      const rows = log.slice(0, LOG_LIMIT)
      return h('section', { className: 'qqdy-card' },
        h('div', { className: 'qqdy-head' },
          h('div', { className: 'qqdy-headText' },
            h('h3', { className: 'qqdy-title' }, t('log.title')),
            rows.length > 0 ? h('p', { className: 'qqdy-sub' },
              t('log.count', { count: rows.length })) : null),
          h('button', {
            type: 'button',
            className: 'qqdy-btn qqdy-btnMini',
            disabled: busy !== '',
            onClick: onRefresh,
          }, busy === 'log' ? t('refreshing') : t('refresh'))),
        rows.length === 0
          ? h('p', { className: 'qqdy-hint' }, t('log.empty'))
          : h('ul', { className: 'qqdy-logList' },
            rows.map((row, index) => {
              const arrow = row.dir === 'dq' ? '→' : (row.dir === 'qd' ? '←' : '·')
              const dirLabel = row.dir === 'dq'
                ? t('log.dirDq')
                : (row.dir === 'qd' ? t('log.dirQd') : t('log.dirSys'))
              return h('li', { key: 'qqdy-log-' + index, className: 'qqdy-logRow' },
                h('span', { className: 'qqdy-logTime' }, formatClock(row.at)),
                h('span', {
                  className: 'qqdy-logDir',
                  'data-dir': row.dir,
                  title: dirLabel,
                  'aria-label': dirLabel,
                }, arrow),
                h('span', {
                  className: 'qqdy-logText',
                  title: row.text,
                }, row.text === '' ? '—' : row.text),
                row.ok === true
                  ? null
                  : h('span', { className: 'qqdy-logFail' }, t('log.failed')))
            })))
    }

    /** ⑥ 安全说明：AI 抢话 / 专用群 / 首轮对表 / 本地存储。 */
    function SafetyCard({ t }) {
      return h('section', { className: 'qqdy-card' },
        h('h3', { className: 'qqdy-title' }, t('safety.title')),
        h('ul', { className: 'qqdy-bullets' },
          h('li', null, t('safety.ai')),
          h('li', null, t('safety.group')),
          h('li', null, t('safety.prime')),
          h('li', null, t('safety.local'))))
    }

    // =========================================================================
    // Error boundary —— 子组件抛错只显示「这页出错了」+「重试」，整页不消失
    // =========================================================================

    class PageBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null, attempt: 0 }
        this.retry = this.retry.bind(this)
      }

      static getDerivedStateFromError(error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }

      componentDidCatch(error, info) {
        if (typeof console !== 'undefined' && console.error !== undefined) {
          console.error('[dsh-qq-douyin-bridge] 设置页渲染出错：', error, info)
        }
      }

      retry() {
        this.setState((previous) => ({ error: null, attempt: previous.attempt + 1 }))
      }

      render() {
        const t = this.props.t
        if (this.state.error !== null) {
          return h('div', { className: 'qqdy-page' },
            h('div', { className: 'qqdy-card qqdy-center', role: 'alert' },
              h('h2', { className: 'qqdy-title' }, t('error.boundaryTitle')),
              h('p', { className: 'qqdy-sub' }, t('error.boundaryBody')),
              h('pre', { className: 'qqdy-pre' }, this.state.error),
              h('button', {
                type: 'button',
                className: 'qqdy-btn',
                'data-primary': '',
                onClick: this.retry,
              }, t('error.boundaryRetry'))))
        }
        const children = this.props.children
        if (children === null || children === undefined) return null
        // key 变化 → 子树重挂载，而不是保留坏掉的内部状态。
        return React.cloneElement(children, { key: 'qqdy-attempt-' + this.state.attempt })
      }
    }

    // =========================================================================
    // 主页面
    // =========================================================================

    function SettingsPage({ t, api }) {
      // ---- 数据 ----
      const [snapshot, setSnapshot] = React.useState(null)
      const [loaded, setLoaded] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      // ---- 绑定表单草稿（轮询不覆盖用户正在输入的内容）----
      const [form, setForm] = React.useState(EMPTY_FORM)
      // ---- 链接分享表单草稿（轮询不覆盖用户正在编辑的草稿）----
      const [linksForm, setLinksForm] = React.useState(EMPTY_LINKS_FORM)
      // ---- 抖音会话列表 ----
      const [peers, setPeers] = React.useState(null)
      const [peersOpen, setPeersOpen] = React.useState(false)
      // ---- 解绑两步确认 / 测试消息发到哪一侧 / 可强制绑定（宿主 canForce）----
      const [confirmUnbind, setConfirmUnbind] = React.useState(false)
      const [testSide, setTestSide] = React.useState('qq')
      const [canForce, setCanForce] = React.useState(false)

      const aliveRef = React.useRef(true)
      const loadedRef = React.useRef(false)
      const busyRef = React.useRef('')
      const seqRef = React.useRef(0)
      const formRef = React.useRef(EMPTY_FORM)
      const linksRef = React.useRef(EMPTY_LINKS_FORM)
      const linksDirtyRef = React.useRef(false)
      const loadRef = React.useRef(null)

      // 卸载后不再 setState（轮询 / 慢操作可能还在路上）。
      React.useEffect(() => {
        aliveRef.current = true
        return () => {
          aliveRef.current = false
        }
      }, [])

      /** 表单写入口：同时更新 ref（异步回调里读得到最新值）。 */
      const updateForm = (patch) => {
        const next = {}
        const keys = Object.keys(formRef.current)
        for (const key of keys) next[key] = formRef.current[key]
        const patchKeys = Object.keys(patch)
        for (const key of patchKeys) next[key] = patch[key]
        formRef.current = next
        setForm(next)
        // 改了表单，上一次「读不到对端，可以强制绑定」的提示就作废。
        setCanForce(false)
      }

      /** 用宿主状态复位表单（首次加载 / 绑定 / 解绑之后）。 */
      const syncForm = (state) => {
        const next = formFromState(state)
        formRef.current = next
        setForm(next)
      }

      /** 链接分享表单写入口：同时更新 ref，并标记「用户正在编辑」。 */
      const updateLinksForm = (patch) => {
        const next = {}
        const keys = Object.keys(linksRef.current)
        for (const key of keys) next[key] = linksRef.current[key]
        const patchKeys = Object.keys(patch)
        for (const key of patchKeys) next[key] = patch[key]
        linksRef.current = next
        linksDirtyRef.current = true
        setLinksForm(next)
      }

      /** 用宿主的 links 复位链接分享表单（首次加载 / 保存成功 / 宿主侧变了且用户没在编辑）。 */
      const syncLinksForm = (links) => {
        const next = formFromLinks(links)
        linksRef.current = next
        linksDirtyRef.current = false
        setLinksForm(next)
      }

      /** 拉一次 state（进页面一次 + 每 10 秒 + 操作后）。 */
      const loadState = async () => {
        if (busyRef.current !== '') return false
        const seq = seqRef.current + 1
        seqRef.current = seq
        const result = await api.getState()
        if (!aliveRef.current || seq !== seqRef.current || busyRef.current !== '') return false
        if (!result.ok) {
          setError(result.message)
          return false
        }
        const state = normalizeState(result.payload.state)
        if (state === null) {
          setError(t('error.badState'))
          return false
        }
        setSnapshot({
          state,
          health: normalizeHealth(result.payload.health),
          log: normalizeLog(result.payload.log),
        })
        setError(null)
        if (!loadedRef.current) {
          loadedRef.current = true
          setLoaded(true)
          syncForm(state)
          syncLinksForm(state.links)
        } else if (linksDirtyRef.current !== true && !sameLinksDraft(state.links, linksRef.current)) {
          // 宿主那边的 links 被别处改了（设置页另一处 / agent 的 link_config）就跟上；
          // 用户正在改的草稿绝不覆盖（与绑定表单同一套做法）。
          syncLinksForm(state.links)
        }
        return true
      }
      loadRef.current = loadState

      /** 统一包一次操作：置 busy、清提示、让在途轮询作废。 */
      const runOp = async (name, task) => {
        if (busyRef.current !== '') return null
        busyRef.current = name
        setBusy(name)
        setNotice(null)
        seqRef.current += 1
        let result
        try {
          result = await task()
        } catch (thrown) {
          result = {
            ok: false,
            message: thrown instanceof Error ? thrown.message : String(thrown),
          }
        }
        busyRef.current = ''
        if (aliveRef.current) setBusy('')
        return result
      }

      // ---- 轮询：进页面立即拉一次；每 10 秒一次；页面隐藏时跳过 ----
      React.useEffect(() => {
        let cancelled = false
        const pull = () => {
          if (cancelled) return
          if (typeof loadRef.current === 'function') loadRef.current()
        }
        pull()
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          pull()
        }, POLL_INTERVAL_MS)
        const onVisibilityChange = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'visible') pull()
        }
        if (typeof document !== 'undefined') {
          document.addEventListener('visibilitychange', onVisibilityChange)
        }
        return () => {
          cancelled = true
          clearInterval(timer)
          if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', onVisibilityChange)
          }
        }
      }, [])

      // ---- 总开关 ----
      const onToggleEnabled = async () => {
        if (snapshot === null) return
        const enabled = snapshot.state.enabled !== true
        const result = await runOp('config', () => api.setConfig({ enabled }))
        if (result === null || !aliveRef.current) return
        if (!result.ok) {
          setError(result.message)
          return
        }
        if (result.payload.state !== undefined) {
          const state = normalizeState(result.payload.state)
          if (state !== null) {
            setSnapshot((previous) => previous === null ? previous : {
              state,
              health: previous.health,
              log: previous.log,
            })
          }
        }
        // 宿主可能带 warnings（比如「开了但还没绑定，暂时不会转发」），原样并进提示。
        const warnings = Array.isArray(result.payload.warnings)
          ? result.payload.warnings.map((warning) => asString(warning)).filter((warning) => warning !== '')
          : []
        const baseText = enabled ? t('status.turnedOn') : t('status.turnedOff')
        setNotice({
          tone: warnings.length > 0 ? 'warn' : 'ok',
          text: warnings.length > 0 ? baseText + ' ' + warnings.join(' ') : baseText,
        })
        await loadRef.current()
      }

      // ---- 保存并绑定 ----
      // forceRequested 只在用户点了「仍然强制绑定」时为 true；平时一律先让宿主试读对端，
      // 读不到再由宿主回 canForce，避免把写错的 sec_uid 强绑上去。
      const onSaveBind = async (forceRequested) => {
        if (snapshot === null) return
        const draft = formRef.current
        const secUid = draft.secUid.trim()
        const qqId = draft.qqId.trim()
        if (secUid === '' || qqId === '') {
          setNotice({ tone: 'warn', text: t('bind.incomplete') })
          return
        }
        if (!/^\d{5,12}$/.test(qqId)) {
          setNotice({ tone: 'warn', text: t('bind.qqIdInvalid') })
          return
        }
        if (secUid.length < 6) {
          setNotice({ tone: 'warn', text: t('bind.secUidInvalid') })
          return
        }
        if (draft.filter === 'prefix' && draft.prefix.trim() === '') {
          setNotice({ tone: 'warn', text: t('bind.prefixRequired') })
          return
        }
        const body = {
          qq_kind: draft.qqKind,
          qq_id: qqId,
          qq_label: draft.qqLabel.trim(),
          douyin_sec_uid: secUid,
          douyin_nick: draft.douyinNick.trim(),
          filter: draft.filter,
          prefix: draft.prefix,
          direction: {
            douyinToQQ: draft.douyinToQQ === true,
            qqToDouyin: draft.qqToDouyin === true,
          },
          force: forceRequested === true,
        }
        const result = await runOp('bind', () => api.bind(body))
        if (result === null || !aliveRef.current) return
        if (!result.ok) {
          setError(result.message)
          // 宿主读不到对端私信时会带 canForce —— 让用户决定要不要强绑。
          setCanForce(result.payload !== undefined && asObject(result.payload).canForce === true)
          return
        }
        setCanForce(false)
        const state = result.payload.state === undefined
          ? null
          : normalizeState(result.payload.state)
        if (state !== null) {
          setSnapshot({ state, health: snapshot.health, log: snapshot.log })
          syncForm(state)
        }
        const preview = asObject(result.payload.preview)
        const lastThemText = asString(preview.last_them_text)
        let text
        if (lastThemText !== '') {
          text = t('bind.savedPreview', {
            count: asNumber(preview.them_count),
            text: lastThemText,
          })
        } else if (state !== null) {
          const summary = bindingSummary(state, t)
          text = summary === '' ? t('bind.savedShort') : t('bind.saved', { summary })
        } else {
          text = t('bind.savedShort')
        }
        setNotice({ tone: 'ok', text })
        setPeersOpen(false)
        await loadRef.current()
      }

      // ---- 保存链接分享设置（POST /config 的 links 字段，CONTRACT §7.1/§7.5）----
      const onSaveLinks = async () => {
        if (snapshot === null) return
        const draft = linksRef.current
        const cooldownSec = parseCooldownSec(draft.cooldownSec)
        if (cooldownSec === null) {
          setNotice({
            tone: 'warn',
            text: t('links.cooldownInvalid', { min: LINK_COOLDOWN_MIN, max: LINK_COOLDOWN_MAX }),
          })
          return
        }
        const autoOpen = draft.autoOpen === 'off' || draft.autoOpen === 'always'
          ? draft.autoOpen
          : 'private'
        const body = {
          links: {
            autoCard: draft.autoCard === true,
            autoOpen,
            cooldownSec,
            fetchVideo: draft.fetchVideo === true,
            autoUnderstand: draft.autoUnderstand === true,
          },
          inbound: {
            skipCards: draft.skipCards === true,
          },
        }
        const result = await runOp('links', () => api.setConfig(body))
        if (result === null || !aliveRef.current) return
        if (!result.ok) {
          setError(asString(result.message) === '' ? t('links.saveFailed') : result.message)
          return
        }
        const state = result.payload.state === undefined
          ? null
          : normalizeState(result.payload.state)
        if (state !== null) {
          setSnapshot((previous) => previous === null ? previous : {
            state,
            health: previous.health,
            log: previous.log,
          })
          syncLinksForm(state.links)
        } else {
          // 宿主没回 state：把草稿标成已保存，随后的轮询会从 state 校正。
          linksDirtyRef.current = false
        }
        setNotice({ tone: 'ok', text: t('links.saved') })
        await loadRef.current()
      }

      // ---- 立即同步 ----
      const onSync = async () => {
        if (snapshot === null || snapshot.state.configured !== true) return
        const result = await runOp('sync', () => api.sync())
        if (result === null || !aliveRef.current) return
        if (!result.ok) {
          setError(result.message)
          return
        }
        if (result.payload.state !== undefined) {
          const state = normalizeState(result.payload.state)
          if (state !== null) {
            setSnapshot((previous) => previous === null ? previous : {
              state,
              health: previous.health,
              log: previous.log,
            })
          }
        }
        const syncResult = asObject(result.payload.result)
        const dq = asObject(syncResult.dq)
        const qd = asObject(syncResult.qd)
        const errors = Array.isArray(syncResult.errors) ? syncResult.errors : []
        let text = t('actions.syncDone', {
          dq: asNumber(dq.forwarded),
          dqSkip: asNumber(dq.skipped),
          qd: asNumber(qd.forwarded),
          qdSkip: asNumber(qd.skipped),
        })
        if (errors.length > 0) {
          text = text + t('actions.syncErrors', { count: errors.length })
        }
        setNotice({ tone: errors.length > 0 ? 'warn' : 'ok', text })
        await loadRef.current()
      }

      // ---- 检测一次（只读）----
      const onCheckHealth = async () => {
        const result = await runOp('check', () => api.test())
        if (result === null || !aliveRef.current) return
        if (!result.ok) {
          setError(result.message)
          return
        }
        const checks = asObject(result.payload.checks)
        const okOf = (value) => value === true
          || (value !== null && typeof value === 'object' && value.ok === true)
        const qqOk = okOf(checks.qq)
        const douyinOk = okOf(checks.douyin)
        const peerOk = okOf(checks.peer)
        const allOk = qqOk && douyinOk && peerOk
        const text = allOk
          ? t('health.testOk')
          : t('health.testMixed', {
            qq: t(qqOk ? 'mark.ok' : 'mark.bad'),
            douyin: t(douyinOk ? 'mark.ok' : 'mark.bad'),
            peer: t(peerOk ? 'mark.ok' : 'mark.bad'),
          })
        setNotice({ tone: allOk ? 'ok' : 'warn', text })
        await loadRef.current()
      }

      // ---- 发测试消息：必须 window.confirm 二次确认后才调 /send ----
      const onSendTest = async () => {
        const side = testSide === 'douyin' ? 'douyin' : 'qq'
        const sideLabel = side === 'qq' ? t('actions.sideQq') : t('actions.sideDouyin')
        const text = t('actions.testText')
        let confirmed = false
        if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
          try {
            confirmed = window.confirm(t('actions.testConfirm', { side: sideLabel, text }))
          } catch (error) {
            confirmed = false
          }
        }
        if (confirmed !== true) return
        const result = await runOp('send', () => api.send({ side, text, confirm: true }))
        if (result === null || !aliveRef.current) return
        if (!result.ok) {
          if (result.payload !== undefined && asObject(result.payload).needsConfirm === true) {
            setNotice({ tone: 'warn', text: t('actions.testNeedsConfirm') })
          } else {
            setError(result.message)
          }
          return
        }
        setNotice({ tone: 'ok', text: t('actions.testSent') })
        await loadRef.current()
      }

      // ---- 解绑（两步确认）----
      const onUnbind = async () => {
        if (confirmUnbind !== true) {
          setConfirmUnbind(true)
          return
        }
        const result = await runOp('unbind', () => api.unbind())
        if (result === null || !aliveRef.current) return
        setConfirmUnbind(false)
        if (!result.ok) {
          setError(result.message)
          return
        }
        if (result.payload.state !== undefined) {
          const state = normalizeState(result.payload.state)
          if (state !== null) {
            setSnapshot({ state, health: snapshot === null ? normalizeHealth(null) : snapshot.health, log: snapshot === null ? [] : snapshot.log })
            syncForm(state)
          }
        }
        setNotice({ tone: 'ok', text: t('actions.unbound') })
        await loadRef.current()
      }

      // ---- 读取抖音会话列表（慢：10–40s）----
      const onReadPeers = async () => {
        if (busyRef.current !== '') return
        setPeersOpen(true)
        setPeers({ loading: true, rows: [], error: '', warning: '', needLogin: false })
        const result = await runOp('peers', () => api.getPeers())
        if (result === null || !aliveRef.current) return
        if (!result.ok) {
          setPeers({
            loading: false,
            rows: [],
            error: result.needLogin === true ? t('bind.needLogin') : result.message,
            warning: '',
            needLogin: result.needLogin === true,
          })
          return
        }
        const rows = normalizePeers(result.payload.people)
        // 抖音面板读不到时宿主会退回「本机聊过的人」并带一句 warning —— 原样转告。
        setPeers({
          loading: false,
          rows,
          error: '',
          warning: asString(result.payload.warning),
          needLogin: false,
        })
        setNotice(rows.length > 0
          ? { tone: 'ok', text: t('bind.peersFound', { count: rows.length }) }
          : { tone: 'warn', text: t('bind.peersEmpty') })
      }

      /** 点一行 → 填进抖音那栏；不能绑的行已在渲染时置灰。 */
      const onPickPeer = (peer) => {
        if (peer === null || typeof peer !== 'object') return
        if (peer.has_id !== true || peer.is_group === true) return
        updateForm({ secUid: peer.sec_uid, douyinNick: peer.nick })
        setNotice({
          tone: 'ok',
          text: t('bind.pickedPeer', { nick: peer.nick === '' ? peer.sec_uid : peer.nick }),
        })
      }

      // ---- 「最近记录」单独刷新：只打 /log ----
      const onRefreshLog = async () => {
        if (busyRef.current !== '') return
        const result = await runOp('log', () => api.getLog())
        if (result === null || !aliveRef.current) return
        if (!result.ok) {
          setError(result.message)
          return
        }
        const log = normalizeLog(result.payload.log)
        setSnapshot((previous) => previous === null ? previous : {
          state: previous.state,
          health: previous.health,
          log,
        })
      }

      // ---- 首次加载之前：加载中 / 加载失败两种占位页 ----
      if (loaded !== true) {
        return h('div', { className: 'qqdy-page' },
          h('div', { className: 'qqdy-card qqdy-loading' },
            error === null ? h('span', { className: 'qqdy-spinner', 'aria-hidden': 'true' }) : null,
            h('p', { className: 'qqdy-title' },
              error === null ? t('loading') : t('loadFailed')),
            error !== null ? h('p', { className: 'qqdy-sub' }, error) : null,
            error !== null ? h('p', { className: 'qqdy-hint' }, t('loadFailedHint')) : null,
            error !== null
              ? h('button', {
                type: 'button',
                className: 'qqdy-btn',
                onClick: () => {
                  setError(null)
                  if (typeof loadRef.current === 'function') loadRef.current()
                },
              }, t('retry'))
              : null))
      }

      const state = snapshot.state
      const health = snapshot.health
      const log = snapshot.log

      return h('div', { className: 'qqdy-page' },
        error !== null
          ? h(ErrorStrip, { message: error, onDismiss: () => setError(null), t })
          : null,
        notice !== null
          ? h(NoticeBar, {
            tone: notice.tone,
            text: notice.text,
            onDismiss: () => setNotice(null),
            t,
          })
          : null,
        h(StatusCard, { t, state, health, busy, onToggle: onToggleEnabled }),
        h(BindCard, {
          t,
          state,
          form,
          busy,
          peers,
          peersOpen,
          canForce,
          onUpdateForm: updateForm,
          onReadPeers,
          onTogglePeers: () => setPeersOpen((open) => open !== true),
          onPickPeer,
          onSave: onSaveBind,
          onForceBind: () => onSaveBind(true),
        }),
        h(LinksCard, {
          t,
          form: linksForm,
          busy,
          onUpdateForm: updateLinksForm,
          onSave: onSaveLinks,
        }),
        h(HealthCard, { t, state, health, busy, onCheck: onCheckHealth }),
        h(ActionsCard, {
          t,
          state,
          busy,
          testSide,
          onTestSideChange: setTestSide,
          onSync,
          onSendTest,
          onUnbind,
          confirmUnbind,
          onCancelUnbind: () => setConfirmUnbind(false),
        }),
        h(LogCard, { t, log, busy, onRefresh: onRefreshLog }),
        h(SafetyCard, { t }))
    }

    // =========================================================================
    // 插件入口
    // =========================================================================

    function apply(ctx) {
      // 中英词典：两套 key 必须一致（自检脚本会比对）。
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-qq-douyin-bridge: dictionaries')
      const t = ctx.locale.bind(NS)

      const api = createApi(t)

      // 样式：<style data-plugin-css="dsh-qq-douyin-bridge"> 挂到 head，卸载时清掉。
      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', NS)
        style.textContent = CSS
        document.head.appendChild(style)
        return () => {
          style.remove()
        }
      }, 'dsh-qq-douyin-bridge: settings styles')

      const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
      if (slots === undefined || slots === null) return

      // 设置 → QQ × 抖音桥（order 32 紧跟在「刷抖音」31 后面）。
      slots.inject('settings.section', () => slots.register({
        name: 'settings.section',
        id: 'qq-douyin',
        order: 32,
        label: () => t('title'),
      }, () => h(PageBoundary, { t }, h(SettingsPage, { t, api }))))
    }

    return {
      inject: ['slots', 'locale'],
      apply,
    }
  },
})
