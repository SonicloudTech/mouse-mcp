param(
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [ValidateRange(5, 7200)][int]$AutoCloseSeconds = 600,
    [ValidateRange(0, 2147483647)][int]$KeyboardTargetPid = 0,
    [switch]$StartHidden
)
$ErrorActionPreference = 'Stop'
$probeOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $probeOutput | Out-Null
$compilerPath = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compilerPath)) { throw 'The .NET Framework 4 x64 C# compiler was not found.' }
$sourcePath = Join-Path $PSScriptRoot 'raw-mouse-probe.cs'
$executablePath = Join-Path $probeOutput 'raw-mouse-probe.exe'
& $compilerPath /nologo /target:winexe /platform:x64 "/out:$executablePath" /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll $sourcePath
if ($LASTEXITCODE -ne 0) { throw "Probe compilation failed: $LASTEXITCODE" }
if ($StartHidden) {
    if ((Test-Path -LiteralPath (Join-Path $probeOutput 'raw-events.jsonl')) -or (Test-Path -LiteralPath (Join-Path $probeOutput 'probe-state.json'))) {
        throw 'Use a fresh evidence directory for a new passive probe run.'
    }
    $probeProcess = Start-Process -FilePath $executablePath -ArgumentList @(('"' + $probeOutput.TrimEnd('\') + '"'), $AutoCloseSeconds.ToString(), $KeyboardTargetPid.ToString()) -WindowStyle Hidden -PassThru
    [pscustomobject]@{ executable = $executablePath; pid = $probeProcess.Id; state = (Join-Path $probeOutput 'probe-state.json'); events = (Join-Path $probeOutput 'raw-events.jsonl'); stopRequest = (Join-Path $probeOutput 'stop.request') } | ConvertTo-Json
} else {
    [pscustomobject]@{ executable = $executablePath; started = $false } | ConvertTo-Json
}
