import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
/** Broker the supervisor outside an Agent's kill-on-close Job; never silently fall back to an inherited child. */
export async function launchService(executable: string, daemonScript: string, serviceConfig: string): Promise<number> {
  if (![executable,daemonScript,serviceConfig].every(path.isAbsolute)) throw new Error('absolute_service_files_required');
  // Resolve MSIX file-system redirection before crossing into unpackaged WMI.
  // Keep the existing user-only ACL and Job ownership; do not fall back to a
  // child process that inherits the Agent's lifetime.
  [executable, daemonScript, serviceConfig] = [executable, daemonScript, serviceConfig].map(p => fs.realpathSync.native(p));
  const script=fs.realpathSync.native(fileURLToPath(new URL('../../scripts/start-shared.ps1',import.meta.url)));
  const {stdout}=await promisify(execFile)('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',script,
    '-Executable',executable,'-NodeExecutable',fs.realpathSync.native(process.execPath),'-DaemonScript',daemonScript,'-ServiceConfig',serviceConfig],
    {windowsHide:true,encoding:'utf8',timeout:10000,maxBuffer:8192});
  const result=JSON.parse(stdout.replace(/^\uFEFF/,''));
  if(result.broker!=='local-wmi'||!Number.isSafeInteger(result.launcherPid)||result.launcherPid<1)throw new Error('service_broker_invalid');
  return result.launcherPid;
}
