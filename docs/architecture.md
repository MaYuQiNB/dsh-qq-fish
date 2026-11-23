# 架构

```
QQ 客户端 ──(QQNT)── SnowLuma ──OneBot(HTTP 3000 / WS 3001)── qq-bridge (Node)
                                                              │
                                            DSH Web API ◄─────┘  (session.prompt / events.mux)
                                                              │
                                                       DSH agent (preset qq-chat-v2)
                                                              │
                     ┌────────────────────────────────────────┼───────────────────────┐
                     │                    │                   │                       │
              qq_file_* (工作区)    task_hub (任务)     generate_image (千问)   qq_send_image (回图)
```

## 端口

| 端口 | 组件 | 说明 |
| --- | --- | --- |
| 3000 / 3001 | SnowLuma OneBot | HTTP / WebSocket（本机） |
| 3100 | qq-bridge 控制台 | token 在 `state/console-token` |
| 3210 | 音色编辑器 | Breeze TTS |
| 3211 | call-chat | 通话 AI |
| 3300 / 3443 | webcall | HTTP / HTTPS（局域网） |
| 5099 | SnowLuma WebUI | 管理端 |
| 动态 | DSH Web | 每次重启端口会变；`ops/dsh-bridge-sync.cjs` 负责同步 |

## 数据流（一条 QQ 消息）

1. SnowLuma 收到消息 → OneBot 事件
2. bridge 白名单校验 → 语音转写 / 图片理解 / 视频转写 / 链接预览
3. 投递到 DSH 会话（preset qq-chat-v2，工具白名单守卫）
4. agent 决定回不回、用哪些工具
5. 回复经 bridge 发送到 QQ（分条、节奏、回读校验）

## 关键安全设计

- **工具白名单**（`qq-tool-restrict.mjs`）：注册期隐藏 + 执行期 guard 兜底
- **文件根限制**：`fileTools.allowRoots`
- **发送白名单**：`allow.private` / `allow.groups`
- **个人号保护**：只卸载非 bot 账号 hook，不退出个人 QQ
