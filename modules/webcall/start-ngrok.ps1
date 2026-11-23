# 启动 ngrok 固定域名隧道：把本地 3300 暴露为 https://<domain>
# 用法：
#   .\start-ngrok.ps1 -Token "你的authtoken" -Domain "xxxx.ngrok-free.app"
# 或先把 token/domain 写进 ngrok.json（同目录），再直接运行本脚本。
param(
    [string]$Token,
    [string]$Domain
)

$ErrorActionPreference = 'Continue'
$here = $PSScriptRoot
$ng = Join-Path $here 'ngrok-bin\ngrok.exe'
$cfgFile = Join-Path $here 'ngrok.json'
$log = Join-Path $here 'ngrok.log'
$urlFile = Join-Path $here 'public-url.txt'

if ((-not $Token -or -not $Domain) -and (Test-Path $cfgFile)) {
    $cfg = Get-Content $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $Token) { $Token = $cfg.token }
    if (-not $Domain) { $Domain = $cfg.domain }
}
if (-not (Test-Path $ng)) { Write-Output 'ngrok.exe 不存在'; exit 1 }
if (-not $Token) { Write-Output '缺少 authtoken：请传 -Token 或写 ngrok.json'; exit 2 }
if (-not $Domain) { Write-Output '缺少固定域名：请传 -Domain 或写 ngrok.json'; exit 2 }

$cfgOut = @{ token = $Token; domain = $Domain } | ConvertTo-Json
[System.IO.File]::WriteAllText($cfgFile, $cfgOut, (New-Object System.Text.UTF8Encoding($false)))

Get-Process ngrok -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
& $ng config add-authtoken $Token 2>&1 | Out-Null
Remove-Item $log -Force -ErrorAction SilentlyContinue

Start-Process -FilePath $ng -ArgumentList 'http','3300',"--domain=$Domain",'--log=stdout','--log-format=json' -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError (Join-Path $here 'ngrok.err') | Out-Null

for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Seconds 1
    $hit = Select-String -Path $log -Pattern 'started tunnel' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { break }
}
$url = "https://$Domain"
Set-Content -Path $urlFile -Value $url -Encoding UTF8
Write-Output $url
