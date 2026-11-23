# 安全说明与发布注意

## 仓库里不应该有的东西

已在打包时剔除/替换：

- `config.json`（真实配置） → 只留 `config.example.json`
- `qwen.json`（API Key） → 只留 `qwen.example.json`
- `state/`（会话、token、日志） → 不打包
- `audio/`（个人语音素材） → 不打包
- `tls/`（私钥） → 不打包
- OneBot / console / OBS 密码 → 占位符
- 真实 QQ 号 → `<BOT_QQ>` / `<OWNER_QQ>`
- 本机路径 `C:\Users\<name>` → `C:\Users\<YOU>`

发布前建议再跑一遍：

```bash
grep -RInE "sk-[A-Za-z0-9_-]{16,}|Bearer |accessToken|password|C:\\\\Users\\\\" modules/ | head
```

## 运行时安全

- QQ 会话默认只允许：`mcp__snowluma__*`、`mcp__snowluma-host__*`、`mcp__web-search-safe__*`，以及白名单里的 `douyin_video`、`task_hub`、`generate_image`、`qq_file_*`
- 本地命令（pwsh/bash/read/write 等）在预设里被 restrict + guard 双重拒绝
- 文件工具限制根目录，写入自动备份
- 个人号保护：检测到非 bot 账号被 hook 时只 unload，不 taskkill / 不退出登录

## 密钥管理

- 千问 Key 放 `qwen.json`（本地，不提交）
- OneBot token 在 SnowLuma 配置里，不提交
- 控制台 token 由 bridge 自动生成在 `state/console-token`

## 免责

本项目只做本机消息桥接与自动化。使用前请确认符合 QQ/抖音/阿里云各平台条款；账号风险由使用者自担。
