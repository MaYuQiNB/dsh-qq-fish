# Changelog

## v1.1.0（2026-11-25）

### 新增：图片理解（千问视觉）
- QQ 收到图片/表情时，桥接自动调用千问视觉 `qwen3-vl-plus` 生成中文描述
- 描述以 `[图片内容参考（只给你理解用，回复时不要原样复述）]` 附在消息后，AI 用自己的话回应，不再原样搬运

### 新增：画图 + 发图到 QQ
- `generate_image` / `generate_images` / `edit_image` 加入 QQ 会话工具白名单（默认千问图像通道）
- 新增桥接端点 `POST /api/socialV2/send-image` 与 MCP 工具 `qq_send_image`：把工作区里的图片作为图片消息发到 QQ
- 预设新增画图规则：生成 → 发到 QQ → 补 1~2 句说明

### 新增：工作区文件工具
- `qq_file_list` / `qq_file_read` / `qq_file_write`
- 只能操作 `default-workspace` 与 `.dsh/QQ`；单文件 ≤ 800KB；写前自动备份 `.bak-时间戳`

### 新增：DSH 任务
- `task_hub` 加入白名单：QQ 里一句话有活，鱼可自动 `create` + `run` 任务并回任务 id
- 预设新增第 17~20 条：改文件 / 建任务 / 画图 / 看图

### 链接策略调整
- 发抖音链接默认**不再**自动发视频（只有用户明确要视频才发）
- 自动「视频理解」默认关闭，由鱼按需 `douyin_video action=describe`
- 自动在本机浏览器打开链接默认关闭（autoOpen=off）

### 其它
- `qq-tool-restrict` 守卫白名单更新
- 角色卡补充：接活、改文件、画图、看图规则

## v1.0.0（2026-11-24）
- 首次模块化发布：qq-bridge / qq-douyin-bridge / webcall / qwen-coder / persona / ops
- Release 提供每个模块独立的 zip
