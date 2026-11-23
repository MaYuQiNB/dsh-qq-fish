# 从本仓库安装单个模块到目标目录（默认 ~/.dsh/qq-fish-modules）
param(
  [Parameter(Mandatory = $true)][string]$Module,
  [string]$Target = (Join-Path $env:USERPROFILE ".dsh\qq-fish-modules")
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$src = Join-Path $root "modules\$Module"
if (-not (Test-Path $src)) {
  $available = (Get-ChildItem (Join-Path $root 'modules') -Directory | Select-Object -ExpandProperty Name) -join ', '
  throw "没有模块 $Module。可用：$available"
}
$dest = Join-Path $Target $Module
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item (Join-Path $src '*') $dest -Recurse -Force
Write-Host "已安装 $Module -> $dest"
Write-Host "请阅读 $dest\README.md 配置后再启动。"
