# 个人号保护 v3：只允许机器人号（<BOT_QQ>）被 hook；个人号只卸载、不退出。
# 关键变化：不会盲目 load 未知进程——load 后短轮询识别账号，若不是机器人号立刻卸载并记住该 PID，
# 避免每 5 分钟把个人号反复挂上（v2 出现过这个问题）。
param(
    [string]$ApiBase = 'http://127.0.0.1:5099',
    [string]$LogPath = 'C:\Users\<YOU>\.dsh\QQ\personal-guard.log'
)
$ErrorActionPreference = 'Continue'
$BotUin = '<BOT_QQ>'
$PersonalUin = '<OWNER_QQ>'
$StatePath = $LogPath -replace '\.log$', '-state.json'

function Log([string]$msg) {
    Add-Content -Path $LogPath -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $msg) -Encoding UTF8 -ErrorAction SilentlyContinue
}

function Load-State {
    try { if (Test-Path $StatePath) { return (Get-Content $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json) } } catch {}
    return [pscustomobject]@{ personalPids = @() }
}
function Save-State($state) {
    try { $state | ConvertTo-Json -Depth 5 | Set-Content -Path $StatePath -Encoding UTF8 -ErrorAction SilentlyContinue } catch {}
}
function Get-PidUins([object]$p) {
    $u = ''; $a = ''
    if ($null -ne $p.uin) { $u = [string]$p.uin }
    if ($p.account) { $a = [string]$p.account.uin }
    return @($u, $a)
}

try {
    $heartbeat = $LogPath -replace '\.log$', '-last-run.txt'
    try { Set-Content -Path $heartbeat -Value (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') -Encoding UTF8 -ErrorAction SilentlyContinue } catch {}

    $login = Invoke-RestMethod -Uri "$ApiBase/api/login" -Method Post -Body '{"password":"@deepseek"}' -ContentType 'application/json' -TimeoutSec 15
    $token = $login.token
    if (-not $token) { Log '登录 SnowLuma 失败（无 token）'; exit 0 }
    $headers = @{ Authorization = "Bearer $token" }
    $state = Load-State
    $personalPids = @($state.personalPids)

    function Get-List { return @((Invoke-RestMethod -Uri "$ApiBase/api/processes" -Headers $headers -TimeoutSec 20).list) }

    $list = Get-List
    if ($list.Count -eq 0) { Log 'SnowLuma 未发现任何 QQ 进程'; exit 0 }

    $botOnline = $false
    # 1) 卸载已 hook 的非机器人账号（只卸载，不退出 QQ）
    foreach ($p in $list) {
        $uins = Get-PidUins $p
        if ($uins -contains $BotUin) {
            if ($p.status -eq 'online' -and $p.connected -eq $true) { $botOnline = $true }
            continue
        }
        if (($uins -contains $PersonalUin) -or ($p.injected -eq $true)) {
            try {
                Invoke-RestMethod -Uri ("$ApiBase/api/processes/" + $p.pid + "/unload") -Method Post -Headers $headers -Body '{}' -ContentType 'application/json' -TimeoutSec 20 | Out-Null
                Log ("已卸载非机器人账号（登录状态保留）：pid=" + $p.pid + " uin=" + $p.uin)
                if ($uins -contains $PersonalUin) { if (-not ($personalPids -contains [string]$p.pid)) { $personalPids += [string]$p.pid } }
            } catch {
                Log ("卸载失败 pid=" + $p.pid + "：" + $_.Exception.Message)
            }
        }
    }
    $state.personalPids = $personalPids
    Save-State $state
    if ($botOnline) { exit 0 }

    # 2) 机器人号不在线：只尝试加载“没被确认是个人号”的进程，load 后立刻识别
    $candidates = @($list) | Where-Object {
        $uins = Get-PidUins $_
        -not ($uins -contains $BotUin) -and -not ($personalPids -contains [string]$_.pid)
    }
    if ($candidates.Count -eq 0) {
        Log '机器人号未登录，且没有可尝试的进程（请在这台电脑登录 <BOT_QQ> / 大肥鱼）'
        exit 0
    }
    foreach ($c in $candidates) {
        try {
            Invoke-RestMethod -Uri ("$ApiBase/api/processes/" + $c.pid + "/load") -Method Post -Headers $headers -Body '{}' -ContentType 'application/json' -TimeoutSec 30 | Out-Null
            Log ("尝试加载进程 pid=" + $c.pid)
        } catch {
            Log ("加载进程失败 pid=" + $c.pid + "：" + $_.Exception.Message)
            continue
        }
        $resolved = $false
        for ($i = 0; $i -lt 16; $i++) {
            Start-Sleep -Milliseconds 500
            $now = Get-List
            $entry = @($now) | Where-Object { $_.pid -eq $c.pid } | Select-Object -First 1
            if (-not $entry) { continue }
            $uins = Get-PidUins $entry
            if ($uins -contains $BotUin) {
                Log ("机器人号已恢复：pid=" + $c.pid + " status=" + $entry.status)
                exit 0
            }
            $nonEmpty = $uins | Where-Object { $_ -ne '' -and $_ -ne '0' }
            if ($nonEmpty) {
                try {
                    Invoke-RestMethod -Uri ("$ApiBase/api/processes/" + $c.pid + "/unload") -Method Post -Headers $headers -Body '{}' -ContentType 'application/json' -TimeoutSec 20 | Out-Null
                    Log ("该进程是 uin=" + ($nonEmpty -join ',') + "，已卸载（登录状态保留）并记住 pid=" + $c.pid)
                } catch { Log ("卸载非机器人进程失败 pid=" + $c.pid) }
                if (-not ($personalPids -contains [string]$c.pid)) { $personalPids += [string]$c.pid }
                $state.personalPids = $personalPids
                Save-State $state
                $resolved = $true
                break
            }
        }
        if (-not $resolved) {
            try {
                Invoke-RestMethod -Uri ("$ApiBase/api/processes/" + $c.pid + "/unload") -Method Post -Headers $headers -Body '{}' -ContentType 'application/json' -TimeoutSec 20 | Out-Null
                Log ("进程 pid=" + $c.pid + " 加载后仍未登录，已卸载")
            } catch {}
        }
    }
    Log '机器人号仍未连上（若大肥鱼 QQ 没登录，请先登录）'
} catch {
    Log ("保护检查异常：" + $_.Exception.Message)
}
