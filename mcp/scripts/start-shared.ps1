param(
  [Parameter(Mandatory=$true)][string]$Executable,
  [Parameter(Mandatory=$true)][string]$NodeExecutable,
  [Parameter(Mandatory=$true)][string]$DaemonScript,
  [Parameter(Mandatory=$true)][string]$ServiceConfig
)
$ErrorActionPreference = 'Stop'
# Local WMI process creation is not inherited into the calling Agent's Job.
# No scheduled task, login autostart, elevation, credentials or hardware initialization.
function Quote-NativeArgument([string]$Value) {
  '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}
foreach ($taskPath in @($Executable,$NodeExecutable,$DaemonScript,$ServiceConfig)) {
  if (-not [System.IO.Path]::IsPathRooted($taskPath) -or -not (Test-Path -LiteralPath $taskPath -PathType Leaf)) { throw 'absolute_service_files_required' }
}
$taskCommand = (@($Executable,'--service-run',$NodeExecutable,$DaemonScript,$ServiceConfig) | ForEach-Object { Quote-NativeArgument $_ }) -join ' '
$taskStartup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{
  ShowWindow=[uint16]0; CreateFlags=[uint32]0x01000000; WinstationDesktop='WinSta0\Default'
}
$taskCreated = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine=$taskCommand; CurrentDirectory=[System.IO.Path]::GetDirectoryName($ServiceConfig); ProcessStartupInformation=$taskStartup
}
if ($taskCreated.ReturnValue -ne 0 -or $taskCreated.ProcessId -lt 1) { throw ('service_broker_failed:' + $taskCreated.ReturnValue) }
@{launcherPid=[int]$taskCreated.ProcessId; broker='local-wmi'; sdkInitialized=$false} | ConvertTo-Json -Compress
