param([switch]$NoBrowser)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

# ── 本机 QQ 助手一键启动 ─────────────────────────────────────────────
# 依次确保：DeepSeek Harness（端口每次启动会变，脚本自动发现）→ SnowLuma（5099）
# → 音色编辑器（3210，AI 若娜瓦语音的本地合成服务）→ QQ 机器人 OneBot（3000/3001）
# → qq-bridge 桥接（3100）。
$QQRoot = 'C:\Users\<YOU>\.dsh\QQ'
$Snow = Join-Path $QQRoot 'SnowLuma'
$VoiceEditor = Join-Path $QQRoot 'voice-editor'
$Bridge = 'C:\Users\<YOU>\.dsh\qq-bridge'
$Node = Join-Path $Bridge 'node.exe'
$SyncScript = Join-Path $QQRoot 'dsh-bridge-sync.cjs'
$DshExe = 'C:\Users\<YOU>\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe'
$BotUin = '<BOT_QQ>'

function Test-PortOpen([int]$Port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if ($iar.AsyncWaitHandle.WaitOne(400)) { $client.EndConnect($iar); return $true }
        return $false
    } catch { return $false } finally { try { $client.Close() } catch {} }
}

function Wait-PortOpen([int]$Port, [int]$Seconds) {
    for ($i = 0; $i -lt $Seconds; $i++) {
        if (Test-PortOpen $Port) { return $true }
        Start-Sleep -Seconds 1
    }
    return $false
}

function Get-DshInfo {
    if (-not (Test-Path $Node) -or -not (Test-Path $SyncScript)) { return $null }
    try {
        $raw = & $Node $SyncScript 2>$null | Select-Object -Last 1
        if (-not $raw) { return $null }
        return ($raw | ConvertFrom-Json)
    } catch { return $null }
}

Write-Host ''
Write-Host '========== QQ 助手启动 ==========' -ForegroundColor Cyan

# 1) DeepSeek Harness
$dsh = Get-DshInfo
if (-not $dsh -or -not $dsh.ok) {
    Write-Host '[1/7] DeepSeek Harness 未运行，正在启动应用…' -ForegroundColor Yellow
    if (Test-Path $DshExe) { Start-Process -FilePath $DshExe | Out-Null }
    $deadline = (Get-Date).AddSeconds(120)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 3
        $dsh = Get-DshInfo
        if ($dsh -and $dsh.ok) { break }
    }
}
if ($dsh -and $dsh.ok) {
    Write-Host ("[1/7] DeepSeek Harness 就绪：" + $dsh.url) -ForegroundColor Green
} else {
    Write-Host '[1/7] ⚠️ 未发现 DeepSeek Harness Web 服务（桥接将无法生成回复）' -ForegroundColor Red
}

# 2) SnowLuma
if (Test-PortOpen 5099) {
    Write-Host '[2/7] SnowLuma 已在运行：http://127.0.0.1:5099' -ForegroundColor Green
} else {
    Write-Host '[2/7] 正在启动 SnowLuma…' -ForegroundColor Yellow
    if (Test-Path (Join-Path $Snow 'node.exe')) {
        Start-Process -FilePath (Join-Path $Snow 'node.exe') -ArgumentList 'index.mjs' -WorkingDirectory $Snow -WindowStyle Hidden | Out-Null
        if (Wait-PortOpen 5099 60) { Write-Host '[2/7] SnowLuma 就绪：http://127.0.0.1:5099' -ForegroundColor Green }
        else { Write-Host '[2/7] ⚠️ SnowLuma 启动超时' -ForegroundColor Red }
    } else {
        Write-Host ('[2/7] ⚠️ 找不到 SnowLuma：' + $Snow) -ForegroundColor Red
    }
}

# 3) 音色编辑器（AI 若娜瓦语音的本地合成服务；GPU 模型会在后台预热约 1 分钟）
if (Test-PortOpen 3210) {
    Write-Host '[3/7] 音色编辑器已在运行：http://127.0.0.1:3210' -ForegroundColor Green
} else {
    Write-Host '[3/7] 正在启动音色编辑器（GPU 模型后台预热，约 1 分钟）…' -ForegroundColor Yellow
    $editorServer = Join-Path $VoiceEditor 'server.mjs'
    if ((Test-Path $Node) -and (Test-Path $editorServer)) {
        Start-Process -FilePath $Node -ArgumentList 'server.mjs' -WorkingDirectory $VoiceEditor -WindowStyle Hidden | Out-Null
        if (Wait-PortOpen 3210 30) { Write-Host '[3/7] 音色编辑器就绪：http://127.0.0.1:3210（模型预热中，AI 语音稍后可用）' -ForegroundColor Green }
        else { Write-Host '[3/7] ⚠️ 音色编辑器启动超时' -ForegroundColor Red }
    } else {
        Write-Host ('[3/7] ⚠️ 找不到音色编辑器：' + $VoiceEditor) -ForegroundColor Red
    }
}

# 4) QQ 机器人 OneBot（登录机器人号后才会监听 3000/3001）
if (Test-PortOpen 3001) {
    Write-Host '[4/7] QQ 机器人 OneBot 已就绪（3000/3001）' -ForegroundColor Green
} else {
    Write-Host '[4/7] 等待 QQ 机器人账号登录并挂载（最多 60 秒）…' -ForegroundColor Yellow
    if (Wait-PortOpen 3001 60) {
        Write-Host '[4/7] QQ 机器人 OneBot 已就绪（3000/3001）' -ForegroundColor Green
    } else {
        Write-Host ('[4/7] ⚠️ OneBot 未监听：请在 QQ 客户端登录机器人号 ' + $BotUin + '（SnowLuma 会自动挂载）') -ForegroundColor Red
    }
}

# 5) qq-bridge
$restartBridge = $false
if ($dsh -and $dsh.ok -and $dsh.changed -and (Test-PortOpen 3100)) {
    Write-Host '[5/7] 检测到 DSH 网址变化，正在重启桥接…' -ForegroundColor Yellow
    $restartBridge = $true
    if (Test-Path (Join-Path $Bridge 'restart.bat')) {
        Start-Process -FilePath 'cmd.exe' -ArgumentList '/d', '/c', 'restart.bat' -WorkingDirectory $Bridge -WindowStyle Hidden | Out-Null
        Start-Sleep -Seconds 12
    }
}

if (-not (Test-PortOpen 3100)) {
    # 清理上次异常退出留下的僵死锁
    $lock = Join-Path $Bridge 'state\bridge.lock'
    if (Test-Path $lock) {
        $pidText = (Get-Content $lock -Raw -ErrorAction SilentlyContinue).Trim()
        $alive = $false
        if ($pidText -match '^\d+$') { $alive = [bool](Get-Process -Id ([int]$pidText) -ErrorAction SilentlyContinue) }
        if (-not $alive) { Remove-Item $lock -Force -ErrorAction SilentlyContinue }
    }
    Write-Host '[5/7] 正在启动 qq-bridge…' -ForegroundColor Yellow
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/d', '/c', 'start.bat' -WorkingDirectory $Bridge -WindowStyle Hidden | Out-Null
    if (Wait-PortOpen 3100 45) { Write-Host '[5/7] qq-bridge 就绪：http://127.0.0.1:3100' -ForegroundColor Green }
    else { Write-Host '[5/7] ⚠️ qq-bridge 启动超时，请查看 state\bridge.log' -ForegroundColor Red }
} else {
    Write-Host '[5/7] qq-bridge 已在运行：http://127.0.0.1:3100' -ForegroundColor Green
}

# 6) 电话 AI 服务（call-chat）
$callBase = 'C:\Users\<YOU>\Documents\deepseek-harness\default-workspace\.runtime\qqtools'
$callPy = Join-Path $QQRoot 'voice-clone\venv\Scripts\python.exe'
if (-not (Test-PortOpen 3211)) {
    Write-Host '[6/7] 正在启动电话 AI 服务…' -ForegroundColor Yellow
    Start-Process -FilePath $Node -ArgumentList ('"' + (Join-Path $callBase 'call-chat-server.mjs') + '"') -WorkingDirectory $callBase -WindowStyle Hidden | Out-Null
    if (Wait-PortOpen 3211 30) { Write-Host '[6/7] 电话 AI 服务就绪：http://127.0.0.1:3211' -ForegroundColor Green }
    else { Write-Host '[6/7] ⚠️ 电话 AI 服务启动超时' -ForegroundColor Red }
} else {
    Write-Host '[6/7] 电话 AI 服务已在运行：http://127.0.0.1:3211' -ForegroundColor Green
}

# 7) 自动接听 / 通话回环
$autoAnswerProc = Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*auto-answer.py*' }
if ($autoAnswerProc) {
    Write-Host '[7/7] 自动接听已在运行' -ForegroundColor Green
} else {
    Write-Host '[7/7] 正在启动自动接听…' -ForegroundColor Yellow
    Start-Process -FilePath $callPy -ArgumentList ('"' + (Join-Path $callBase 'auto-answer.py') + '"') -WorkingDirectory $callBase -WindowStyle Hidden | Out-Null
    Write-Host '[7/7] 自动接听已启动（ASR 模型约 25 秒预热）' -ForegroundColor Green
}

# 输出网址与令牌
$consoleToken = ''
$tokenFile = Join-Path $Bridge 'state\console-token'
if (Test-Path $tokenFile) { $consoleToken = (Get-Content $tokenFile -Raw -ErrorAction SilentlyContinue).Trim() }

Write-Host ''
Write-Host '========== 网址 ==========' -ForegroundColor Cyan
Write-Host ('SnowLuma 管理面板 : http://127.0.0.1:5099   (账号 admin)')
Write-Host ('桥接控制台         : http://127.0.0.1:3100')
Write-Host ('音色编辑器         : http://127.0.0.1:3210   (若娜瓦音色 / AI 语音合成)')
Write-Host ('电话 AI（内部）    : http://127.0.0.1:3211')
if ($consoleToken) { Write-Host ('桥接控制台令牌     : ' + $consoleToken) }
if ($dsh -and $dsh.ok) { Write-Host ('DeepSeek Harness   : ' + $dsh.url + '  （内部使用，每次启动会变，桥接已自动同步）') }
Write-Host ('机器人 QQ          : ' + $BotUin)
Write-Host ''
Write-Host '提示：QQ 客户端里需要保持机器人号在线；关闭本窗口不影响后台运行。' -ForegroundColor DarkGray

# 关闭 SnowLuma 自动 hook 后，由保护脚本把机器人号手动加载回来（不碰个人号）
try { Start-Process -FilePath 'wscript.exe' -ArgumentList (Join-Path $PSScriptRoot 'webcall-start.vbs') -WindowStyle Hidden | Out-Null } catch {}
$guardScript = Join-Path $PSScriptRoot 'personal-guard.ps1'
if (Test-Path $guardScript) { try { & $guardScript } catch {} }
if (-not $NoBrowser) {
    try { Start-Process 'http://127.0.0.1:5099' | Out-Null } catch {}
    try { Start-Process 'http://127.0.0.1:3100' | Out-Null } catch {}
    try { Start-Process 'http://127.0.0.1:3210' | Out-Null } catch {}
    Read-Host '按回车键关闭此窗口'
}
