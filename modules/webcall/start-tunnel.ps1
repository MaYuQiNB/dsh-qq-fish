# 启动 Cloudflare Quick Tunnel，把本地 3300 暴露成公网 HTTPS：
#   ps1 会在 cloudflared.log 里抓到 https://xxxx.trycloudflare.com 并写入 public-url.txt
$ErrorActionPreference = 'Continue'
$here = $PSScriptRoot
$cf = Join-Path $here 'cloudflared.exe'
$log = Join-Path $here 'cloudflared.log'
$err = Join-Path $here 'cloudflared.err'
$urlFile = Join-Path $here 'public-url.txt'
if (-not (Test-Path $cf)) { Write-Output 'cloudflared.exe 不存在'; exit 1 }

Get-Process cloudflared -ErrorAction SilentlyContinue | ForEach-Object { try { $_.Kill() } catch {} }
Remove-Item $log,$err -Force -ErrorAction SilentlyContinue
Start-Process -FilePath $cf -ArgumentList 'tunnel','--url','http://127.0.0.1:3300','--no-autoupdate' -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError $err | Out-Null

for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Seconds 1
    $m = Select-String -Path $log,$err -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($m) {
        $url = $m.Matches[0].Value
        Set-Content -Path $urlFile -Value $url -Encoding UTF8
        Write-Output $url
        exit 0
    }
}
Write-Output '未能在 40 秒内获取隧道地址，请查看 cloudflared.log'
exit 2
