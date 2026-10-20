param([switch]$Test, [string]$SdkInclude)
$ErrorActionPreference = 'Stop'
$taskSource = $PSScriptRoot
$taskBuild = Join-Path $taskSource 'build'
$taskCmake = (Get-Command cmake -ErrorAction Stop).Source
$taskArgs = @('-S', $taskSource, '-B', $taskBuild, '-G', 'Visual Studio 17 2022', '-A', 'x64')
if ($Test) { $taskArgs += '-DUMCP_BUILD_TESTS=ON' } else { $taskArgs += '-DUMCP_BUILD_TESTS=OFF' }
if ($SdkInclude) { $taskArgs += "-DUMCP_UMOUSE_INCLUDE=$SdkInclude" }
& $taskCmake @taskArgs
if ($LASTEXITCODE -ne 0) { throw 'Native configure failed' }
& $taskCmake --build $taskBuild --config Release --parallel 4
if ($LASTEXITCODE -ne 0) { throw 'Native build failed' }
