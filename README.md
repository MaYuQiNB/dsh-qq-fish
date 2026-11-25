# dsh-qq-fish · 模块化的 QQ 鱼套件

把「QQ ↔ DeepSeek Harness」这套东西拆成独立模块：**每个模块都能单独下载、单独使用**，不需要把整个仓库克隆下来。

> 适用：DeepSeek Harness（DSH）0.2.x + SnowLuma（QQNT 协议端）+ Windows。
> 本仓库只包含我们自己的代码/配置，**不包含** SnowLuma 二进制、QQ 客户端、模型权重或任何密钥。

## 模块一览

| 模块 | 位置 | 作用 | 依赖 |
| --- | --- | --- | --- |
| **qq-bridge** | `modules/qq-bridge/` | QQ 消息 ↔ DSH 会话的桥接核心（收发、语音、图片/视频理解、空间、表情、白名单、控制台） | Node ≥ 20、SnowLuma OneBot HTTP/WS、DSH |
| **qq-douyin-bridge** | `modules/qq-douyin-bridge/` | QQ × 抖音互通插件（链接分享、视频理解、私信转发） | DSH、抖音已登录 |
| **webcall** | `modules/webcall/` | 浏览器视频通话网页：摄像头 + Breeze 语音 + Whisper 转写 + 千问对话 | Node、Python(faster-whisper)、ffmpeg、3210 音色服务 |
| **qwen-coder** | `modules/qwen-coder/` | 把写代码的活交给千问（OpenAI 兼容 API） | Node ≥ 18、千问 API Key |
| **persona** | `modules/persona/` | DSH agent 预设（qq-chat-v2）+ 角色卡 + 工具白名单守卫 | DSH |
| **ops** | `modules/ops/` | Windows 运维脚本：看门狗、个人号保护、端口同步、隐藏启动 | PowerShell、Node |

每个模块目录内都有自己的 `README.md`，写明「单独安装 / 单独升级 / 卸载」。

## 只下载一个模块

### 方式 A：Sparse checkout（推荐，保留 git 更新能力）

```bash
git clone --filter=blob:none --sparse https://github.com/<owner>/dsh-qq-fish.git
cd dsh-qq-fish
# 只要 webcall 和 qwen-coder
git sparse-checkout set modules/webcall modules/qwen-coder
```

### 方式 B：Release 里的单模块压缩包

每次打 tag（如 `v1.0.0`）时，CI 会把每个模块分别打成 zip 挂到 Release：

```
qq-bridge-v1.0.0.zip
webcall-v1.0.0.zip
qwen-coder-v1.0.0.zip
ops-v1.0.0.zip
persona-v1.0.0.zip
qq-douyin-bridge-v1.0.0.zip
```

点开 Release 只下你要的那个即可。

### 方式 C：直接拿目录

GitHub 网页进入 `modules/<名字>/`，用第三方 download-directory 工具或逐个文件下载。

## 快速开始（以 webcall 为例）

```powershell
# 1. 只取这个模块
git clone --filter=blob:none --sparse https://github.com/<owner>/dsh-qq-fish.git
cd dsh-qq-fish
git sparse-checkout set modules/webcall
cd modules/webcall

# 2. 准备配置
copy qwen.example.json qwen.json      # 填 apiKey / baseUrl / models
# 3. 依赖：Node 18+、Python + faster-whisper、ffmpeg
# 4. 启动
node server.mjs
# 打开 http://127.0.0.1:3300
```

## 安全边界（先读）

- 所有模块都**不含**任何真实 token / QQ 号 / 本机路径，配置里是占位符。
- QQ 会话默认只允许白名单里的工具；本地命令执行、白名单外文件读写都会被拒。
- 个人号保护脚本只「卸载 hook」，绝不退出/关闭你的个人 QQ。
- 详见 [docs/security.md](docs/security.md)。

## 文档

- [docs/capabilities.md](docs/capabilities.md) — QQ 鱼的能力清单（能做什么/不能做什么）
- [docs/architecture.md](docs/architecture.md) — 组件、端口、数据流
- [docs/security.md](docs/security.md) — 白名单、密钥、发布注意
- 各模块目录下的 README

- [CHANGELOG.md](CHANGELOG.md) — 版本变更记录

## License

MIT。SnowLuma、DeepSeek Harness、QQ 客户端等第三方组件遵循各自许可证，本仓库不重新分发它们。
