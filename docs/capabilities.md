# QQ 鱼能力清单

> 对应配置：`qq-chat-v2` 预设 + `qq-bridge` 工具白名单（`socialV2.tools`）。

## 一、聊天与消息
- 收发文字：私聊 / 群聊，支持分条发送、引用回复、@ 某人
- 读取：未读、最近、历史、单条详情、合并转发、活跃成员
- 已读水位：按 `readThroughSeq` 提交，不漏标新消息
- 拍一拍：发 / 回
- 等待：`qq_wait_for_messages`（reply / messages 两种用途）
- 主动机会：冷场时按概率主动开口
- 发送校验：回读确认是否真正落地

## 二、语音（Breeze 音色）
- `qq_send_voice`：文字 → 语音条（≤200 字；2 条/分、10 条/时）
- 收到语音条自动转写（Whisper）
- 语音库浏览：`qq_list_voices`

## 三、图片与视频
- 看图：桥接自动调千问视觉（`qwen3-vl-plus`），把 `[图片内容参考]` 附在消息后（只供理解，不原样复述）
- 取图：`qq_get_message_images`（原图/表情，支持动图抽帧）
- 画图：`generate_image`（默认千问图像通道）+ `qq_send_image` 发到 QQ
- 表情：`qq_list_stickers` / `qq_get_sticker_image` / `qq_send_sticker` / `qq_collect_sticker`
- 视频理解：`douyin_video action=describe`（画面+画面文字+声音）
- 搬视频：`douyin_video action=watch`（仅用户明确要视频时）

## 四、文件与任务（工作区）
- `qq_file_list` / `qq_file_read` / `qq_file_write`（写前自动备份）
- 目录限制：`<workspace>` 与 `.dsh/QQ`；单文件 ≤ 800KB；二进制拒绝
- 任务：`task_hub create/run` 在 DSH 里建任务并启动
- 自动接活：判断句子里有活就自动建任务，回「任务 id」

## 五、空间 / 社交
- 发说说：`qq_post_qzone`（每天 1–2 条、每小时 1 条，可配图）
- 逛空间：`qq_qzone_list` / `qq_qzone_feeds` / `qq_qzone_detail`
- 互动：`qq_qzone_like` / `qq_qzone_comment` / `qq_qzone_delete`
- 分享卡片：抖音分享卡片发给好友

## 六、记忆 / 搜索
- `qq_memory_append/query/remove/clear`：轻量记忆（话题/念头/印象）
- brain-memory 长期记忆（QQ 标签）
- `qq_slang_query/submit`：黑话
- web 搜索 / 抓取（安全 MCP）
- `qq_get_prompt` / `qq_social_state` / `qq_mark_read` / `qq_set_wake_config`

## 七、明确不做
- 不执行系统命令、不启动进程
- 不读写白名单外文件
- 不泄露 token / 配置 / 系统信息
- 不自动发视频（须用户说“要视频”）；不原样搬运模型理解结果
