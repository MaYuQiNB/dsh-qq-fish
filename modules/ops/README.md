# ops · Windows 运维脚本

| 脚本 | 作用 |
| --- | --- |
| `bridge-watchdog.ps1` | 每 5 分钟巡检：SnowLuma / QQ / DSH 端口同步 / bridge / webcall / 个人号守卫 |
| `personal-guard.ps1` | 个人号保护：发现非 bot 账号被 hook 只 unload，**不退出登录** |
| `dsh-bridge-sync.cjs` | 发现 DSH 当前端口并写回 `qq-bridge/config.json`（跟随 DSH 进程） |
| `start-qq-assistant.ps1` | 一键拉起整套（SnowLuma、bridge、音色编辑器、webcall、守卫） |
| `watchdog-hidden.vbs` / `start-guard-hidden.vbs` | 无窗口启动（计划任务用） |
| `webcall-start.vbs` | 无窗口启动 webcall |
| `restart.bat` / `start.bat` | 重启/启动封装（无 pause） |
| `tts-synth.ps1` / `voice-say.ps1` | Breeze 语音合成小工具 |

## 使用前

1. 路径里的 `C:\Users\<YOU>` 换成你的用户目录
2. `qq-bridge`、SnowLuma、DSH 的安装位置按需修改
3. 计划任务示例：

```powershell
schtasks /Create /TN "QQBridgeWatchdog" /SC MINUTE /MO 5 /TR "wscript.exe \"C:\path\watchdog-hidden.vbs\"" /F
```
