import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../env.js';
import { SharedDaemon, type Principal } from './daemon.js';
import { withInstallLock } from './maintenance-lock.js';

export interface ServiceConfig {
  schemaVersion: 1; sid: string; windowsSessionId: number; port: number;
  executable: string; manifest: string; principals: Principal[]; environment: NodeJS.ProcessEnv;
  bundleRoot?: string;
  diagnosticsDirectory?: string;
}
export function identity(executable: string): { sid: string; windowsSessionId: number } {
  if (!path.isAbsolute(executable)) throw new Error('absolute_executable_required');
  const value = JSON.parse(execFileSync(executable, ['--identity'], { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 4096 }));
  if (!/^S-1-[0-9-]+$/.test(value.sid) || !Number.isInteger(value.windowsSessionId)) throw new Error('identity_invalid');
  return value;
}
export function pipeForSid(sid: string): string { return `\\\\.\\pipe\\umouse-mcp-${createHash('sha256').update(sid).digest('hex').slice(0, 24)}-v2`; }
async function main(): Promise<void> {
  if (process.argv.length !== 3 || !path.isAbsolute(process.argv[2])) throw new Error('absolute_service_config_required');
  const file = process.argv[2];
  const daemon = await withInstallLock(path.dirname(file), async () => {
  if (fs.existsSync(path.join(path.dirname(file), 'maintenance.json'))) throw new Error('installation_in_maintenance');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8')) as ServiceConfig;
  if (cfg.schemaVersion !== 1 || !path.isAbsolute(cfg.manifest)) throw new Error('config_invalid');
  const actual = identity(cfg.executable);
  if (actual.sid !== cfg.sid || actual.windowsSessionId !== cfg.windowsSessionId) throw new Error('windows_identity_mismatch');
  // Never inherit per-host SDK options: one saved service configuration is authoritative.
  const bridge = loadConfig(cfg.environment);
  const daemon = new SharedDaemon({ port: cfg.port, pipe: pipeForSid(actual.sid), principals: cfg.principals, configFile:file,
    native: { executable: cfg.executable, manifest: cfg.manifest, expectedIdentity: actual, workingDirectory: path.join(bridge.dataDir, 'native'), diagnosticsDirectory: cfg.diagnosticsDirectory }, bridge });
  await daemon.listen();
  return daemon;
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void daemon.close().then(() => process.exit(0)); });
  console.error(`[umouse-shared] listening pid=${process.pid}; SDK starts after MCP initialization`);
}
// Importable identity helpers do not accidentally start a daemon.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(e => { console.error(`[umouse-shared] ${e instanceof Error ? e.message : 'startup_failed'}`); process.exitCode = 1; });
}
