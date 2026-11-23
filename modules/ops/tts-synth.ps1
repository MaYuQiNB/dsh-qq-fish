param(
    [Parameter(Mandatory = $true)][string]$Request
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

# 请求 JSON: { text, voice, rate, out }
$req = Get-Content $Request -Raw -Encoding UTF8 | ConvertFrom-Json
$text = [string]$req.text
$voiceName = [string]$req.voice
$rate = [double]$req.rate
$out = [string]$req.out
if (-not $text) { throw 'text is empty' }
if (-not $out) { throw 'out is empty' }

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
$voiceInfo = $allVoices | Where-Object { $_.DisplayName -eq $voiceName } | Select-Object -First 1
if (-not $voiceInfo) { $voiceInfo = $allVoices | Where-Object { $_.Language -like 'zh-CN*' } | Select-Object -First 1 }

$rateRounded = [int][math]::Round($rate)
$ratePct = if ($rateRounded -ne 0) { $rateRounded.ToString('+0;-0;0') + '%' } else { '0%' }
$escaped = [System.Security.SecurityElement]::Escape($text)
$ssml = '<?xml version="1.0" encoding="utf-8"?><speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN"><prosody rate="' + $ratePct + '">' + $escaped + '</prosody></speak>'

$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$synth.Voice = $voiceInfo
$stream = Await ($synth.SynthesizeSsmlToStreamAsync($ssml)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
$size = [uint32]$stream.Size
$reader = [Windows.Storage.Streams.DataReader]::new($stream.GetInputStreamAt(0))
$null = Await ($reader.LoadAsync($size)) ([uint32])
$bytes = New-Object byte[] $size
$reader.ReadBytes($bytes)
$reader.Dispose(); $stream.Dispose(); $synth.Dispose()

$dir = Split-Path -Parent $out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
[System.IO.File]::WriteAllBytes($out, $bytes)

Write-Output ('{"ok":true,"out":' + (ConvertTo-Json $out) + ',"voice":' + (ConvertTo-Json $voiceInfo.DisplayName) + ',"bytes":' + $size + '}')
