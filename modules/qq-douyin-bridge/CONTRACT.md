# CONTRACT —— `dsh-qq-douyin-bridge` 宿主与设置页之间的契约

> 这份文件是**唯一权威**：宿主 `index.js`、设置页 `client.js`、自检 `selfcheck.mjs` 都按它对接。
> 改契约要三处一起改，并跑 `node selfcheck.mjs`。

---

## 0. 插件是什么

把一个 **QQ 会话**（私聊某好友 / 某个群）和一位**抖音好友的私信**接成一条双向通道：

- 抖音好友发来私信 → 宿主发到绑定的 QQ 会话（带 `【抖音·昵称】` 前缀）。
- 你在 QQ 会话里回的话 → 宿主发回抖音好友（默认只转发「引用/回复了那条转发消息」的发言，见 §4）。
- 防回环：抖音侧只转发 `from=them`；QQ 侧只转发「别人发的」，机器人自己发的（包括桥接转过去的那条）一律跳过。

数据来源（两边都是已实测可用的现成接口，插件不自己开浏览器）：

| 方向 | 读 | 写 |
|---|---|---|
| QQ | SnowLuma OneBot v11 HTTP：`get_login_info` / `get_friend_msg_history` / `get_group_msg_history` | `send_private_msg` / `send_group_msg` |
| 抖音 | 同机 dsh-douyin-scroll 的 `POST /api/douyin-duty/chat/read`（~1s，纯 HTTP） | `POST /api/douyin-duty/chat/send`（无头 Chrome，10–40s） |

自动发现（都可被状态里的覆盖值顶掉）：

- QQ：`$DSH_HOME/qq-bridge/config.json` 的 `snowluma.httpUrl` + `snowluma.accessToken`；默认 `http://127.0.0.1:3000`。
- 抖音：宿主自己的 origin + `/api/douyin-duty`（`ctx.webServer.getOrigin()`），不写死端口。

---

## 1. HTTP 路由（设置页用）

前缀 `ROUTE_PREFIX = '/api/qq-douyin'`，全部要求同源已认证（`ctx.connection.requestRejection`）。
**所有响应都是 HTTP 200 + `{ ok: boolean, ... }`**；业务失败也是 200，靠 `ok` 判断。
POST 请求 `Content-Type` 必须是 `application/json`，body 上限 256 KB。

| 方法 | 路径 | 请求体 | 响应 |
|---|---|---|---|
| GET | `/api/qq-douyin/state` | – | `{ ok: true, state: PublicState, health: Health, log: LogRow[] }` |
| POST | `/api/qq-douyin/config` | `{ enabled?, direction?, filter?, prefix?, pollMs?, dryRun? }` | `{ ok: true, state: PublicState }` |
| POST | `/api/qq-douyin/bind` | `{ qq_kind, qq_id, qq_label?, douyin_sec_uid, douyin_nick?, filter?, prefix?, direction?, force? }` | `{ ok: true, state: PublicState, preview?: { peer_nick, them_count, last_them_text } }` / `{ ok:false, error, detail? }` |
| POST | `/api/qq-douyin/unbind` | `{}` | `{ ok: true, state }` |
| POST | `/api/qq-douyin/sync` | `{}` | `{ ok: true, state, result: SyncResult }` |
| POST | `/api/qq-douyin/test` | `{}` | `{ ok: true, checks: { qq, douyin, peer } }` |
| POST | `/api/qq-douyin/send` | `{ side: 'qq' \| 'douyin', text, confirm?: true }` | `{ ok:true, sent:true, detail }` / `{ ok:false, needsConfirm:true, draft }` / `{ ok:false, error }` |
| GET | `/api/qq-douyin/peers` | – | `{ ok:true, people: PeerRow[], count }` / `{ ok:false, error, needLogin? }`（慢：10–40s，内部在抖音面板里跑 `im-send --list`） |
| GET | `/api/qq-douyin/log` | – | `{ ok:true, log: LogRow[] }` |

### PublicState

```jsonc
{
  "version": 1,
  "enabled": false,              // 桥总开关
  "configured": false,           // 绑定是否齐（douyin.sec_uid + qq.id）
  "binding": {
    "douyin": { "nick": "小王", "sec_uid": "MS4wLjABAAAA..." },
    "qq": { "kind": "private", "id": "<OWNER_QQ>", "label": "西嗨" }   // kind: private|group
  },
  "filter": "quote",             // all | quote | prefix
  "prefix": "回：",               // filter=prefix 时使用
  "direction": { "douyinToQQ": true, "qqToDouyin": true },
  "pollMs": 15000,               // 8_000 ~ 120_000
  "stats": {
    "dq": 3, "qd": 2,            // 累计转发条数（抖音→QQ / QQ→抖音）
    "lastRunAt": "2026-11-13T14:00:00.000Z" | null,
    "lastDqAt": "..." | null, "lastQdAt": "..." | null,
    "errors": 0
  },
  "lastError": "",
  "qqApiBase": "http://127.0.0.1:3000",       // 实际用到的（可能来自自动发现）
  "douyinApiBase": "http://127.0.0.1:54487/api/douyin-duty",
  "storePath": "C:\\Users\\MYQ\\.dsh\\qq-douyin-bridge\\state.json"
}
```

### Health

```jsonc
{
  "qq":     { "ok": true, "uin": "<BOT_QQ>", "nick": "大肥鱼", "error": "" },
  "douyin": { "ok": true, "loggedIn": true, "nick": "…", "uid": "…", "error": "" },
  "peer":   { "ok": true, "nick": "小王", "count": 11, "lastThem": "周末去爬山吗？", "error": "" },
  "aiOverlap": true,            // 绑定的 QQ 会话同时被 QQ 桥接接给 AI 了吗（提示用）
  "running": true,              // 轮询定时器在跑吗
  "nextSyncInMs": 9000
}
```

### SyncResult

```jsonc
{
  "dq": { "found": 2, "forwarded": 2, "skipped": 0, "note": "" },
  "qd": { "found": 1, "forwarded": 1, "skipped": 0, "note": "" },
  "errors": ["…"]               // 空数组 = 本轮全好
}
```

### LogRow

```jsonc
{ "at": "2026-11-13T14:00:00.000Z", "dir": "dq" | "qd" | "sys", "ok": true,
  "text": "【抖音·小王】周末去爬山吗？", "note": "" }
```

### PeerRow（`/peers`）

```jsonc
{ "nick": "小王", "sec_uid": "MS4wLjABAAAA...", "has_id": true,
  "duplicate": false, "is_group": false }
```

（`has_id=false` / `is_group=true` 的人不能绑，设置页里置灰并说明原因。）

### 错误响应

```jsonc
{ "ok": false, "error": "一句人话", "detail": "可选的技术细节", "needLogin": true }  // needLogin 仅抖音未登录时出现
```

---

## 2. 设置页（`client.js`）要求

- 形态：`window.__ModuleLoader__.load({ id: 'dsh-qq-douyin-bridge', factory: (require) => {…} })`，**非 ESM**。
- 注册到 `settings.section`：`{ name:'settings.section', id:'qq-douyin', order: 32, label: t('title') }`。
- 必须包一层 **error boundary**（子组件抛错只显示「这页出错了」+ 重试，绝不整页消失）。
- 样式：`<style data-plugin-css="dsh-qq-douyin-bridge">`，只用 `--dsw-alias-*` token（可带 fallback 值），类名统一前缀 `qqdy-`。
- 文案：`ctx.locale.register('dsh-qq-douyin-bridge', { en, zh })` + `const t = ctx.locale.bind('dsh-qq-douyin-bridge')`；
  所有用户可见文字都走 `t()`，中英两套都要有。
- 请求：`fetch('/api/qq-douyin/…', { credentials:'same-origin' })`；404 时提示「宿主半端没加载」。
- 刷新：进页面自动拉 `state`；轮询 `state`（10s，页面不可见时停）；操作后立即刷新。
- 页面结构（从简到繁都要有）：
  1. **顶部状态条**：桥开关（switch）、`running`/`enabled` 徽标、绑定摘要「抖音·小王 ↔ QQ 西嗨（私聊）」。
  2. **绑定卡片**：抖音好友（昵称输入 + sec_uid 输入，或点「读取抖音会话列表」从 `/peers` 点选）、QQ 侧（私聊/群 radio + QQ号/群号）、转发规则 select（全部 / 只转引用回复 / 前缀）、前缀 input（仅 prefix 时可用）、方向两个 checkbox、「保存并绑定」按钮。
  3. **状态卡片**：QQ 连通（昵称+UIN）、抖音登录（昵称）、对端可读（最近一条对方消息）、`aiOverlap` 提醒。
  4. **操作行**：「立即同步」「发测试消息」（要二次确认；side 默认 qq）、「解绑」。
  5. **最近记录**：最近 8 条 `log`（时间 HH:mm:ss + 方向箭头 → / ← + 文本省略号）。
  6. **安全说明**：私聊被 AI 同时占用时，建议改成「只转引用回复」或用专用 QQ 群。
- 不给默认 `sec_uid` 时不要假装已绑定；`configured=false` 时把「立即同步」置灰。

---

## 3. Agent 工具 `qq_douyin_bridge`

一个工具，`action` 取值：

| action | 参数 | 作用 |
|---|---|---|
| `status` | – | 返回一段人话摘要（绑定、开关、两侧健康、统计、最近 3 条记录） |
| `bind` | `qq_kind`,`qq_id`,`qq_label?`,`douyin_sec_uid`,`douyin_nick?`,`filter?`,`prefix?`,`force?` | 绑定；成功返回摘要 |
| `unbind` | – | 解绑 |
| `enable` | `enabled` bool | 开关桥 |
| `sync` | – | 立即同步一轮，返回 SyncResult 摘要 |
| `peers` | – | 列抖音私信会话（慢，10–40s） |
| `send` | `side`,`text`,`confirm` | 手动发一条；`confirm` 必须为 true |
| `log` | `limit?` | 最近记录 |

工具的 `parameters` 里 `action` 必填，其余按需；`confirm` 用 boolean，description 里写清「必须用户当场同意」。

---

## 4. 转发规则（宿主实现细节，UI 只是开关）

`filter`（QQ → 抖音）：

- `all`：QQ 目标会话里所有「别人发的」消息都转发（适合专用 QQ 群；群里 AI 也会看到，建议把群从 QQ 桥接白名单里拿掉）。
- `quote`（**默认**）：只转发「引用了那条 `【抖音·…】` 消息」的发言。判定：消息段里含 `reply` 段且 id ∈ 最近转发登记的 QQ message_id 集合；拿不到登记时用 `get_msg(reply_id)` 看被引消息原文是否以 `【抖音·` 开头（兜底）。
- `prefix`：只转发以 `prefix` 开头的消息（默认 `回：`），转发时剥掉前缀。

抖音 → QQ：只转发 `from === 'them'` 的消息；`kind === 'card'` 加 `[卡片]` 标记；每条加前缀 `【抖音·<昵称>】`。
**首轮对表**：绑定/启用后的第一轮只记录水位（最新一条时间 + 已见集合），不补发历史，避免一上线把 40 条旧消息刷到 QQ。水位持久化在状态文件里，重启不重播。

防回环与去重：

- QQ 侧：`sender.user_id === 机器人 UIN` 的消息一律跳过（机器人自己发的、桥接转发的那条都算）。
- 抖音侧：只看 `from === 'them'`；`from === 'me'` 跳过。
- 两个方向都用「消息指纹」（QQ：`message_id`；抖音：`from|text.slice(0,60)` + `at`）做去重，上限 200 条滚动。

发送节奏：抖音发送串行队列（同一时刻只跑一个 `chat/send`），单条上限 1800 字；一轮最多转 5 条，超出部分本轮跳过并计入 `skipped`（避免一上线就被一屏消息刷屏；人工同步会更快消化）。

---

## 5. 状态文件

`$DSH_HOME/qq-douyin-bridge/state.json`（原子写：tmp + rename；损坏时回默认并备份为 `.corrupt-<ts>`）：

```jsonc
{
  "version": 1,
  "enabled": false,
  "douyin": { "sec_uid": "", "nick": "" },
  "qq": { "kind": "private", "id": "", "label": "" },
  "filter": "quote",
  "prefix": "回：",
  "direction": { "douyinToQQ": true, "qqToDouyin": true },
  "pollMs": 15000,
  "cursors": {
    "dq": { "primed": false, "lastAt": "", "keys": [] },
    "qq": { "primed": false, "lastTime": 0, "ids": [] }
  },
  "forwardedQqIds": [],          // 抖音→QQ 发出去的 QQ message_id（引用判定用，上限 60）
  "stats": { "dq": 0, "qd": 0, "lastRunAt": null, "lastDqAt": null, "lastQdAt": null, "errors": 0 },
  "lastError": "",
  "log": []                      // 上限 100 条 LogRow
}
```

> 状态文件里**不存**任何 token / Cookie（QQ 的 accessToken 每次从 qq-bridge 配置现读）。

---

## 6. 纯函数层（`lib/`，自检直接测这些）

| 文件 | 导出 | 说明 |
|---|---|---|
| `lib/paths.mjs` | `dshHome()`, `bridgeHome()`, `stateFile()` | 路径；尊重 `DSH_HOME` |
| `lib/discover.mjs` | `readQqBridgeConfig()` | 读 qq-bridge 配置 → `{ httpUrl, wsUrl, accessToken, consolePort, consoleToken, allow, sessions }`；缺文件时返回带默认值（`httpUrl` 默认 `http://127.0.0.1:3000`、`accessToken` 空、`exists:false`）的对象，绝不抛 |
| `lib/onebot.mjs` | `createOneBot({ baseUrl, token, timeoutMs })` → `{ call, loginInfo, friendHistory, groupHistory, sendPrivate, sendGroup, getMsg }` | 统一把 OneBot 响应规整成 `{ ok, data, error }` |
| `lib/douyin.mjs` | `createDouyin({ baseUrl, timeoutMs })` → `{ status, config, read, send, dmPeople }` | 业务失败也 HTTP 200，统一按 `ok` 判 |
| `lib/format.mjs` | `MARK`, `formatDouyinForQQ`, `stripPrefix`, `dedupeKey`, `clip` | 文案/指纹 |
| `lib/filter.mjs` | `segmentsOf`, `textOf`, `replyToIdOf`, `pickNewDouyin`, `pickQqIngest` | 纯判定逻辑（无 IO，自检重点） |
| `lib/store.mjs` | `defaultState`, `normalizeState`, `loadState`, `saveState`, `publicState`, `pushLog` | 状态读写与规整 |
| `lib/links.mjs` | `extractUrls`, `isDouyinUrl`, `classifyDouyinUrl`, `parseTarget`, `extractTargets`, `stripDouyinLinks`, `resolveShortLink`, `resolveAwemeTarget` | v0.2 抖音链接识别 / 短链解析（纯函数为主，fetch 可注入） |
| `lib/douyin-tools.mjs` | `discoverDouyinTools`, `runProcess`, `pickJson`, `parseComments`, `parseVideoDetail`, `formatCount`, `formatVideoDigest`, `fetchVideoDetail`, `fetchComments`, `parseFeed`, `fetchFeed`, `formatFeedDigest`, `formatFeedForQQ`, `shareVideoCard`, `openInBrowser` | v0.2 复用「刷抖音」插件脚本：发现插件目录 / 起进程 / 解析输出 / 发卡片 / 本机打开 / 推荐流 |

自检 `selfcheck.mjs`（`node selfcheck.mjs`，无网络、无 DSH）要覆盖：
1. 状态默认值 / 规整 / 损坏恢复 / 日志上限；
2. `formatDouyinForQQ` / `stripPrefix` / `dedupeKey`；
3. `pickNewDouyin`：首轮对表不补发、只挑 them、去重、水位推进；
4. `pickQqIngest`：三种 filter、过滤自己发的、引用判定（id 命中 + 前缀兜底）、去重、上限 5 条；
5. `createOneBot` 响应规整（用假的 fetch 注入，或者把规整函数单独导出）——至少要能测 `normalizeOneBotResponse` 这种纯函数；
6. 契约自检：`package.json` 的 exports 文件都存在、`index.js`/`client.js` 都有、locale 有 meta.title/description、icon.svg 合法（能被 DOMParser 之外的方式粗查：非空 + 以 `<svg` 开头）。

---

# 7. v0.2 增量：抖音视频 / 评论 / 链接分享

> 2026-11-13 加。用户要求：① 在 QQ 里能跟 AI 聊「抖音上看到的视频、评论」；② QQ 里分享的抖音视频链接能在抖音里看（两种看法都要）。

## 7.1 新增状态字段（`state.links`）

```jsonc
"links": {
  "autoCard": true,        // QQ 里出现抖音视频链接 → 自动以「分享卡片」发给绑定的抖音好友
  "autoOpen": "private",   // off | private | always —— 自动在本机默认浏览器打开抖音视频页
  "cooldownSec": 60        // 同一个视频两次处理的最短间隔（10–600）
},
"linkRecent": {}           // aweme_id -> 毫秒时间戳；最多 50 条，内部去重用
```

`PublicState` 增加 `links` 字段（`linkRecent` 不对外）。
`POST /api/qq-douyin/config` 的 body 增加可选 `links` 对象（三个字段都可选，逐个校验后合并）。

## 7.2 新增只读工具 `douyin_video`（允许 QQ 会话调用）

宿主注册的**第二个工具**，只读，不发送任何内容：

| action | 参数 | 返回 |
|---|---|---|
| `info`（默认） | `url` / `aweme_id` / `text` 三选一；`limit`（热评条数，默认 6，最多 20） | 视频信息 + 热评摘要的文本 |
| `comments` | 同上（`limit` 默认 10） | 只有热评摘要文本 |
| `feed` | `top`（条数，默认 5，最多 10）、`with_comments`（给前几条拉热评，0–2，默认 0）、`push`（true 时把前 3 条直接发到绑定的 QQ 会话） | 「抖音上刷到的视频」清单文本；`push` 时同时以 `【抖音·推荐】…` 发到 QQ |

- 目标解析：完整链接 / `v.douyin.com` 短链（会跟随 302 解析）/ 裸 19 位 aweme_id / 含链接的一段文字，都认。
- 数据来源（复用「刷抖音」插件的能力，不自己开浏览器）：
  - 视频信息：`node <douyin插件>/tools/cdp-fetch.mjs --path "/aweme/v1/web/aweme/detail/?…"`（无头页面里带签名，实测 ~1s）
  - 热评：`<douyin插件>/.venv/Scripts/python.exe tools/api-comments.py <aweme_id>`（签名只读接口，实测 ~12s）
  - 推荐流（`feed`）：`<douyin插件>/.venv/Scripts/python.exe tools/forward-pick.py`（只读、不签名；读 `$DOUYIN_HOME/forward-pick.json` 的 rows，实测 ~11s）
  - `feed` 的 `push:true` 走宿主已有的 QQ 发送通道（OneBot），把前 3 条以 `【抖音·推荐】…` 发到绑定的 QQ 会话；没绑定时只返回清单并给 `warn`。
- 工具描述里要写清：这是只读查询，不会发消息；要发分享卡片走宿主设置页或 `qq_douyin_bridge`。
- QQ 桥接的工具白名单（`~/.dsh/plugins/qq-agent-presets/qq-tool-restrict.mjs` 的 `SAFE_EXACT`）里**只加 `douyin_video`**，不加 `qq_douyin_bridge`（后者能改绑定/发消息）。

## 7.3 `qq_douyin_bridge` 新增 action

| action | 参数 | 作用 |
|---|---|---|
| `video` | `url` / `aweme_id` / `text`，`limit?` | 查视频信息 + 热评（与本插件 `douyin_video` 同源实现） |
| `comments` | 同上 | 只查热评 |
| `open` | `url` / `aweme_id` | **在本机默认浏览器打开抖音视频页**（可见窗口；仅用户明确要求时调用） |
| `share_card` | `url` / `aweme_id`，`confirm`（必须 true） | 以抖音分享卡片发给绑定的抖音好友；不带 confirm 只回草稿与目标预览 |
| `link_config` | `links: { autoCard?, autoOpen?, cooldownSec? }` | 改 §7.1 的自动行为 |

## 7.4 自动链接处理（QQ 轮询里）

- 条件：`state.links.autoCard` 或 `state.links.autoOpen !== 'off'`，且绑定会话里出现「别人发的」新消息包含抖音链接（不再要求引用/前缀，链接消息独立于 `filter` 处理）。
- 对每个新链接（**每条消息最多 3 个**；链接任务队列上限 20 个；按 `cooldownSec` 去重）：
  1. `autoCard` 且已绑定抖音好友 → 串行队列里发分享卡片（`card-share.mjs`，20–60s）；没有绑定好友时记日志「跳过：没绑抖音好友」。
  2. `autoOpen === 'always'`，或 `'private'` 且绑的是 QQ 私聊 → 在本机默认浏览器打开 `https://www.douyin.com/video/<id>`。
  3. 每条都写 `state.log`（`dir:'sys'`，`note` 写「链接卡片/打开浏览器/跳过原因」）。
- 链接消息在 `filter=all` 下不再重复当纯文本转发（避免「卡片 + 一坨链接文本」）。

## 7.5 设置页（`client.js`）新增

- 新卡片「链接分享」（放在绑定卡片下面）：
  - 开关「**抖音链接自动发分享卡片**」（`links.autoCard`）
  - 下拉「**自动在本机打开**」→ 不打开 / 仅 QQ 私聊 / 总是（`links.autoOpen`）
  - 数字「同一视频冷却（秒）」（`links.cooldownSec`，10–600）
  - 一行提示：「QQ 里出现抖音视频链接时按上面的设置处理；QQ 里的 AI 也能用只读工具 `douyin_video` 查视频信息和热门评论。」
- 保存走 `POST /api/qq-douyin/config` 的 `links` 字段；`state.links` 变了要跟着刷新表单。
- 中英词典都要补 key（`links.*`）。

## 7.6 前置 / 限制（必须写进 README）

- 分享卡片需要**已绑定一位抖音好友**（当前 DM 会话列表为空时要先有会话），否则只记「跳过」。
- `douyin_video` 的评论查询要 10–20 秒；视频信息约 1–3 秒；`feed` 约 10–20 秒。
- `feed` 的推荐流来自「刷抖音」插件的 `forward-pick.py`（feed 3 页 + 热榜，只读）；`push:true` 需要已绑定 QQ 会话，且一次最多发前 3 条（避免刷屏）。
- QQ 里的 AI 要能调 `douyin_video`，需要它的工具白名单包含该名字（本仓库只改 `qq-tool-restrict.mjs` 的 `SAFE_EXACT`）；**已存在的 QQ 会话要重置一次**（QQ 里发 `/reset` 或桥接控制台重置）才会拿到新 guard。
- 只支持抖音域名链接；短链解析失败会明确报错，让用户贴完整链接。

## 7.7 v0.3：数据互通（QQ 的鱼 ↔ 抖音的鱼）+ 浏览器登录自愈

### 共享记忆（状态字段 `state.transcript`）

```jsonc
"transcript": [ { "at": "ISO", "side": "douyin|qq|feed|link|sys", "text": "≤300 字", "kind": "text|card..." } ]
```

- 最多 40 条，按时间旧→新；`normalizeState` 会过滤非法 side / 空 text / 非 ISO 时间。
- 写入时机：抖音→QQ 转发成功（`douyin`）、QQ→抖音 转发成功（`qq`）、`feed push` 成功（`feed`）、
  链接分享卡片发出（`link`）、手动发送（`sys`）。

### 系统提示注入

- `index.js` 在 apply 里注册全局运行时上下文：
  `ctx.systemPrompt.context({ name: 'qq-douyin-bridge-shared', order: 60, text: () => bridgeDigestText() })`
  （`inject` 里已加 `systemPrompt`）。
- `bridgeDigestText()`：未绑定 → `''`；否则输出「绑定 + 最近 8 条 transcript + 两边共享要点」。
- 两边共享要点由 `lib/share.mjs` 提供（10s 缓存）：
  - `readSharedContext({ secUid, limit })` → `{ qqMemories, dmNick, dmFacts }`
    - QQ 侧：`$DSH_HOME/memory-brain.json` 里 source=qq / tags 含 QQ 的最近 3 条，**优先 assistantText**，
      过滤「【当前时间】【当前角色】…」系统提示；
    - 抖音侧：`$DSH_HOME/douyin-duty/memory/dm-<sec_uid>.json` 的 `facts`（≤5）。
  - `formatSharedContext(context, { privateSession })`：`privateSession=false`（绑的是群）时**不输出 QQ 记忆行**，
    只保留 facts，避免私聊内容进群。

### 无头浏览器掉登录自愈

- 新增 `ensureBrowserLogin({ tools })`（lib/douyin-tools.mjs）：
  打开 `douyin.com/chat` 检测登录（`扫码登录|登录后免费|验证码登录`）；
  掉登录时把 `douyin_cookie.txt` 的 Cookie 通过 CDP `Network.setCookie` 注入 `.douyin.com`（7 天 expiry）+ 重新导航 + 复检。
  返回 `{ ok, loggedOut, injected, error }`。
- `shareVideoCard()` 与 QQ→抖音发送队列：遇到「分享面板没展开 / 发送器没返回 / 超时 / 登录」类错误时，
  自动 `ensureBrowserLogin()` 后**重试一次**。
- Cookie 本身过期时自愈无效 → 只能扫码重登（刷抖音设置页）。

### 自检

- `selfcheck.mjs` 需要覆盖：`pickQqMemories` / `pickDmFacts` / `formatSharedContext` / `readSharedContext`
  （临时 DSH_HOME）、`parseCookieHeader`、`transcript` 规整与 `publicState` 不泄漏，以及静态检查
  index.js 里有 `systemPrompt.context` / `bridgeDigestText` / `ensureBrowserLogin`。

## 7.8 v0.4：抖音卡片消息带链接 + 封面图（已实测）

问题：抖音好友私信里「分享视频的卡片」经 HTTP 私信接口只能拿到 `content_title`，
视频 id / 封面都被丢了 → QQ 里只有标题，AI/人都看不到画面。

修法：

1. **「刷抖音」插件 `tools/im-http.py` 加只读字段**（备份 `im-http.py.bak-bridge`）：
   卡片消息的 content JSON 里本来就有 `itemId`、`cover_url.url_list[0]`（签名 CDN URL，`x-expires` 到 2027），
   在 `messages.append` 里额外带上 `item_id`（字符串）和 `cover`（字符串 URL）。
2. **桥侧**：
   - `lib/filter.mjs` `pickNewDouyin` 透传 `item_id` / `cover`；
   - `lib/format.mjs` `formatDouyinForQQ` 在有合法 `item_id` 时追加 `\nhttps://www.douyin.com/video/<id>`；
   - `lib/onebot.mjs` 新增 `sendPrivateImage` / `sendGroupImage`（image 段，`file` 直接给签名 URL，
     SnowLuma 会自己下载并上传到 QQ —— 实测 11:27:37 的图片消息带 QQ file id）；
   - `index.js` `tickDouyinToQq`：卡片文字发成功后，若 `cover` 非空再发一条图片消息；
     两条都写日志（`[封面] …`），图片 message_id 也记进 `forwardedQqIds`。
3. **AI 可见性**：共享记忆额外提示「卡片会带可点链接 + 封面图，想看图可用 `qq_get_message_images`」。
4. 注意：反方向（QQ 链接 → 抖音分享卡片）依赖无头浏览器的**视频页**；2026-11-15 实测该机器拿到的
   视频页是「验证码中间页」（`title=验证码中间页`，`/chat` 正常），所以卡片发送会失败并记
   「找不到分享图标（视频页没加载好）」。处理：让用户在**有头**浏览器里过一次验证码，再重试。

## 7.9 v0.5：整段视频搬进 QQ（视频 + 帧 + 原声 + 本地语音转写，已实测）

`douyin_video` 新增 `action=watch`（参数同 info：`url` / `aweme_id` / `text`，另加 `frames`，3–10，默认 6）。

### 链路

```text
resolveAwemeTarget → fetchVideoDetail (cdp-fetch，取 play_addr.url_list[0] + duration + cla_info.captions)
  → downloadDouyinVideo   (Node fetch，UA+Referer；落盘到 .watch-tmp/<id>.mp4)
  → extractFramesAndAudio (spawn venv python → tools/extract_media.py，用 imageio-ffmpeg：
                            等间隔抽 N 帧 720p jpg + 原声 mp3)
  → onebot.sendPrivate|GroupVideo(本地 mp4)   → 视频消息 id
  → onebot.sendPrivate|GroupImage(每帧)       → 帧消息 id 列表
  → onebot.sendPrivate|GroupVoice(原声 mp3)   → 语音消息 id
  → transcribeAudio (spawn venv python → tools/asr.py，faster-whisper small，CPU int8) → 声音文字
  → 写日志 + transcript（含帧数/语音 id/转写摘要），清理 .watch-tmp
```

### 关键决定

- **为什么本地 ASR**：QQ 服务端只在「收到语音」时提供 `fetch_ptt_text`，自己发出的 voice 取不到
  （实测 `ptt translate failed: error=9`），所以自己用 faster-whisper。
- **为什么 `.watch-tmp` 放插件目录**：放系统 `%TEMP%` 时 python/ffmpeg 子进程 `WinError 5 拒绝访问`
  （DSH 沙箱 ACL），插件目录（workspace 内）可写。可用 `QQDY_WATCH_DIR` 覆盖。
- **ffmpeg 从哪来**：本机无系统 ffmpeg → 「刷抖音」venv `pip install imageio-ffmpeg` 自带静态 ffmpeg；
  脚本里用 `imageio_ffmpeg.get_ffmpeg_exe()` 取路径。
- **PyAV 坑**：faster-whisper 默认用 `av.open` 解码音频，本机 av 版本不兼容（`metadata_errors` TypeError），
  所以 asr.py 先用 ffmpeg 解成 16k 单声道 f32 裸流、`np.frombuffer` 后直接喂 `model.transcribe(samples)`，绕开 PyAV。
- **依赖装在「刷抖音」venv**（非系统级）：`imageio-ffmpeg`、`faster-whisper`、`numpy`；
  模型 small 首次从 `HF_ENDPOINT=https://hf-mirror.com` 下载到 HF 缓存，之后纯本地。
  `QQDY_ASR_MODEL` 可换 base/tiny/large-v3。

### 已知限制

- 帧是等间隔抽样，不是逐帧；「视频语义」= 抽样帧 + 转写 + 标题 + 热评，不是真正的视频模型。
- Whisper small 对纯音乐/嘈杂音频会重复或转错（可换模型）；转写可能很慢（74s 视频约 20–30s CPU）。
- watch 会往绑定 QQ 会话发 1 条视频 + N 条图片 + 1 条语音 + 文字结果，注意别在群聊里刷屏。

## 7.10 v0.6：抖音私信「分享视频」默认不转 QQ（已实测）

需求：抖音好友私信里分享来的视频卡片不再往 QQ 发消息（避免刷屏）。

### 状态 / 配置

```jsonc
"inbound": { "skipCards": true }   // 默认 true；false = 恢复 v0.4 行为（标题+链接+封面图）
```

- `lib/store.mjs`：`defaultState().inbound`、`normalizeState`（非布尔回 true）、`publicState` 暴露 `inbound`。
- `POST /api/qq-douyin/config` 接受 `{ "inbound": { "skipCards": boolean } }`（非布尔返回 400 错误）。
- `qq_douyin_bridge` 工具新增 action `inbound_config`，参数 `inbound: { skipCards }`。

### 过滤实现

`lib/filter.mjs` `pickNewDouyin({ ..., skipCards })`：

- `skipCards=true` 时，`kind === 'card'` 的对方消息不进入 `fresh`（不转发、不发封面图、不写 transcript、不加 stats.dq）；
- 但这类消息仍计入 `allThem`：**指纹进 `next.keys`、`lastAt` 照常推进**，所以不会每轮重现、也不会补发；
- 默认不传 `skipCards`（纯函数）保持旧行为，便于自检与其它调用方。

`index.js` 的 `tickDouyinToQq` 传 `skipCards: state.inbound.skipCards !== false`。

### 设置页

「链接分享」卡片新增开关，文案 `links.skipCards`（中英都有）；保存时 POST `links` 的同时带
`inbound: { skipCards }`；宿主 `state.inbound` 变了表单会跟着同步。

### 自检

- 555 → 565：`defaultState.inbound` 默认、`normalizeState` 三种输入、`publicState.inbound`、
  `pickNewDouyin` 在 `skipCards` 开/关下的 fresh / keys / lastAt 行为（含 item_id/cover 透传）。

## 7.11 v0.7：视频大模型通道（Qwen-VL，已接通并实测）

新增 `lib/video-ai.mjs`：

- `videoModelConfig(env, { useKeyFile })`：探测通道（不打印 key）
  - 先 `DASHSCOPE_API_KEY` → provider=dashscope，baseURL 默认 `https://dashscope.aliyuncs.com/compatible-mode/v1`；
  - 否则 `GEMINI_API_KEY` → provider=gemini，baseURL 默认 `https://generativelanguage.googleapis.com/v1beta`；
  - 环境变量都没有时，**回退读 key 文件**：`$DSH_HOME/vlm-key.txt` 或 `$DSH_HOME/qq-douyin-bridge/vlm-key.txt`；
    文件支持 `dashscope:sk-…` / `gemini:AIza…` / 裸 key（`sk-` 当 dashscope、`AIza` 当 gemini）；
  - `QQDY_VLM_MODEL` / `QQDY_VLM_BASE_URL` 可覆盖模型/网关（任意 OpenAI 兼容视觉模型）。
  - 自检传显式 env 时默认不读真实 key 文件（隔离），需要时传 `{ useKeyFile: true }`。
- `parseKeyFile(text)`（纯函数）：解析 `provider:key` / `provider=key` / 裸 key / 注释空行。
- `buildDescribePrompt({frames,title,author,transcript,captions})`：让模型输出 JSON
  `{summary, scenes[], text_in_video[], audio_summary, content_type, notable}`；要求「不编造」。
- `describeFrames({frames: [jpg 路径], ...})`：读帧转 base64 →
  - dashscope：`POST /chat/completions`，`image_url` 用 `data:image/jpeg;base64,…`；
  - gemini：`POST /models/{model}:generateContent?key=…`，`inline_data` 帧；
  - 模型候选回退；成功返回 `{ok,text,model}`，失败带具体 HTTP 错误。
- 无任何 key：`describeFrames` 返回 `MISSING_KEY_HINT`（不抛错、不伪造）。

`index.js`：

- 抽出 `analyzeVideoMedia(input)`：下载 → 抽帧 → 原声 → Whisper 转写 → VLM 画面理解（**不发消息**），
  返回 `workDir` 由调用方 `cleanupWorkDir`；
- `describeVideo(input)`：只用分析结果，**不往 QQ 发任何东西**，供 `douyin_video action=describe`；
- `watchVideo(input)`：分析后照旧发「完整视频 + 帧 + 原声」，并在文字结果里附 VLM 画面理解；
- 共享记忆提示里加入 `action=describe` / VLM。

`douyin_video` 参数：`action` 增加 `describe`；`frames` 对 describe/watch 都生效。

### 当前配置（2026-11-21）

- `DASHSCOPE_API_KEY` 已设为 Windows 用户环境变量（重启 DSH 后仍有效）；
- `C:\Users\<YOU>\.dsh\vlm-key.txt` 写入 `dashscope:<key>`（**不写进插件包目录**；不把 key 打进日志/README）。

### 实测

- 模型直连（真视频 6 帧 → `qwen3-vl-plus`，9 秒返回）：结构化 summary/scenes/text_in_video/audio_summary、
  截图文字识别准确（「时光一眨眼 又是冬天」等），prompt 约 251 token、completion 46 token；
- 自检 597 条全绿（v0.7 新增 32 条：无 key/双 key/自定义 baseURL/key 文件解析与回退/提示词内容与截断）；
- ⚠️ `describe`/`watch` 端到端还依赖「刷抖音」的**无头浏览器登录态**：2026-11-21 实测该登录已过期
  （Cookie 注入后仍未登录），需扫码重登；否则会先报「没取到视频详情」而不是模型错误。这是独立于模型 key 的问题。

## 7.12 v0.9：免费额度优先 + 逐个模型体检（已实测）

`lib/video-ai.mjs` 增加模型轮换与体检：

- `VLM_MODEL_CANDIDATES`（默认便宜→贵）：`qwen3-vl-plus` → `qwen3-vl-flash` → `qwen-vl-max-latest`
  → `qwen-vl-max` → `qwen2.5-vl-72b-instruct` → `qwen2.5-vl-7b-instruct`；
  `QQDY_VLM_MODELS=a,b,c` 可覆盖顺序；`QQDY_VLM_MODEL` 仍可强制单一模型。
- `classifyVlmError(status, body)`（纯函数）：`missing`（模型不存在）| `quota`（额度/未开通）|
  `throttle`（限流）| `auth`（key 鉴权）| `other`。
- `pickModelCandidates({list, configured, state, now})`（纯函数）：显式模型最前 → `preferred` 提前 →
  跳过 `exhausted`（额度/未开通，冷却 30 天）与 `throttled`（限流，冷却 10 分钟）→ 全冷却时仍返回原列表。
- 状态文件 `$DSH_HOME/qq-douyin-bridge/vlm-model-state.json`：`{preferred, exhausted, throttled, updatedAt}`；
  `readModelState/writeModelState` 失败静默；删文件或 `vlm_status` 带 `vlm_reset=true` 即全部重置。
- `describeFrames` 按上述顺序自动换模型；成功后 `preferred=model` 并清掉它的冷却；把 `tried` 列表一并返回。
- `probeVlmModels()`：每个模型发一条最小**文本**请求（`max_tokens:5`，不花图片 token），
  返回 `{model, ok, status, errorType, detail, ms}`，并同步更新冷却状态。
- 工具 `qq_douyin_bridge action=vlm_status`：打印逐个体检结果 + 当前 preferred/冷却列表；
  参数 `vlm_reset:true` 先清冷却、`vlm_models:[…]` 指定只测哪些模型。

**实测（2026-11-21 12:26）**：

| 模型 | 结果 |
|---|---|
| `qwen3-vl-plus` | ✅ 418ms 可用（免费额度） |
| `qwen-vl-max-latest` / `qwen2.5-vl-72b-instruct` / `qwen2.5-vl-7b-instruct` | ❌ HTTP 403 Access denied（未开通，去控制台开通+领取免费额度） |
| `qwen3-vl-flash` / `qwen-vl-max` | ❌ HTTP 404 Model not exist（当前账号/接口无此名字，不用开） |

自检：597 → 618（新增模型顺序/错误分类/冷却/状态文件读写/偏好排序等 21 条）。

### v0.10：画面文字 OCR 也走免费额度

- `OCR_MODEL_CANDIDATES = ['qwen-vl-ocr', 'qwen3.5-ocr']`，`QQDY_OCR_MODEL` 可覆盖；
- `buildOcrPrompt()` + `cleanOcrText()`（纯函数）：qwen-vl-ocr 返回的「x1,y1,x2,y2,置信度,文字」坐标前缀会被剥掉、纯数字行丢弃、去重；
- `ocrFrames({frames, maxFrames=4})`：对前 4 帧逐帧调 OCR，模型按冷却顺序自动回退；失败模型按 `classifyVlmError` 冷却；
- `analyzeVideoMedia`：抽帧后先 OCR，再把 OCR 文字作为 `ocrText` 传给 `buildDescribePrompt` 参与画面理解；
  `formatAnalysisLines` 单列「画面文字（OCR …）」；`describe`/`watch` 都受益；
- 实测（2026-11-21 12:36，真实视频 3 帧）：`qwen-vl-ocr` **1 秒**返回，清洗后得到
  「时光一眨眼又是个冬天 / 想要见」；自检 620 → 623（buildDescribePrompt 带 OCR、cleanOcrText 三种输入）。

> 免费额度使用策略：平台按「免费额度 > 资源包 > 按量」自动抵扣，且各模型额度独立（通常 100 万 token / 90 天）。
> 建议在权益页把「免费额度用尽即停」**全部开启**，避免额度用完后按量扣费；开启后调用会失败并由模型轮换自动跳过。
> 平台文档：<https://platform.qianwenai.com/docs/resources/free-quota>（含「已下架免费额度」名单，很多老模型的免费额度已不能再用）。

## 7.11 v0.8：QQ 里发抖音链接 → 直接收到视频（已实测）

需求：在 QQ 里发一条抖音链接，直接拿到这个视频（MP4），不用再问 AI。

### 配置

```jsonc
"links": { "autoCard": true, "autoOpen": "private", "cooldownSec": 60, "fetchVideo": true }
```

- `lib/store.mjs`：`links.fetchVideo` 默认 `true`；`normalizeState` 非布尔回默认；`publicState` 暴露。
- `POST /api/qq-douyin/config` 的 `links.fetchVideo`（非布尔返回 400 错误）。
- 工具：`qq_douyin_bridge` 新增 `action=fetch_video`（参数 url / aweme_id / text）；
  `link_config` 的 `links` 支持 `fetchVideo`。
- 设置页「链接分享」卡片新增开关（中英 key `links.fetchVideo`）。

### 链路

QQ→抖音 的 `tickQqToDouyin` 扫到 QQ 消息里的抖音链接 → `enqueueLinkJob` → `processLinkQueue`：

1. **⓪ `links.fetchVideo !== false`**：`sendVideoToQq(awemeId)` —— `fetchVideoDetail`（cdp-fetch 取 play_addr）
   → `downloadDouyinVideo`（Node fetch，UA+Referer）→ `onebot.sendPrivate/GroupVideo(本地 mp4)`；
   只下载并发送 MP4，**不抽帧、不转写**；写日志 `[视频]` + transcript `side=link`；临时文件跑完清理。
2. ① `autoCard`：分享卡片发抖音好友（原 v0.2 行为）
3. ② `autoOpen`：本机浏览器打开（原 v0.2 行为）
4. 三者任一成功即视为已处理；全部关闭/失败时记「链接已识别，但…」。

### 白名单

- `qq-tool-restrict.mjs` 的 `SAFE_EXACT` 增加 `douyin_video_fetch`（刷抖音插件的「只下载 MP4」工具，
  本地写文件、不发消息）。已存在的 QQ 会话要 `/reset` 或重启 DSH 后才拿得到新白名单。

### 自检与实测

- 桥自检：586 条全绿（`defaultState.links` / `normalizeState` / `publicState` 断言已同步 `fetchVideo`）。
- 实测（2026-11-15 20:03）：`action=fetch_video` 用 `7707770041366954981`（0.8 MB）→ QQ 收到真实视频消息
  （`message_id=-161033745`，segment=video `nya.mp4`）。自动链路与手动调用共用 `sendVideoToQq()`。

## 7.13 v0.12：详情改签名 HTTP + QQ 链接自动理解（已实测）

背景：2026-11-21 视频页在无头浏览器里持续撞「验证码中间页」，cdp-fetch 等待签名 SDK 40 秒仍失败，
导致 describe/watch/fetch_video/自动理解全部取不到 `play_addr`。

修法：

1. **「刷抖音」插件新增 `tools/video-detail.py`**：`dy-signer.mjs` 离线出 a_bogus + cookie → httpx GET
   `/aweme/v1/web/aweme/detail/`，1–3 秒返回完整 `aweme_detail`（含 `play_url`/`desc`/`author`/`captions`）。
   调用方通过 `DOUYIN_NODE` 传 node 绝对路径。
2. **两个插件的 `fetchVideoDetail` 都改为签名路优先**：先 `video-detail.py`，失败再回退 `cdp-fetch.mjs`（无头页面）。
   - `dsh-qq-douyin-bridge/lib/douyin-tools.mjs`
   - `dsh-douyin-scroll/lib/video-tools.mjs`
3. **`state.links.autoUnderstand`（默认 true）**：QQ 里出现抖音链接时，`processLinkQueue` 在发 MP4 之后
   自动跑 `describeVideo()`，把 `【抖音视频理解】…` 发回 QQ，并写 `transcript`（`side:'link'`），
   两边的 AI 都能看到；`link_config` 可关；设置页新增对应开关。
4. `enqueueMessageLinks` 的启用条件补上 `fetchVideo`/`autoUnderstand`（只开这两项也会排队）。

实测（2026-11-21 13:14）：

- `douyin_video action=describe` → 视频「人，你也很为白饭着迷吧」（6s）返回完整画面理解
  （AI 丢瓶转场、鲸鱼娘角色、白米饭），OCR「无」，Whisper「字幕by索兰娅」；
- `douyin_video_fetch action=understand` → 视频「小可怜儿，回家了…」（34s）返回 6 段场景、画面文字、旁白转写；
- 桥自检 624 条全绿；刷抖音自检 459 通过 / 5 既有环境态失败（与本次无关）。
