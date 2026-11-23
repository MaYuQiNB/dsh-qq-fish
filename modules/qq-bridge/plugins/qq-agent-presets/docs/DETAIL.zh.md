# QQ 聊天预设与模式控制台

QQ 桥接的 DSH 端插件（2026-11-23 起由「QQ 聊天预设」与「QQ 模式控制台」两个 bundle 合并而来），
提供两件事：

1. 为 QQ 会话提供两个专用 DSH agent 预设，由 qq-bridge 按工作模式自动选用；
2. 在 DSH 的「设置 → 插件」里暴露 `qq-mode` 命名空间，切换 QQ 桥接的工作模式（切换后下次 QQ 桥接加载时生效）。

## 两个预设

- **qq-chat**：普通聊天预设。带人设、网页搜索、待办、上下文压缩等基础能力，适合一代聊天模式。
- **qq-chat-v2**：二代仿真预设。在 qq-chat 的基础上配合 `qq_*` 工具使用，承担潜水/唤醒、拟人化分条发送、表情包、语音等社交行为。

## 安全守卫

两个预设共用 **qq-tool-restrict**：按白名单限制 QQ 会话里 agent 能调用的工具，避免在聊天里误触敏感能力。

## 四种模式

- **chat（普通聊天）**：QQ 会话按 `qq-chat` 预设聊天，适合平时闲聊。
- **closed-agent（封闭代理）**：只对私聊主人开放，可使用完整工具集，允许你直接在 QQ 上指挥 DSH 干活；所用预设可在 qq-bridge 控制台里改（默认 `standard`）。
- **reserved（一代仿真）**：按「观望 → 活跃 → 试探 → 退场」的状态机在群里选择性发言；AI 可输出 `[SILENT]` 表示潜水，用空格分句来分条发送。
- **reserved2（二代仿真）**：当前推荐模式。消息不再自动转发，AI 用 `qq_get_unread_messages`、`qq_send_message` 等工具自主读消息、发言、等待，并设置唤醒/潜水；DSH 端使用 `qq-chat-v2` 预设。

## 提示

- 需要本机的 QQ 桥接（SnowLuma + qq-bridge）正在运行。
- 各模式的完整说明见 qq-bridge 的 README 与 docs 目录。
- 预设由 qq-bridge 的 `scripts/setup-dsh.mjs` 维护；调整 QQ 模式、人格或工具权限时，请以 qq-bridge 控制台为准。
