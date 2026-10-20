param(
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [ValidateRange(30, 7200)][int]$AutoCloseSeconds = 1800,
    [switch]$StartVisible
)
$ErrorActionPreference = 'Stop'
$fixtureOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $fixtureOutput | Out-Null
$compilerPath = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compilerPath)) { throw 'The .NET Framework 4 x64 C# compiler was not found.' }
$sourcePath = Join-Path $PSScriptRoot 'input-surface.cs'
$manifestPath = Join-Path $PSScriptRoot 'input-surface.manifest'
$executablePath = Join-Path $fixtureOutput 'input-surface.exe'
& $compilerPath /nologo /target:winexe /platform:x64 "/out:$executablePath" "/win32manifest:$manifestPath" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll $sourcePath
if ($LASTEXITCODE -ne 0) { throw "Fixture compilation failed: $LASTEXITCODE" }
if ($StartVisible) {
    if ((Test-Path -LiteralPath (Join-Path $fixtureOutput 'events.jsonl')) -or (Test-Path -LiteralPath (Join-Path $fixtureOutput 'state.json'))) {
        throw 'Use a fresh evidence directory for a new fixture run.'
    }
    # An explicit visible launch is intentional: this is the target of a user-authorized
    # real desktop acceptance. Without -StartVisible the script only compiles.
    $fixtureProcess = Start-Process -FilePath $executablePath -ArgumentList @(('"' + $fixtureOutput.TrimEnd('\') + '"'), $AutoCloseSeconds.ToString()) -WindowStyle Normal -PassThru
    [pscustomobject]@{ executable = $executablePath; pid = $fixtureProcess.Id; state = (Join-Path $fixtureOutput 'state.json'); events = (Join-Path $fixtureOutput 'events.jsonl') } | ConvertTo-Json
} else {
    [pscustomobject]@{ executable = $executablePath; started = $false } | ConvertTo-Json
}
