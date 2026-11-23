# qq-bridge 看门狗（增强版 + 个人号保护）：每 5 分钟静默自检——
#   SnowLuma / QQ 客户端 / DSH 端口同步 / qq-bridge / 个人号保护，缺哪个就悄悄拉起来或清掉。
$ErrorActionPreference = 'Continue'
$dst = 'C:\Users\<YOU>\.dsh\qq-bridge'
$qqRoot = 'C:\Users\<YOU>\.dsh\QQ'
$snow = Join-Path $qqRoot 'SnowLuma'
$log = Join-Path $dst 'state\watchdog.log'

# 每次运行的心跳（用于确认计划任务确实在跑）
try { Set-Content -Path (Join-Path $qqRoot 'watchdog-last-run.txt') -Value (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') -Encoding UTF8 -ErrorAction SilentlyContinue } catch {}

function Write-WatchdogLog([string]$msg) {
    Add-Content -Path $log -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $msg) -Encoding UTF8 -ErrorAction SilentlyContinue
}

function Test-PortOpen([int]$Port) {
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        try {
            $iar = $c.BeginConnect('127.0.0.1', $Port, $null, $null)
            if ($iar.AsyncWaitHandle.WaitOne(300)) { $c.EndConnect($iar); return $true }
            return $false
        } finally { $c.Close() }
    } catch { return $false }
}

# 1) SnowLuma
if (-not (Test-PortOpen 5099)) {
    Write-WatchdogLog '5099 未监听，启动 SnowLuma'
    $snowExe = Join-Path $snow 'node.exe'
    if (Test-Path $snowExe) {
        Start-Process -FilePath $snowExe -ArgumentList 'index.mjs' -WorkingDirectory $snow -WindowStyle Hidden | Out-Null
        Start-Sleep -Seconds 10
    } else {
        Write-WatchdogLog "找不到 SnowLuma：$snowExe"
    }
}

# 2) QQ 客户端（没有它收不到消息/来电）
if (-not (Get-Process QQ -ErrorAction SilentlyContinue)) {
    Write-WatchdogLog 'QQ 客户端未运行，尝试启动'
    $qqExe = 'C:\Program Files\Tencent\QQNT\QQ.exe'
    if (Test-Path $qqExe) {
        Start-Process -FilePath $qqExe | Out-Null
        Start-Sleep -Seconds 15
    } else {
        Write-WatchdogLog '找不到 QQ.exe'
    }
}

# 3) DSH 端口同步（DSH 每次重启端口会变）
$bridgeNode = Join-Path $dst 'node.exe'
$sync = Join-Path $qqRoot 'dsh-bridge-sync.cjs'
$changed = $false
if ((Test-Path $bridgeNode) -and (Test-Path $sync)) {
    try {
        $raw = & $bridgeNode $sync 2>$null | Select-Object -Last 1
        if ($raw) {
            $info = $raw | ConvertFrom-Json
            if ($info.changed) { $changed = $true; Write-WatchdogLog ("DSH 端口已更新 -> " + $info.url) }
        }
    } catch {
        Write-WatchdogLog ("DSH 同步失败：" + $_.Exception.Message)
    }
}

# 4) qq-bridge
if (-not (Test-PortOpen 3100)) {
    $lock = Join-Path $dst 'state\bridge.lock'
    if (Test-Path $lock) {
        $pidText = (Get-Content $lock -Raw -ErrorAction SilentlyContinue).Trim()
        $alive = $false
        if ($pidText -match '^\d+$') { $alive = [bool](Get-Process -Id ([int]$pidText) -ErrorAction SilentlyContinue) }
        if (-not $alive) { Remove-Item $lock -Force -ErrorAction SilentlyContinue; Write-WatchdogLog "已清理僵死锁（pid=$pidText）" }
    }
    Write-WatchdogLog '3100 未监听，启动 qq-bridge'
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/d', '/c', 'start.bat' -WorkingDirectory $dst -WindowStyle Hidden | Out-Null
    Start-Sleep -Seconds 20
    if (Test-PortOpen 3100) { Write-WatchdogLog 'qq-bridge 已恢复（3100 监听中）' } else { Write-WatchdogLog '启动后仍未监听，请检查 state\bridge.log' }
} elseif ($changed) {
    Write-WatchdogLog 'DSH 端口变化，重启桥接以重连'
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/d', '/c', 'restart.bat' -WorkingDirectory $dst -WindowStyle Hidden | Out-Null
    Start-Sleep -Seconds 20
    Write-WatchdogLog '桥接已重启'
}

# 5) 个人号保护：SnowLuma 只允许机器人号，发现别的号就强制卸载 + 结束其进程
$guard = Join-Path $qqRoot 'personal-guard.ps1'
if (Test-Path $guard) {
    try {
        & $guard
    } catch {
        Write-WatchdogLog ("个人号保护执行失败：" + $_.Exception.Message)
    }
}

# 6) Web 视频通话服务（3300）
if (-not (Test-PortOpen 3300)) {
    $webcallVbs = Join-Path $qqRoot 'webcall-start.vbs'
    if (Test-Path $webcallVbs) {
        Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $webcallVbs + '"') -WindowStyle Hidden | Out-Null
        Write-WatchdogLog '3300 未监听，已启动 webcall'
    }
}