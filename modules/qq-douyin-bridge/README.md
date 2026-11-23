# dsh-qq-douyin-bridge ｜ QQ × 抖音桥

> Bridge one QQ conversation with one Douyin friend's direct messages — both directions.

把**一个 QQ 会话**（和某人的私聊 / 某个群）和**一位抖音好友的私信**接成一条双向通道：

- 抖音好友发来私信 → 宿主以 `【抖音·昵称】…` 发到绑定的 QQ 会话；
- 你在 QQ 里按规则回的话 → 宿主发回那位抖音好友。

**v0.2 还能做两件事**（不影响上面那条双向通道，也不改第 5 节的转发规则）：

- **在 QQ 里让 AI 查抖音视频 / 热评**：贴着链接说「看看这个视频的评论」，QQ 会话里的 AI 可以调只读工具 `douyin_video`，查到视频信息 + 热门评论（不发消息、不分享）。
- **QQ 里的抖音链接自动处理**：别人在绑定会话里发了抖音视频链接 → 宿主可以把这条视频以**抖音分享卡片**发给绑定的抖音好友，并可同时用**本机默认浏览器**打开（设置页「链接分享」卡片里三档配置）。

插件自己**不算签名、不搬 Cookie、不直接操作浏览器**：两边都用本机已经跑着的现成程序
（QQ 侧是 SnowLuma / QQ 桥接，抖音侧是「刷抖音」插件 `dsh-douyin-scroll`）。
v0.2 的视频/评论查询与分享卡片也是起「刷抖音」自带的脚本，无头页面与登录态都由它负责。

> **风险提示（简版）**
> - 抖音发私信走的是「刷抖音」插件的**无头 Chrome + 你已登录的抖音账号**，属于个人自动化，
>   可能不符合抖音使用条款，**账号风险自担**。
> - QQ 侧消息会按你选的规则被转发：绑错会话、选错规则，都会把不该发的话发给对方。
>   **请先读第 5 节「怎么回一条 + 安全建议」。**
> - 默认规则是「只转引用回复」（最保守）。绑定前先想清楚这条会话是不是也和 AI 共用。

---

## 1. 它长什么样（数据流）

下图的 ①②③④ 是「上行」方向（抖音 → QQ）；你把 QQ 的回复发回抖音，走的是同一条链路的反方向。

```text
  抖音好友的私信
        │ ①
        ▼
  [ dsh-douyin-scroll（「刷抖音」插件） ]
    · 复用已登录的抖音账号 + 无头 Chrome
    · /api/douyin-duty/chat/read   ≈1s（纯 HTTP）
    · /api/douyin-duty/chat/send   10–40s（无头 Chrome）
        │ ② 本机 HTTP
        ▼
  [ DSH 宿主 · dsh-qq-douyin-bridge ]
    · 轮询（默认 15s）/ 过滤 / 防回环 / 去重 / 水位
    · 状态：$DSH_HOME/qq-douyin-bridge/state.json（不含 token / Cookie）
        │ ③ OneBot v11 HTTP（不占用 WS 连接）
        ▼
  [ SnowLuma / QQ 桥接  默认 http://127.0.0.1:3000 ]
    · get_friend_msg_history / get_group_msg_history
    · send_private_msg / send_group_msg
        │ ④ 机器人账号收发
        ▼
  你 / 群友的 QQ 会话 ◄── 「【抖音·小王】周末去爬山吗？」
        │
        └── 你按规则回一句 ──► 原路 ③②① 发回抖音私信
```

四个数字对应：

1. **抖音 → 桥**：抖音好友的私信，由「刷抖音」插件读出来（`chat/read`，纯 HTTP，约 1 秒）；
2. **桥 → DSH 宿主**：本插件按 `pollMs`（默认 15 秒）轮询，挑出新消息、加 `【抖音·昵称】` 前缀后发到 QQ；
3. **宿主 → QQ**：OneBot v11 HTTP，`send_private_msg` / `send_group_msg`，以及 `get_friend_msg_history` / `get_group_msg_history`；
4. **QQ → 抖音**：你在 QQ 里按规则回的话，经 `chat/send` 发回抖音（无头 Chrome，10–40 秒是正常）。

> 头像、图片、表情、卡片预览都不搬：**只搬文字**（卡片只留文字 + `[卡片]` 标记，见第 10 节）。

> v0.2 起，QQ 里出现抖音视频链接时还可以走另一条**单向、只出不进**的支路：宿主识别链接 → ① 以分享卡片发给绑定的抖音好友（`links.autoCard`）；② 用本机默认浏览器打开（`links.autoOpen`）。这条支路不受第 5 节的转发规则影响，详见第 7 节。

---

## 2. 为什么这样接

- **不自己管浏览器。** 抖音的登录态、无头 Chrome、私信面板与签名逻辑都在「刷抖音」插件里：
  读私信只对它发 HTTP（~1 秒快路径），只有**发**私信才起无头 Chrome（10–40 秒）；v0.2 的查询/卡片/打开
  则是起它自带的 `tools/*.mjs` / `tools/*.py`，无头页面由那些脚本自己开，本插件只负责解析输出。
- **复用已有的登录态。** 你不需要把抖音 Cookie 再交给一个插件；「刷抖音」那边登录了，这里就能用。
- **QQ 侧只走 OneBot HTTP。** `POST http://<qqApiBase>/<action>` + `Authorization: Bearer <token>`，
  不建 WebSocket。所以**不跟 QQ 桥接抢那条 WS**，也不影响桥接自己接 AI 的逻辑。
  地址与 token 每次从 `$DSH_HOME/qq-bridge/config.json` 的 `snowluma.httpUrl` / `snowluma.accessToken` 现读，
  **不落进本插件的状态文件**。
- **端点自动发现，不写死端口。** 抖音侧用宿主自己的 origin + `/api/douyin-duty`（`ctx.webServer.getOrigin()`），
  QQ 侧缺省是 `http://127.0.0.1:3000`。
- **有节奏。** 每方向一轮最多转 5 条；QQ 连续发送间隔 700ms；抖音发送用串行队列（同一时刻只跑一个无头 Chrome），
  单条正文上限 1800 字。
- **防回环。** 抖音侧只转 `from === 'them'`；QQ 侧只转「别人发的」，
  机器人自己账号发的消息（包括桥转出去的那条、以及 AI 用同一账号回的话）一律跳过。
- **视频 / 评论查询同样复用「刷抖音」。** v0.2 的只读工具 `douyin_video` 不自己算签名：它起「刷抖音」插件自带的
  `tools/cdp-fetch.mjs`（视频详情，约 1–3 秒）和 `tools/api-comments.py`（热评，约 10–20 秒），只负责解析输出。
  本插件自身仍然不存 Cookie、不碰登录态。

---

## 3. 安装

### 方式 A（推荐：让 AI 装）

对本会话的 AI 说一句「把这个目录装成 DSH 插件」即可。它会调 `plugin_manager` 的 `install_bundle`，
target 用本目录的绝对路径（DSH 的本地链接 spec 是 `link:<绝对路径>`，和下面命令行的写法一致）：

```text
link:C:\Users\<你>\...\dsh-qq-douyin-bridge
```

### 方式 B（命令行）

```bash
dsh plugin --profile <profile> add link:<本目录绝对路径>
# 例：dsh plugin --profile web add link:C:\Users\you\dsh-qq-douyin-bridge
```

`<profile>` 是你正在用的 profile 名（用 `dsh profile list` 查；常见的是 `web`）。

### 装完必须重启一次 dsh

bundle 层要重启才会组装。重启后进 **设置 → QQ × 抖音桥**（它排在「刷抖音」后面）。

- 看不到这一页：确认真的重启了；看 dsh 日志里有没有本插件加载失败；
  确认仓库里 `client.js` 存在（设置页半端还没合入时，宿主半端和 Agent 工具仍可用，但没有设置页）。
- 本插件**自身零 npm 依赖**。但要两边程序就位：**SnowLuma / QQ 桥接**在跑、
  **「刷抖音」插件已装且已登录抖音**。
- 升级：改完代码后重新执行一次 `add link:<本目录>`（幂等），再重启 dsh。

---

## 4. 第一次怎么用

1. **确认 QQ 侧在跑。** SnowLuma / QQ 桥接已经启动，并且 `$DSH_HOME/qq-bridge/config.json`
   里有 `snowluma.httpUrl` 和 `snowluma.accessToken`。没有配置文件时本插件用默认
   `http://127.0.0.1:3000`、且不带 token（这要求 SnowLuma 那边没开鉴权）。
2. **确认抖音已登录。** 「设置 → 刷抖音」里已经扫码 / 贴过 Cookie；
   本插件状态卡里的「抖音」应显示已登录。
3. 打开 **设置 → QQ × 抖音桥**。
4. 在「绑定」卡片点 **「读取抖音会话列表」**。这一步**慢（10–40 秒）**，因为内部会在抖音面板里起无头 Chrome；
   列表里只能选 `has_id=true` 且不是群的会话，点一个人把 `sec_uid` 填好。
   如果这个慢接口失败，宿主会**退回到本机聊过的人**（`$DSH_HOME/douyin-duty/memory/dm-*.json`），
   这份列表可能不全、也可能偏旧。
5. **填 QQ 侧**：选「私聊好友」或「群」，填 QQ 号 / 群号（5–12 位数字），可选填一个显示名。
6. **选转发规则**（默认「只转引用回复」，推荐）。选「只转带前缀的」时填前缀，默认 `回：`。
7. 按需要勾两个方向（默认「抖音→QQ」和「QQ→抖音」都开）。
8. 点 **「保存并绑定」**。宿主会依次验证：QQ 能登录 → 抖音已登录 → **试读一次对方的私信**。
   陌生人 / 从没聊过的会话读不到，会直接报错、不让保存；页面会给出「仍然强制绑定」按钮
   （宿主返回 `canForce`），确认 sec_uid 没错再点它。绑定后每轮读私信仍可能失败，会记进状态/日志。
9. **打开顶部总开关。** 绑定不会自动开桥；开关默认是关的。
   （也可以让 AI 调工具 `enable`。）
10. **第一次「对表」。** 绑定 / 启用后的**第一轮只记录水位**（最新时间 + 已见消息集合），
    **不补发历史消息**；从下一轮开始，新出现的消息才会转。水位存在状态文件里，重启也不会把旧消息重播一遍。
11. **验证**：让抖音好友发一条 → QQ 会话里应出现 `【抖音·昵称】…`；
    再按第 5 节的规则回一句 → 抖音好友应收到（10–40 秒）。
    也可以点「立即同步」手动跑一轮看结果；「发测试消息」会**二次确认**后才真的发（默认发到 QQ 侧）。
12. **（v0.2，可选）配置「链接分享」。** 同一页下方的「链接分享」卡片决定 QQ 里出现抖音视频链接时怎么处理
    （自动发分享卡片 / 自动在本机打开 / 冷却时间），见第 7 节。

### 也可以让 AI 来操作（Agent 工具）

宿主注册了一个工具 `qq_douyin_bridge`，`action` 取值：

| action | 作用 |
|---|---|
| `status` | 一段人话摘要：绑定、开关、两侧健康、统计、最近几条记录 |
| `bind` | 绑定（`qq_kind` / `qq_id` / `douyin_sec_uid` / `filter` / `prefix` / `force`） |
| `unbind` | 解绑并关桥 |
| `enable` | 开 / 关桥（`enabled: true/false`） |
| `sync` | 立即同步一轮 |
| `peers` | 列抖音会话（慢，10–40 秒） |
| `send` | 手动发一条；**必须用户当场同意后传 `confirm: true`** |
| `log` | 最近记录（`limit`） |
| `video`（v0.2） | 查一条抖音视频的信息 + 热评（只读） |
| `comments`（v0.2） | 只查热评（只读） |
| `open`（v0.2） | 在本机默认浏览器打开抖音视频页（仅用户明确要求时） |
| `share_card`（v0.2） | 以抖音分享卡片发给绑定的抖音好友；**必须用户当场同意后传 `confirm: true`** |
| `link_config`（v0.2） | 改自动链接处理：`links: { autoCard, autoOpen, cooldownSec }` |

所以可以直接说：「看看 QQ 抖音桥状态」「帮我把抖音小王绑到 QQ 群 123456789」
「关掉桥」「把这个视频的评论看看」（贴链接）。

> v0.2 还注册了**第二个工具** `douyin_video`（只读）给 **QQ 会话里的 AI** 用 —— 它和 `qq_douyin_bridge` 是两套工具，
> 前者只能查视频/评论，后者能改绑定、发消息。详见第 6 节。

---

## 5. 三种转发规则（重点）

`filter` 决定 **QQ → 抖音** 谁能转：

| 规则 | 转发条件 | 转给抖音的内容 |
|---|---|---|
| `all` | 绑定 QQ 会话里**所有「非机器人」消息** | 原文 |
| `quote`（默认，推荐） | **引用了那条 `【抖音·…】` 转发消息**的发言 | 你发的正文（原样） |
| `prefix` | 以指定前缀开头的消息（默认 `回：`） | **剥掉前缀后**的正文 |

补充细节：

- **`quote` 怎么判定**：消息里要带 `reply` 段，且被引消息的 `message_id` 在宿主登记的
  「最近 60 条自己发到 QQ 的 message_id」里。登记不到时，宿主会调 `get_msg` 读被引消息原文，
  以 `【抖音·` 开头也算命中（兜底；每轮最多查 3 个未知引用）。
- **`prefix`**：`回：` 和 `回:`（中英文冒号）都认，前缀和正文之间的空格会被吃掉；
  也可以改成任意前缀（最多 20 字）。
- **防回环**：机器人自己发的消息（包括桥转过去的那条、AI 的回话）永远不会被转回抖音。

### 怎么回一条

- **`quote`（默认）**：在 QQ 里**引用 / 回复那条 `【抖音·昵称】…` 消息**，再输入你想说的话发送。
  桥靠这条引用认出「这是要发给抖音的」。转过去的是你输入的正文，不加任何前缀。
- **`prefix`**：直接发 `回：今天几点？` → 抖音收到 `今天几点？`。适合不想引用、打字更快的场景。
- **`all`**：绑定会话里所有非机器人消息都转。**只建议用在专用群**，不要在「你日常跟人/AI 聊天」的会话里用。

### 安全建议（务必看）

- ⚠️ **如果绑的 QQ 私聊同时是你跟 AI 聊天的地方**：`all` 会把你对 AI 说的**每一句话**
  （包括私人内容）都当成转发内容发给抖音好友。请用 **`quote`** 或 **`prefix`**。
- ⚠️ **想全量转发就给桥单独开一个不接 AI 的 QQ 群**：绑「群」，并且最好把这个群从
  QQ 桥接的 `allow.groups` 白名单里拿掉，让 AI 完全看不到这个群。
- ⚠️ **绑定的 QQ 群如果同时接 AI，会出现双份消息**：桥转进来的 `【抖音·…】` 和 AI 的回复都在群里，
  AI 还可能针对转发内容自己回话。设置页的 `aiOverlap` 提醒就是在查这件事
  （QQ 桥接的 `allow.private` / `allow.groups` 或已有会话里包含这个 QQ 会话时提示）。
- ✅ 默认规则是 `quote`，最保守：只有你**主动引用**那条转发消息时才会发出去。
- ✅ 日常建议：私人抖音好友 → 用 `quote`；不接 AI 的专用群 → 可以 `all`。

---

## 6. 抖音视频 / 评论（v0.2 新增，只读）

宿主新注册了一个**只读工具 `douyin_video`**，专门给 **QQ 会话里的 AI** 用：用户在 QQ 里贴一个抖音视频链接、
说一句「看看这个视频的评论」，AI 就能查到这条视频的信息和热门评论 —— 不发消息、不分享、不开浏览器。
另外它还能拉**「用户在抖音上刷到的视频」**（推荐流），并可选择直接发到绑定的 QQ 会话里当聊天内容（见下面「feed」）。

### 怎么用

在 QQ 会话里**直接说 + 贴链接**即可，例如：

- 「看看这个视频的评论」 + `https://www.douyin.com/video/7300000000000000001`
- 「这个视频讲了啥」 + `https://v.douyin.com/xxxx/`（短链）
- 「这条抖音的评论都是啥」 + 一段含链接的文字（工具有 `text` 参数，会从文字里挑链接）

AI 侧对应参数：`url`（推荐）/ `aweme_id`（裸数字 ID，15–25 位，抖音常见 19 位）/ `text` 三选一；`action=info`（默认）要视频信息 + 热评，
`action=comments` 只查热评；`limit` 控制热评条数（`info` 默认 6、`comments` 默认 10，最多 20）。

返回内容是给人和模型看的一段中文摘要：标题 / 作者 / 点赞 / 评论 / 收藏 / 分享 / 规范化链接，以及热评
（谁说了什么、多少赞，楼中楼最多带 2 条回复）。**查询失败会如实返回错误，不会编造**。

### 抖音上刷到的视频（`action=feed`）

「把你在抖音上刷到的视频也当聊天内容」——`douyin_video` 的 `feed` 动作会拉一轮推荐流：

- 参数：`top`（几条，默认 5、最多 10）、`with_comments`（给前几条拉热评，0–2）、`push`（true = 把前 3 条直接发到绑定的 QQ 会话）；
- 数据来源：`<刷抖音插件>/.venv/Scripts/python.exe tools/forward-pick.py`（只读、不签名；feed 3 页 + 热榜 → 打分 → 写 `forward-pick.json`），约 10–20 秒；
- 返回：每条视频的文案 / 作者 / 时长 / 赞评藏数 / 可点链接；`push` 时以 `【抖音·推荐】…` 一条条发到 QQ（实测两条间隔约 4 秒）；
- 推荐流是**「大肥鱼」这个抖音账号的推荐 feed**（不是手机屏幕上你正在看的那一条）；只读，不点赞、不发评论。

在 QQ 里可以说：「抖音上刷到什么好玩的？拉几条发我」「给我看看抖音推荐」。在 GUI 里也可以直接让我拉。

### 数据来源与耗时

| 数据 | 走哪里 | 耗时 |
|---|---|---|
| 视频详情 | `node <刷抖音插件>/tools/cdp-fetch.mjs --path "/aweme/v1/web/aweme/detail/?…"` | 约 1–3 秒 |
| 热评 | `<刷抖音插件>/.venv/Scripts/python.exe tools/api-comments.py <aweme_id>` | 约 10–20 秒（可能被限流） |
| 推荐流（feed） | `<刷抖音插件>/.venv/Scripts/python.exe tools/forward-pick.py` | 约 10–20 秒 |

前置：本机装了「刷抖音」插件（`dsh-douyin-scroll`）并已登录抖音；找不到插件 / 缺 `.venv` 时工具会直接报
「找不到『刷抖音』插件目录」或「找不到 Python 环境」，不会猜路径。

### QQ 桥接的工具有白名单（重要）

QQ 会话里的 AI 能看到哪些工具，由 QQ 桥接的白名单决定。v0.2 只改了
`~/.dsh/plugins/qq-agent-presets/qq-tool-restrict.mjs` 的 **`SAFE_EXACT`**，**只加了 `douyin_video` 一个名字**：

- 没有加 `qq_douyin_bridge`：那个工具能改绑定、发私信、发分享卡片，属于写操作，不该给 QQ 里的人随便调。
- **已存在的 QQ 会话不会自动拿到新 guard** —— 需要在 QQ 里发一次 `/reset`（或在桥接控制台重置会话），
  或者干脆重建会话，AI 才会看到 `douyin_video`。
- **可回退**：把 `SAFE_EXACT` 里的 `douyin_video` 删掉、重启 dsh，就恢复成 v0.1 的白名单。

> 诚实标注：视频详情 / 热评 / 推荐流（feed，含 `push` 发到 QQ）已用真实账号实测；
> 「QQ 会话里的 AI 自己调 `douyin_video`」这条仍按代码与桥接实现推演，以你自己在 QQ 里试的结果为准。

### 抖音卡片消息：带链接 + 封面图（v0.4，已实测）

抖音好友私信里**分享视频的卡片**，以前桥只能读到标题（正文文本），画面看不到。现在：

- 给「刷抖音」的 `tools/im-http.py` 打了一个**只加字段**的小补丁：卡片消息额外返回 `item_id` 和 `cover`（封面签名 URL）；
- 桥在 QQ 里转发卡片时，会发**两条**：
  1. 文字：`【抖音·对方】[卡片] 标题` + 可点的 `https://www.douyin.com/video/<id>`；
  2. 图片：视频封面图（QQ 里直接能看到画面）；
- QQ 里的 AI 若想「看」这张封面，可用 `qq_get_message_images` 按图片消息 id 读取（共享记忆里也已经提示它）。

实测（2026-11-15 11:27）：重放一张抖音卡片，QQ 里先收到标题+链接的文字，1 秒后收到封面图
（OneBot 返回了图片 file id，说明图真的上传进 QQ 了）。

> 注意：该补丁改的是「刷抖音」插件的 `tools/im-http.py`（备份在 `im-http.py.bak-bridge`）；
> 升级「刷抖音」时会被覆盖，届时重打即可（改动就是那十几行：把 `itemId` / `cover_url` 透出来）。

### 整段视频搬进 QQ：动态画面 + 原声 + 声音转写（v0.5，已实测）

`douyin_video` 多了一个 **`action=watch`**：给一个抖音链接/aweme_id，它会把「整段视频」搬进用户自己的 QQ 会话：

1. **完整 mp4** 发成 QQ 视频消息（用户在 QQ 里就能看动态画面、听原声）；
2. 抽 **6 帧**画面发成图片（默认 6，最多 10）；返回里给出每帧的消息 id，
   QQ 里的 AI 可以用 `qq_get_message_images` 逐帧看；
3. 原声再发一条**语音**；
4. 用**本地 Whisper**做语音转写（`tools/asr.py`，faster-whisper small、CPU int8），
   把「声音内容」变成文字放进工具结果——AI 就能像"听到"一样接着聊；
   如果抖音自带自动字幕（部分视频有 `cla_info.caption_infos`），也会一并带上。

实测（2026-11-15 11:51/11:54）：

- 「小可怜儿…」34s：视频消息 `1428545993`、6 帧、原声语音 `884262246`；
- 「鲸小团日常—冬天当然是吃火锅啦！」74s：视频 `-1157691752`、6 帧、语音 `-162532266`，
  Whisper 转写出的内容是「今晚给你做火锅吃…小团把你的饭盆拿过来…味道怎么样…慢点吃…困了」。

技术细节 / 前置：

- 本机**没有系统 ffmpeg**，用「刷抖音」venv 里 `pip install imageio-ffmpeg`（自带静态 ffmpeg）解 mp4；
- 语音转写用 `pip install faster-whisper numpy`，模型（small，约 460MB）首次从 `HF_ENDPOINT=https://hf-mirror.com`
  下载到本机 HF 缓存，之后纯本地；
- 临时目录放插件目录下的 `.watch-tmp/`（放系统 `%TEMP%` 会被沙箱子进程 ACL 拒绝，`WinError 5`），跑完即删；
- 这些 pip 包装在「刷抖音」的 venv 里，**不是系统级**；升级/重建该 venv 时需要重装；
- 限制：帧是**等间隔抽样**（不是完整逐帧理解）；Whisper small 对音乐/嘈杂音频会出错（可换 `QQDY_ASR_MODEL=base/large-v3`）；
  「视频语义」仍是「抽样帧 + 转写 + 标题 + 热评」的近似，不是真正的视频模型。

### 抖音私信里的「分享视频」：默认不转 QQ（v0.6，已实测）

设置页「链接分享」卡片新增开关「**抖音分享的视频不转 QQ（私信里发来的卡片）**」，对应 `state.inbound.skipCards`，**默认开**：

- **开**：抖音好友私信里发来的「分享视频/作品」卡片**不再转进 QQ**（不刷屏、不自动发封面图）；
  想看的时候让 AI 用 `douyin_video action=watch` 主动搬整段视频；
- **关**：恢复 v0.4 的行为（转发标题 + 可点链接 + 封面图）；
- **普通文字私信不受影响**，照常转进 QQ；
- 被跳过的卡片仍会记指纹/推进水位，不会每轮重复处理，也不会补发。

实测（2026-11-15 12:00 左右）：把抖音侧水位回退到一张分享卡片之前，等一轮后
**QQ 没有收到任何新消息**，而 `state.cursors.dq.keys` 里出现了这张卡片的指纹、`lastAt` 也推进到了卡片时间。
（用 `qq_douyin_bridge action=inbound_config {inbound:{skipCards:true|false}}` 也能改。）

### 视频大模型：真正「看懂画面」（v0.7，已接入千问 Qwen-VL ✅）

`douyin_video` 新增 `action=describe`（**只看不搬**，不发任何 QQ 消息）：

1. 下载整段视频 → 抽 6 帧 → 本地 Whisper 声音转写；
2. 把「抽样帧 + 标题 + 转写」交给**视频大模型**（DashScope Qwen-VL 或 Gemini），
   让它输出结构化画面理解：`summary / scenes（按时间顺序的动作变化）/ text_in_video / audio_summary / content_type / notable`；
3. `action=watch` 也会把这段画面理解一起返回（并在搬视频时记日志/共享摘要）。

**key 怎么配（一次性）**：按顺序找 —— 环境变量 → `$DSH_HOME/vlm-key.txt`：

| 通道 | 环境变量 | key 文件写法 | 说明 |
|---|---|---|---|
| DashScope（当前使用） | `DASHSCOPE_API_KEY` | `dashscope:sk-...`（或裸 `sk-...`） | 阿里云百炼；默认 `qwen3-vl-plus` → `qwen-vl-max-latest` → `qwen-vl-plus` 自动回退 |
| Gemini | `GEMINI_API_KEY` | `gemini:AIza...` | 默认 `gemini-2.5-flash` → `gemini-2.0-flash` |
| 自定义 | `QQDY_VLM_BASE_URL` / `QQDY_VLM_MODEL` | — | 换成其它 OpenAI 兼容的视觉模型网关 |

已配置（2026-11-21）：`DASHSCOPE_API_KEY`（用户环境变量）+ `C:\Users\<YOU>\.dsh\vlm-key.txt`（`dashscope:` 前缀）。
写 key 文件不需要重启 DSH（每次调用现读）；写环境变量是给重启后兜底。

**已实测**（用真视频的 6 张帧调 `qwen3-vl-plus`，9 秒返回）：

```
{"summary":"一个蓝发小人偶在雪天街头流浪，头戴金属碗、身披布片，最终被一名男子温柔抱起带走。",
 "scenes":["湿漉漉石板路…脚印/水洼","蓝发小人偶蹲坐地上…","一只手把硬币放在布片上…","…","…","男子弯腰把她抱进怀里"],
 "text_in_video":["时光一眨眼 又是冬天","假如 某一天我离开",…],
 "audio_summary":"人声旁白…轻柔钢琴/弦乐，冬日温情略带哀愁",
 "content_type":"萌宠","notable":"Q版动漫玩偶…雪夜暖光对比"}
```

> 注意：`describe`/`watch` 需要先能拿到视频详情（走「刷抖音」的无头浏览器）；
> 如果抖音登录态过期，会先报「没取到视频详情」而不是模型错误 —— 此时去 设置 → 刷抖音 → 扫码登录 即可。
> 另外「抽样帧理解」仍不是原生逐帧视频模型，是性价比更高的近似方案（一次约 300 token 级，成本可忽略）。

### 免费额度优先 + 逐个模型开启（v0.9 / v0.10）

视频管线会**把当前账号能用的免费额度都消耗掉**（平台按「免费额度 > 资源包 > 按量」自动抵扣）：

- **画面理解**：`qwen3-vl-plus`（当前已开通，实测可用）→ 若开通了 `qwen-vl-max-latest` 会自动用上；
  顺序可用 `QQDY_VLM_MODELS=a,b,c` 覆盖；
- **画面文字 OCR（v0.10 新增）**：`qwen-vl-ocr`（实测 1 秒，读出「时光一眨眼又是个冬天 / 想要见」），
  失败时回退 `qwen3.5-ocr`；OCR 结果会喂给画面理解模型，也在结果里单列；
- 成功过的模型记 `preferred`；额度用完/未开通冷却 30 天、限流冷却 10 分钟，自动跳到下一个；
- 状态文件：`$DSH_HOME/qq-douyin-bridge/vlm-model-state.json`（删掉或 `vlm_status` 带 `vlm_reset=true` 重置）。

**逐个体检**：`qq_douyin_bridge action=vlm_status`（每个模型只发 5 token 文本请求，不花图片额度）。

当前实测（2026-11-21 12:26）：

| 模型 | 状态 |
|---|---|
| `qwen3-vl-plus` | ✅ 可用（免费额度） |
| `qwen-vl-ocr` | ✅ 可用（OCR 免费额度，已接进 watch/describe） |
| `qwen-vl-max-latest` / `qwen2.5-vl-72b-instruct` / `qwen2.5-vl-7b-instruct` | ❌ 403 未开通（要开就去百炼控制台开通+领免费额度，开完 `vlm_status` 会自动用上） |
| `qwen3-vl-flash` / `qwen-vl-max` / 开源 `qwen3-vl-8b/32b/235b` 等 | ❌ 404 当前平台/账号没有（文档显示其免费额度已下架，不用开） |

> ⚠️ **一定要去权益页把「免费额度用尽即停」全部开启**（[platform.qianwenai.com/home/benefits](https://platform.qianwenai.com/home/benefits)
> → 右上角「全部开启」）。不开的话额度用完后会按量扣费；开了之后额度一用完调用就会失败，我们的模型轮换会自动切到下一个有额度的模型，做到零超支。
> 平台的其它类目免费额度（文本 / 图像生成 / 视频生成 / 语音）不属于 QQ×抖音桥的使用面，需要另行接入才用得上。

### QQ 里发抖音链接 → 直接收到视频（v0.8，已实测）

**在 QQ 私聊里发一条抖音链接（完整链接或 `v.douyin.com` 短链），桥会自动把这个视频（MP4）发回同一个 QQ 会话**——
不用再问它、不用打开浏览器、不用等 AI。设置页「链接分享」卡片新增开关
「**QQ 里发抖音链接 → 直接把视频（MP4）发回 QQ**」，对应 `state.links.fetchVideo`，**默认开**。

- 只做下载 + 发视频：**不抽帧、不转写**（「只要 MP4」）；视频以 QQ 视频消息发出，直接可播。
- 与原有行为叠加：同一个链接还会按原设置发抖音分享卡片 / 在本机浏览器打开（不想要可以关掉那两个开关）。
- 关掉开关后：链接仍会按原设置处理（卡片/打开），但不会再把视频发回 QQ。
- 手动调用：`qq_douyin_bridge action=fetch_video url=<链接>`（GUI 里的 AI 也能用），同样只发 MP4。
- 命令/接口：`qq_douyin_bridge action=link_config links={"fetchVideo":true|false}`。

实测（2026-11-15 20:03）：`fetch_video` 用 `7707770041366954981`（0.8 MB）验证 → QQ 收到真实视频消息
（`message_id=-161033745`，segment=video）。自动链路与手动调用共用同一个 `sendVideoToQq()`。

---

## 7. QQ 里的抖音链接怎么处理（v0.2 新增）

设置页「QQ × 抖音桥」的**「链接分享」卡片**（在绑定卡片下面）有三个设置，对应状态文件的 `state.links`：

| 设置 | 字段 | 默认 | 含义 |
|---|---|---|---|
| **抖音链接自动发分享卡片**（开关） | `links.autoCard` | 开 | QQ 里出现抖音视频链接时，把这条视频以**抖音分享卡片**发给绑定的抖音好友（不是文字链接；文字链接在抖音里点不开） |
| **自动在本机打开**（下拉） | `links.autoOpen` | 仅 QQ 私聊 | `不打开(off)` / `仅 QQ 私聊(private)` / `总是(always)`：用系统默认浏览器打开 `https://www.douyin.com/video/<id>` |
| **同一视频冷却（秒）**（数字） | `links.cooldownSec` | 60 | 同一个视频两次处理的**最短间隔**，范围 10–600 秒 |

### 触发条件与行为

- 只处理**绑定会话里「别人发的」新消息**（机器人自己 / AI 用同一账号回的话不算），消息里含抖音视频链接，
  且 `autoCard === true` 或 `autoOpen !== 'off'` 至少一个开着。
- 链接消息**不再重复当纯文本转发**（即使 `filter=all` 也一样）—— 避免「卡片 + 一坨链接文本」。
- 每条新消息最多处理 3 个链接（内部处理队列最多排 20 个任务）；处理是**串行队列**（发卡片走无头 Chrome，
  不会同时开多个），不阻塞 QQ 轮询；每一步都写进「最近记录」日志（`dir=sys`，
  `note` 写「已发分享卡片 / 已在默认浏览器打开 / 跳过或失败原因」）。
- **本机打开**用的是系统默认浏览器（Windows 是 `explorer.exe`），并且**只放行抖音域名**
  （`douyin.com` / `iesdouyin.com` 及其子域），其它链接一律不打开。
- **短链可能解析失败**：`v.douyin.com/xxx` 需要跟随 302 才能拿到 aweme_id，抖音对没有浏览器指纹的请求可能断连
  或跳到不认识的页面。失败会明确记「短链解析失败 —— 把完整视频链接贴过来也行」，**贴完整链接即可**。

### 前置 / 限制（诚实标注）

- **分享卡片需要已绑定一位抖音好友**。没绑定（例如抖音私信会话列表为空、根本绑不上）时，卡片路径**跳过**并记日志
  「跳过发卡片：还没绑抖音好友」，不会硬发；已经绑定但抖音侧操作失败时，日志会写「卡片没发出：…」失败原因。
  本机打开那一路不受影响（只要 `autoOpen` 允许）。
- 分享卡片走「刷抖音」插件的 `tools/card-share.mjs`，**20–60 秒**是正常，且需要无头 Chrome 能操作私信面板。
- 只处理**抖音域名**的链接；其它网站链接（B 站、微博等）不会触发卡片，也不会被打开。
- **已实测（2026-11-14）**：QQ 里发链接 → 桥自动发分享卡片给绑定好友这条链路已经跑通；
  直接调 `share_card` 发卡片后，用浏览器读回会话确认卡片真的在（`from=me awe=800 item=<视频id>`），
  也就是「在抖音里能点开看」成立。
- 前提是**无头 Chrome 处于登录态**。它掉登录时（插件 home 里的 Cookie 还有效、但浏览器 profile 掉线），
  桥会自动把 `douyin_cookie.txt` 的 Cookie 灌回浏览器再重试一次（见 lib/douyin-tools.mjs 的 `ensureBrowserLogin`）；
  Cookie 本身过期时就只能扫码重登（设置 → 刷抖音 → 扫码登录）。

### QQ 发来的链接 → 自动理解视频（v0.12，已实测）

在 QQ 里发一条抖音链接，桥除了把 MP4 发回 QQ，还会**自动做视频理解**并把结论发回 QQ、写进共享记忆：

```text
【抖音视频理解】
【视频理解】人，你也很为白饭着迷吧 #AI丢瓶转场棒棒糖…
@沈默 Moment · 6s · 赞8.3w 评804
画面理解（视频大模型 qwen3-vl-plus，基于 6 张抽样帧）：{"summary":"…","scenes":[…]}
画面文字（OCR qwen-vl-ocr）：…
声音转写（本地 Whisper small）：…
```

- 开关：设置页「链接分享」卡片「**QQ 里发抖音链接 → 自动理解视频（画面+文字+声音）并回一条结论**」，默认开；
  `qq_douyin_bridge action=link_config links={"autoUnderstand":false}` 可关。
- **关键修复（2026-11-21）**：取视频详情不再依赖无头浏览器签名 SDK —— 改为
  `dy-signer` 离线签名 + cookie 走 `/aweme/v1/web/aweme/detail/`（`tools/video-detail.py`，1–3 秒），
  彻底绕开视频页的「验证码中间页」和登录过期；签名路失败时自动回退原 cdp-fetch。

---

## 7.5 数据互通：QQ 的鱼 ↔ 抖音的鱼（v0.3）

目标是「两边的鱼不是陌生人」：在 QQ 里聊过的、在抖音私信里聊过的、转发过的视频/链接，两边 AI 都能看到同一份摘要。

### 怎么做的

1. **共享对话摘要**：桥把「在两个平台之间互通的最近内容」记进 `state.transcript`（最多 40 条）：

   | side | 什么时候记 |
   |---|---|
   | `douyin` | 抖音好友发来、已转到 QQ 的私信 |
   | `qq` | QQ 里回复、已发回抖音的消息 |
   | `feed` | `douyin_video feed push` 推到 QQ 的推荐视频 |
   | `link` | QQ 里的抖音链接已发成分享卡片 |
   | `sys` | 手动发送等系统动作 |

2. **系统提示注入**：插件注册一段全局运行时上下文（`ctx.systemPrompt.context`，名字
   `qq-douyin-bridge-shared`），所有 Agent 每次请求都会看到一小段：

   ```
   【QQ × 抖音桥 · 共享记忆】
   绑定：抖音「。。。？？？」↔ QQ 私聊 <OWNER_QQ>；桥开着。
   最近在两个平台之间互通的内容（两边的 AI 都知情，不要当没发生过）：
   - [23:53] 抖音推荐：小猫每天凌晨都过来闻闻我…
   两边共享的要点：
   QQ 这边的鱼最近记得（QQ 桥接会话）：
   - [00:22] 他发来一条抖音链接，标题是…
   抖音好友「。。。？？？」：<长期事实，如"在杭州；养了只猫">
   ```

3. **两边记忆要点**由 `lib/share.mjs` 读取：
   - QQ 侧：`$DSH_HOME/memory-brain.json` 里带 QQ 标签/来源的最近 3 条记忆，
     **优先用 `assistantText`**（模型对那一轮的自然语言总结），过滤掉「【当前时间】【当前角色】…」这类系统提示；
   - 抖音侧：`$DSH_HOME/douyin-duty/memory/dm-<sec_uid>.json` 里的 `facts`（≤5 条）。

### 边界

- 只有**绑定后**才注入；没绑定就返回空，避免污染无关会话。
- 如果绑的是 QQ 群（不是私聊），**不注入 QQ 记忆**（防止把私聊内容带进群），只保留共享对话摘要与抖音好友 facts。
- 摘要最多 8 条互通记录 + 3 条 QQ 记忆 + 5 条 facts，属「小抄」不是全量记忆；完整记忆仍在 memory-brain / 刷抖音各自那里。

---

## 8. 状态文件

本插件唯一写盘的地方：

```text
$DSH_HOME/qq-douyin-bridge/state.json
# Windows 默认：C:\Users\<你>\.dsh\qq-douyin-bridge\state.json
```

里面是：绑定信息、开关、规则 / 前缀、方向、`pollMs`、两边的**水位 cursors**（首轮对表与去重靠它）、
最近 60 条已转发 QQ message_id、统计、`lastError`、最近 100 条日志；v0.2 还有链接分享设置
`links`（`autoCard` / `autoOpen` / `cooldownSec`）和链接去重水位 `linkRecent`（`aweme_id` / 短链 → 毫秒时间戳，
最多 50 条，内部用、**不对外暴露**）；v0.3 还有 `transcript`（QQ↔抖音共享对话摘要，最多 40 条）。

实现细节：

- **原子写**：先写同目录临时文件再 rename 覆盖；
- 文件损坏 → 备份成 `state.json.corrupt-<毫秒时间戳>`，再回默认值（宿主日志会写一条）；
- **不存任何 token / Cookie**：QQ 的 `accessToken` 每轮从 `$DSH_HOME/qq-bridge/config.json` 现读；
  抖音登录态在「刷抖音」自己的目录里。

手动删掉这个文件 = 回到「未绑定 + 未启用」；删之前记得备份。不要手改水位（改了只会导致漏转或重播）。

---

## 9. 故障排查

先看**设置页的状态卡与「最近记录」**，或让 AI 调工具 `status` / `log`。
宿主同一 origin 下也可以直接看 `GET /api/qq-douyin/state`（同源认证；返回 `{ ok, state, health, log }`）。

| 现象 | 先看 | 常见原因 / 怎么办 |
|---|---|---|
| **QQ 侧连不上** | 状态卡里的 QQ 错误文案 | ① SnowLuma / QQ 桥接进程没起；② `$DSH_HOME/qq-bridge/config.json` 的 `snowluma.httpUrl` 没指向真正的 OneBot HTTP 端口（默认 `127.0.0.1:3000`）；③ `snowluma.accessToken` 与 SnowLuma 配置不一致；④ 报「超时」= 15 秒没响应，先直接调一次 `get_login_info` 确认端点在 |
| **抖音未登录** | 状态卡里的抖音一行；接口返回 `needLogin` | 去「设置 → 刷抖音」扫码 / 贴 Cookie，然后回来点「立即同步」或刷新页面 |
| **「读取抖音会话列表」慢或失败** | 按钮停在「正在读取…」 | 10–40 秒是正常的（要起无头 Chrome）；失败会自动退回本机聊过的人（`$DSH_HOME/douyin-duty/memory/`），列表可能不全；确认「刷抖音」已登录、它自己能不能打开私信面板；也可以让 AI 调 `peers` |
| **绑定提示「读不到对方私信」** | 绑定返回的 `detail` | 只有**已经聊过天**的人能读：先在抖音里给对方发一条 / 让对方回一条，再重新「读取会话列表」选人；设置页首次绑定没有强制按钮，确实要绑就让 AI 调 `bind` + `force: true`（绑定后每轮读私信仍可能失败） |
| **在 QQ 里引用了却没转** | 「最近记录」里有没有 `QQ→抖音` 行 | ① 必须引用**桥发的那条 `【抖音·…】`**，不是别人的话；② 引用太旧、登记丢了时靠 `get_msg` 兜底，读不到原文就判不中 → 换成 `prefix` 或 `all` 验证通道本身；③ 方向开关「QQ→抖音」是否关着；④ 首轮对表期间不转；⑤ 每轮最多 5 条 |
| **抖音发了 10–40 秒才成功** | — | **正常**：发私信走无头 Chrome；同一时刻只发一条（串行队列），连点/连发只会排队；单条正文上限 1800 字 |
| **QQ 里的 AI 说用不了 `douyin_video` / 看不到这个工具**（v0.2） | QQ 桥接的 `qq-tool-restrict.mjs` | ① 确认 `SAFE_EXACT` 里有 `douyin_video`、改完重启过 dsh；② **已存在的 QQ 会话要发 `/reset` 或重建**才会拿到新 guard；③ 本机要有「刷抖音」插件 + 它的 `.venv` |
| **QQ 里发了抖音链接但没反应**（v0.2） | 「最近记录」里 `dir=sys` 的链接行 | ① 「链接分享」卡片里 `autoCard` 和 `autoOpen` 都关着；② 消息是机器人/AI 自己发的（不算）；③ 同一视频还在 `cooldownSec` 冷却里；④ 没绑定抖音好友 → 卡片跳过（日志会写）；⑤ 短链解析失败 → 贴完整链接；⑥ 首轮对表期间不处理旧消息 |
| **401 / 403** | 是哪一侧报的 | 设置页请求被宿主同源认证拒绝：用当前 dsh 的地址打开（别用反代域名 / 别的 host），刷新页面重试；QQ 侧 HTTP 401/403：`snowluma.accessToken` 不对或 SnowLuma 开了鉴权但配置没写。**按代码应如此，未实测** |
| **设置里没有「QQ × 抖音桥」** | dsh 日志 | bundle 层要重启；确认装进了当前 profile；确认 `client.js` 存在 |

---

## 10. 已知限制（不掩饰）

1. **抖音发私信没有 message id，也不能回读。** 只有接口返回 `sent === true` 才算发出；
   发一条 10–40 秒，失败没有可靠回执；发送是串行队列。
2. **只转文字。** QQ 侧只拼 `text` 消息段：图片、表情、文件、语音等没有文本内容 → 不会转发；
   抖音侧只取 `text` / `kind`：卡片会加 `[卡片]` 标记，空卡片是 `[分享卡片]`，其它空内容是 `[非文字消息]`。
   **不转发头像、图片。**
3. **陌生人 / 新会话读不到。** 必须「已经聊过天」；强制绑定能通过，但后续每轮读私信仍可能失败并记进 `lastError`。
4. **QQ 侧是轮询，不是推送。** 每轮拉**最近 20 条**；`pollMs` 默认 15 秒（即 15–20 秒一档的节奏，
   可调范围 8–120 秒）。两轮之间如果群里/私聊刷了超过 20 条，中间的消息会漏。
5. **每方向单轮最多 5 条。** 超出的部分计入 `skipped`，并从「已见」集合里摘掉，
   **下一轮会继续转**（水位回退到最后一条已转消息，所以不会把一屏消息一次刷到 QQ，也不会丢）。
6. **绑的 QQ 群若同时接 AI，会有双份消息：** 桥转发的内容与 AI 的回复都在群里，AI 还可能自己回话。
7. **一次只能绑一个 QQ 会话 ↔ 一位抖音好友**；重新绑定 / 换绑会**重置水位重新对表**（不补发历史）。
8. **会话列表可能不全。** `/peers` 慢接口失败时退回 `$DSH_HOME/douyin-duty/memory/dm-*.json` 的本机记忆，
   只包含聊过的人、可能偏旧。
9. **抖音去重指纹是近似值。** 没有稳定消息 id，用「时间 + 方向 + 正文前 60 字」；同一秒发同样文字会被当成同一条（极少见）。
10. **未实测的部分：** 真实 QQ 账号 + 真实抖音账号的端到端收发只在代码层面推演过；
    本文档按代码与 [CONTRACT.md](CONTRACT.md) 整理，标「未实测」的边界请以你自己实测为准。
11. **（v0.2）视频 / 评论查询的耗时不稳：** 视频详情约 1–3 秒，热评约 10–20 秒；热评接口可能**限流**，
    拿不到就如实报错（不会编造评论）。「刷抖音」插件没装 / 没登录 / 缺 `.venv` 时直接报错。
12. **（v0.2）分享卡片慢且依赖好友会话：** 20–60 秒，需要已绑定抖音好友、且对方已有私信会话；
    抖音私信列表为空时卡片路径**跳过**（只记日志），不会硬发。
13. **（v0.2）短链解析可能失败：** `v.douyin.com` 要跟随 302，抖音对无浏览器指纹的请求可能断连；
    失败会明确提示，**贴完整视频链接**即可。
14. **（v0.2）真实端到端未实测：** 「QQ 里发链接 → 抖音真的收到分享卡片」「QQ 会话里的 AI 真的调到
    `douyin_video`」这两条链路是按代码与 CONTRACT §7 推演的，本次未用真实账号实测；按代码应如此。

---

## 11. 自检（离线）

```bash
node selfcheck.mjs
```

- **纯 Node，零网络，零 DSH 依赖**：一行 QQ / 抖音请求都不发；只读插件目录，并在系统临时目录
  （`os.tmpdir()`）建测试用状态文件，跑完删除。
- Node ≥ 18（`.mjs` + `fetch`）；Windows 上 PATH 里没有 `node` 时，用 node.exe 的绝对路径跑。
- 覆盖：状态默认值 / 脏输入规整 / 写读一致 / 损坏恢复 / 日志上限、文案与前缀、
  抖音挑新（首轮对表、只挑 them、去重、水位）、QQ 过滤（all / quote / prefix、跳过机器人自己、
  去重、单轮上限、`quotedOk` 兜底、v0.2 的 `skipIds`）、OneBot 响应规整（用注入的假 fetch）、
  路径与自动发现，以及包契约静态检查（exports、`dsh.bundle.patch`、locale、icon、CONTRACT/index/client 文件齐全、
  `index.js` 里有 `douyin_video`）。
- **v0.2 链接 / 视频解析**也纳入离线自检：`lib/links.mjs` 的链接识别 / 分类 / 目标解析 / 去链接文字，
  短链跟随与目标解析用**注入的假 fetch**（所以仍然零网络）；`lib/douyin-tools.mjs` 的
  `parseComments` / `parseVideoDetail` / `formatCount` / `formatVideoDigest` / `pickJson`，
  以及 `discoverDouyinTools`（在系统临时目录造假的 profile / 插件 / `.venv`，跑完删除，**不起真实子进程**）。
- **v0.3 推荐流（feed）**也纳入离线自检：`lib/douyin-tools.mjs` 的 `parseFeed` / `formatFeedDigest` /
  `formatFeedForQQ`，以及静态检查 `index.js` 有 `feed` 分支、引用了 `formatFeedForQQ`、`forward-pick.py` 路径存在。
- 当前共 **555 条断言**（v0.2 新增 127 条 + v0.3 feed 新增 35 条 + v0.3 共享记忆/Cookie 解析新增 79 条），
  本机跑 `node selfcheck.mjs` 应输出 `555 passed, 0 failed`（退出码 0）。
- 成功时最后一行是 `N passed, M failed`；有失败会打印名字、期望、实际，并以 **exit code 1** 退出。
- 如果设置页 `client.js` 还没合入，相关条目会打印 **SKIP**（不算失败）；合入后自动变成正式检查。

---

## 12. 文件结构

```text
dsh-qq-douyin-bridge/
├── package.json          # 插件声明（exports / dsh.bundle.patch / files）
├── cordis.patch.yml      # bundle 挂载（entry id: qq-douyin-bridge）
├── index.js              # 宿主半端：轮询、转发、HTTP 路由、Agent 工具（含 v0.2 只读工具 douyin_video）
├── client.js             # 设置页半端：设置 → QQ × 抖音桥
├── CONTRACT.md           # 宿主 ↔ 设置页 契约（唯一权威，改行为先看它）
├── README.md             # 本文
├── selfcheck.mjs         # 离线自检（§11，覆盖 v0.2 链接 / 视频解析）
├── icon.svg              # 插件图标
├── locale/
│   ├── zh.json           # meta.title / meta.description（中文）
│   └── en.json           # meta.title / meta.description（英文）
└── lib/                  # 纯函数层（无 DSH 依赖，selfcheck 直接测）
    ├── paths.mjs         # $DSH_HOME / 插件家目录 / 状态文件路径
    ├── discover.mjs      # 读 qq-bridge 配置、抖音本机记忆
    ├── onebot.mjs        # OneBot v11 HTTP 客户端 + 响应规整
    ├── douyin.mjs        # /api/douyin-duty 客户端（读快 / 发慢）
    ├── format.mjs        # 文案、前缀、指纹
    ├── filter.mjs        # 挑新与转发判定（纯函数，含 v0.2 的 skipIds）
    ├── links.mjs         # v0.2：抖音链接识别 / 分类 / 短链解析 / 目标解析
    ├── douyin-tools.mjs  # v0.2：复用「刷抖音」脚本（视频详情 / 热评 / 分享卡片 / 打开浏览器）
    └── store.mjs         # 状态默认值 / 规整 / 原子读写（含 v0.2 的 links / linkRecent）
```

运行数据不写进插件包目录，在：

- `$DSH_HOME/qq-douyin-bridge/state.json` —— 本插件状态（§8）；
- `$DSH_HOME/qq-bridge/config.json` —— QQ 桥接配置（本插件只读，拿 `snowluma.*`）；
- `$DSH_HOME/douyin-duty/` —— 「刷抖音」插件的登录态与聊天记忆（本插件只读，用它的 HTTP API）。

---

## 许可证

MIT
