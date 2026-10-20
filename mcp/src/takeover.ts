/*
 * Startup takeover: exact Node entry argument + umouse-mcp package identity +
 * strictly older creation time. Recheck identity before terminating.
 * Relative entry paths and ambiguous command lines are skipped conservatively.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
const execFileP = promisify(execFile);

export interface TakeoverState {
  enabled: boolean; at?: number; found: number[]; killed: number[];
  survivors: number[]; note?: string;
}
export const takeoverState: TakeoverState = { enabled: false, found: [], killed: [], survivors: [] };
export interface ProcessInfo { pid: number; command: string; createdAt: number; }
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** Only accept Node's entry argument, never a substring of an argument or eval source. */
export function entryFromCommand(command: string): string | undefined {
  const tokens: string[] = [];
  const re = /\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))/gy;
  let offset = 0;
  while (offset < command.length) {
    if (offset > 0 && !/\s/.test(command[offset])) return;
    re.lastIndex = offset;
    const m = re.exec(command);
    if (!m) { if (command.slice(offset).trim()) return; break; }
    tokens.push(m[1] ?? m[2] ?? m[3]);
    offset = re.lastIndex;
  }
  if (!/^(?:.*[\\/])?node(?:\.exe)?$/i.test(tokens.shift() ?? '')) return;
  while (tokens[0] && ['--no-warnings', '--enable-source-maps'].includes(tokens[0])) tokens.shift();
  if (tokens[0] === '--') tokens.shift();
  const entry = tokens[0];
  if (!entry || entry.startsWith('-')) return;
  const normalized = entry.replace(/[\\/]+/g, '/');
  return /(?:^|\/)mcp\/dist\/index\.js$/i.test(normalized) ? entry : undefined;
}

/** Pure matching helper; runtime adds package ownership and creation-time checks. */
export function selectOldPids(listing: string, selfPid: number): number[] {
  const out: number[] = [];
  for (const raw of String(listing ?? '').split(/\r?\n/)) {
    const m = raw.trim().match(/^(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === selfPid) continue;
    if (entryFromCommand(m[2]) && !out.includes(pid)) out.push(pid);
  }
  return out;
}

/** Unknown/same timestamp instances must not terminate each other. */
export function selectOlderProcesses(rows: ProcessInfo[], selfPid: number): ProcessInfo[] {
  const self = rows.find(p => p.pid === selfPid);
  if (!self || !Number.isFinite(self.createdAt)) return [];
  return rows.filter(p => Number.isSafeInteger(p.pid) && p.pid > 0 && p.pid !== selfPid
    && Number.isFinite(p.createdAt) && p.createdAt < self.createdAt && !!entryFromCommand(p.command));
}

async function listProcesses(): Promise<ProcessInfo[]> {
  if (process.platform === 'win32') {
    const script =
      'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" -ErrorAction Stop | ' +
      'Where-Object { $_.CommandLine } | Select-Object ProcessId,CommandLine,' +
      '@{Name="CreatedAt";Expression={$_.CreationDate.ToUniversalTime().ToString("o")}} | ConvertTo-Json -Compress';
    const { stdout } = await execFileP('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 20000, windowsHide: true });
    if (!stdout.trim()) return [];
    const parsed = JSON.parse(stdout);
    return (Array.isArray(parsed) ? parsed : [parsed])
      .filter(r => typeof r?.ProcessId === 'number' && typeof r.CommandLine === 'string'
        && typeof r.CreatedAt === 'string')
      .map(r => ({ pid: r.ProcessId, command: r.CommandLine, createdAt: Date.parse(r.CreatedAt) }));
  }
  const { stdout } = await execFileP('ps', ['-Ao', 'pid=,lstart=,command='],
    { timeout: 20000, env: { ...process.env, LC_ALL: 'C' } });
  return stdout.split(/\r?\n/).flatMap(line => {
    const m = line.trim().match(/^(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+)$/);
    return m ? [{ pid: Number(m[1]), createdAt: Date.parse(m[2]), command: m[3] }] : [];
  });
}

export function isOurPackage(command: string): boolean {
  const entry = entryFromCommand(command);
  // The other process's cwd is unknown; do not resolve relative paths using ours.
  if (!entry || !path.isAbsolute(entry)) return false;
  try {
    const script = fs.realpathSync(entry);
    const pkg = JSON.parse(fs.readFileSync(path.resolve(path.dirname(script), '../../package.json'), 'utf8'));
    return pkg.name === 'umouse-mcp';
  } catch { return false; }
}

/** SIGKILL on Windows, SIGTERM on POSIX. Only callers' verified PIDs or test children. */
export async function terminateAndWait(pids: number[], waitMs = 5000):
  Promise<{ killed: number[]; survivors: number[] }> {
  const killed: number[] = [], survivors: number[] = [];
  for (const pid of new Set(pids)) {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) continue;
    try {
      process.kill(pid, process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM');
      killed.push(pid);
    } catch {
      try { process.kill(pid, 0); survivors.push(pid); }
      catch (e) {
        // EPERM means potentially alive, not evidence of exit.
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') survivors.push(pid);
      }
    }
  }
  const deadline = Date.now() + waitMs, alive = new Set(killed);
  while (alive.size && Date.now() < deadline) {
    for (const pid of [...alive]) {
      try { process.kill(pid, 0); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') alive.delete(pid); }
    }
    if (alive.size) await sleep(100);
  }
  return { killed, survivors: [...survivors, ...alive] };
}

export async function takeoverOldProcesses(selfPid = process.pid): Promise<TakeoverState> {
  Object.assign(takeoverState, { at: Date.now(), found: [], killed: [], survivors: [] });
  delete takeoverState.note;
  let rows: ProcessInfo[];
  try { rows = await listProcesses(); }
  catch (e) {
    takeoverState.note = '进程枚举失败，跳过接管（' + (e instanceof Error ? e.message : e) + '）';
    return takeoverState;
  }
  if (!rows.some(p => p.pid === selfPid && Number.isFinite(p.createdAt))) {
    takeoverState.note = '无法确认本实例创建时间，跳过接管';
    return takeoverState;
  }
  const candidates = selectOlderProcesses(rows, selfPid).filter(p => isOurPackage(p.command));
  takeoverState.found = candidates.map(p => p.pid);
  if (!candidates.length) return takeoverState;
  let fresh: ProcessInfo[];
  try { fresh = await listProcesses(); }
  catch { takeoverState.note = '终止前无法复核进程身份，跳过接管'; return takeoverState; }
  const verified = candidates.filter(p => fresh.some(q => q.pid === p.pid
    && q.command === p.command && q.createdAt === p.createdAt) && isOurPackage(p.command));
  const r = await terminateAndWait(verified.map(p => p.pid));
  takeoverState.killed = r.killed;
  takeoverState.survivors = r.survivors;
  return takeoverState;
}
