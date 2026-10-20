import { execFileSync } from 'node:child_process';

let currentSid: string | undefined;
/** Apply only to a freshly created exclusive temporary file, before writing secrets.
 * POSIX callers use open(..., 0600); Windows chmod alone does not set a DACL.
 */
export function protectNewPrivateFile(file: string): void {
  if (process.platform !== 'win32') return;
  if (!currentSid) {
    const identity = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
    const sid = identity.match(/\bS-1-5-(?:\d+-)*\d+\b/gi);
    if (sid?.length !== 1) throw new Error('private_file_identity_unavailable');
    currentSid = sid[0];
  }
  execFileSync('icacls.exe', [file, '/inheritance:r', '/grant:r', `*${currentSid}:F`, '*S-1-5-18:F'],
    { windowsHide: true, stdio: 'pipe', timeout: 3000 });
}
