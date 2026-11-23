param(
    [string]$Text = '',
    [string]$Voice = '',
    [string]$Target = '',
    [switch]$NoSend,
    [switch]$ListVoices
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

# ── QQ 语音合成 + 发送（Windows OneCore 中文语音） ───────────────────
# 用法：
#   powershell -ExecutionPolicy Bypass -File voice-say.ps1 -Text "要说的话"
#   powershell -ExecutionPolicy Bypass -File voice-say.ps1 -Text "..." -Voice "Microsoft Yaoyao"
#   powershell -ExecutionPolicy Bypass -File voice-say.ps1 -ListVoices
#   powershell -ExecutionPolicy Bypass -File voice-say.ps1 -Text "..." -Target "private:123456" -NoSend
$QQRoot = 'C:\Users\<YOU>\.dsh\QQ'
$Bridge = 'C:\Users\<YOU>\.dsh\qq-bridge'
$AudioDir = Join-Path $Bridge 'audio'
$ConfigPath = Join-Path $QQRoot 'voice-config.json'

# 默认音色配置
$Config = [ordered]@{
    voice  = 'Microsoft Kangkang'
    target = 'private:<OWNER_QQ>'
}
if (Test-Path $ConfigPath) {
    try {
        $loaded = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($loaded.voice) { $Config.voice = [string]$loaded.voice }
        if ($loaded.target) { $Config.target = [string]$loaded.target }
    } catch { Write-Host ('⚠️ 读取 voice-config.json 失败：' + $_.Exception.Message) -ForegroundColor Yellow }
}
if (-not $Voice) { $Voice = $Config.voice }
if (-not $Target) { $Target = $Config.target }

# WinRT 语音
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.SpeechSynthesis.SpeechSynthesisStream, Windows.Media, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($op, $type) {
    $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    return $task.Result
}

$allVoices = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices
if ($ListVoices) {
    Write-Host '可用中文音色：' -ForegroundColor Cyan
    $allVoices | Where-Object { $_.Language -like 'zh-*' } |
        Select-Object DisplayName, Gender, Language |
        Format-Table -AutoSize | Out-String | Write-Host
    Write-Host ('当前默认：' + $Config.voice)
    exit 0
}

if (-not $Text) { $Text = Read-Host '请输入要合成的话' }
if (-not $Text) { Write-Host '没有要合成的内容'; exit 1 }

$voiceInfo = $allVoices | Where-Object { $_.DisplayName -eq $Voice } | Select-Object -First 1
if (-not $voiceInfo) {
    $voiceInfo = $allVoices | Where-Object { $_.Language -like 'zh-CN*' } | Select-Object -First 1
    Write-Host ('⚠️ 没找到音色 "' + $Voice + '"，改用 ' + $voiceInfo.DisplayName) -ForegroundColor Yellow
}

$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$synth.Voice = $voiceInfo
$stream = Await ($synth.SynthesizeTextToStreamAsync($Text)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
$size = [uint32]$stream.Size
$reader = [Windows.Storage.Streams.DataReader]::new($stream.GetInputStreamAt(0))
$null = Await ($reader.LoadAsync($size)) ([uint32])
$bytes = New-Object byte[] $size
$reader.ReadBytes($bytes)
$reader.Dispose(); $stream.Dispose(); $synth.Dispose()

New-Item -ItemType Directory -Path $AudioDir -Force | Out-Null
$fileName = 'tts-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.wav'
$filePath = Join-Path $AudioDir $fileName
[System.IO.File]::WriteAllBytes($filePath, $bytes)

Write-Host ('音色：' + $voiceInfo.DisplayName + ' (' + $voiceInfo.Gender + ')')
Write-Host ('音频：' + $filePath + '  ' + [math]::Round((Get-Item $filePath).Length / 1KB, 1) + ' KB')

if ($NoSend) {
    Write-Host '（-NoSend：只生成不发送）'
    exit 0
}

Push-Location $Bridge
try {
    & (Join-Path $Bridge 'node.exe') (Join-Path $Bridge 'scripts\send-voice.mjs') send ('audio\' + $fileName) $Target
    $code = $LASTEXITCODE
} finally { Pop-Location }
if ($code -ne 0) { Write-Host '语音发送失败' -ForegroundColor Red; exit $code }
