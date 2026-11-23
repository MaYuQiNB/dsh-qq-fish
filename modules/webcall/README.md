# webcall · 浏览器视频通话

一个本地网页，左边是你的摄像头，右边是 DeepSeek 的“视频画面”（鱼缸卧室场景 + 鲸鱼动画），按住说话 → 语音识别 → AI 回复 → Breeze 语音播放。

## 依赖

| 组件 | 用途 | 默认端口 |
| --- | --- | --- |
| Node ≥ 18 | 本服务 | 3300 / 3443 |
| 音色编辑器（Breeze TTS） | `/api/preview` 合成语音 | 3210 |
| call-chat-server | `/chat` 调 DSH agent | 3211 |
| faster-whisper + Python | 语音识别 | 脚本内调用 |
| ffmpeg | webm/mp4 → wav | 脚本内调用 |

## 启动

```powershell
copy qwen.example.json qwen.json   # 千问（图片/对话可用）
node server.mjs
# 打开 http://127.0.0.1:3300
```

配置：`server.mjs` 顶部的 `PY`、`FFMPEG`、`ASR_ONE`、场景目录等常量按你的机器改。
`gen-tls.py` 可生成本地 CA + 服务端证书（HTTPS 3443，手机装 ca.crt 后可用摄像头）。

## 公网访问

- 临时：`start-tunnel.ps1`（Cloudflare quick tunnel，地址每次重启会变）
- 固定：`start-ngrok.ps1 -Token xxx -Domain xxx.ngrok-free.app`

## 接口

- `GET /` 页面；`GET /ca.crt` 下载本地 CA
- `POST /api/asr`（音频 raw body）→ `{text}`
- `POST /api/chat` `{text, engine}` → `{reply}`（engine=qwen 走千问）
- `POST /api/tts` `{text, voice}` → wav
- `POST /api/qwen/chat` `{text, system?}` → 千问直连

## License
MIT
