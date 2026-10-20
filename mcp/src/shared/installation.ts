import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { identity, pipeForSid, type ServiceConfig } from './daemon-main.js';
import { serviceEntry } from './connector.js';
import { launchService } from './service-launch.js';
export { withInstallLock } from './maintenance-lock.js';
const digest = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const read = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));
export function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } finally { try { fs.unlinkSync(tmp); } catch { /* renamed or never created */ } }
}
function newManifestPath(directory: string): string {
  const versions = fs.realpathSync.native(path.join(directory, 'versions'));
  if (fs.readdirSync(versions).filter(name => name.endsWith('.json')).length >= 128)
    throw new Error('manifest_history_limit_archive_unreferenced_versions');
  return path.join(versions, `${randomUUID()}.json`);
}
export function inside(root: string, relative: string): string {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || /[\\:<>"|?*\x00-\x1f]/.test(relative)
    || relative.split('/').some(x => x === '..' || x === '.' || !x || /[. ]$/.test(x) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(x))) throw new Error('bundle_path_invalid');
  const full = path.resolve(root, relative); const rel = path.relative(root, fs.realpathSync(full));
  if (rel.startsWith('..') || path.isAbsolute(rel) || !fs.statSync(full).isFile()) throw new Error('bundle_path_escape');
  return full;
}
export interface Bundle { root: string; executable: string; voiceUi?: string; nativeInputQuarantineVersion?: number; plugins: Array<Record<string, any>> }
export function verifyBundle(root: string): Bundle {
  if (!path.isAbsolute(root)) throw new Error('absolute_bundle_required');
  // MSIX can redirect AppData writes. Persist the physical location so the
  // unpackaged WMI broker and native host see the same files as the installer.
  root = fs.realpathSync.native(root);
  const index = read(path.join(root, 'bundle-index.json'));
  if (index.schemaVersion !== 1 || index.profile !== 'shared-v2' || index.hardwareApiVersion !== 1 || !Array.isArray(index.files) || index.files.length > 20000) throw new Error('bundle_index_invalid');
  if (index.nativeInputQuarantineVersion !== undefined && index.nativeInputQuarantineVersion !== 1) throw new Error('bundle_quarantine_version_unsupported');
  const seen = new Set<string>(), windowsNames = new Set<string>();
  for (const entry of index.files) {
    if (!entry || typeof entry.path !== 'string' || windowsNames.has(entry.path.toLowerCase()) || !/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error('bundle_entry_invalid');
    windowsNames.add(entry.path.toLowerCase()); seen.add(entry.path);
    if (digest(fs.readFileSync(inside(root, entry.path))) !== entry.sha256) throw new Error(`bundle_hash_mismatch:${entry.path}`);
  }
  const checked = (s: string) => { if (!seen.has(s)) throw new Error('bundle_component_not_hashed'); return inside(root, s); };
  if (!Array.isArray(index.plugins) || !index.plugins.some((p: any) => p.id === 'umouse' && p.required)) throw new Error('umouse_plugin_required');
  const ids = new Set();
  const plugins = index.plugins.map((p: any) => {
    if (!['umouse', 'asr', 'typer', 'screen'].includes(p.id) || ids.has(p.id)) throw new Error('plugin_id_invalid'); ids.add(p.id);
    const adapter = checked(p.adapter); const library = p.library ? checked(p.library) : path.join(root, 'lib', `missing-${p.id}.dll`);
    if (p.required && !p.library) throw new Error('required_vendor_missing');
    return { id: p.id, path: adapter, sha256: digest(fs.readFileSync(adapter)), required: !!p.required,
      config: { library, librarySha256: p.library ? digest(fs.readFileSync(library)) : '0'.repeat(64) } };
  });
  if (ids.size !== 4) throw new Error('four_plugin_slots_required');
  checked('mcp/dist/shared/daemon-main.js'); checked('mcp/dist/shared/connector.js'); checked('mcp/dist/shared/manage.js'); checked('mcp/scripts/start-shared.ps1');
  return { root, executable: checked(index.executable), voiceUi: index.voiceUi ? checked(index.voiceUi) : undefined, nativeInputQuarantineVersion: index.nativeInputQuarantineVersion, plugins };
}
export function runtimeManifest(bundle: Bundle, stateDir: string, capabilities: Record<string, Record<string, string>> = {}): object {
  return { schemaVersion: 1, profile: 'production', root: bundle.root,
    plugins: bundle.plugins.map(p => ({ ...p, config: { ...p.config, ...(p.id === 'umouse' ? {
      runtimeStateDir: stateDir, allowHardwareInput: Object.values(capabilities).some(p => p.mouse_control === 'supported' || p.keyboard_control === 'supported'), deviceCapabilities: capabilities,
    } : {}) } })) };
}
export function createInstallation(directory: string, bundle: Bundle, clientId: string): { serviceConfig: string; connectorConfig: string } {
  validateId(clientId);
  if (!path.isAbsolute(directory)) throw new Error('absolute_installation_required');
  const safetyRoot=path.join(os.homedir(),'.umouse-mcp-shared-safety-v2');
  checkNativeQuarantineCompatibility(path.join(safetyRoot, 'native-state'), bundle);
  const who = identity(bundle.executable); fs.mkdirSync(directory);
  directory = fs.realpathSync.native(directory);
  execFileSync('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${who.sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true, stdio: 'pipe' });
  fs.mkdirSync(path.join(directory, 'versions')); fs.mkdirSync(path.join(directory, 'clients'));
  const token = randomBytes(32).toString('base64url'); const admin = { id: '__local_admin', tokenSha256: digest(token), permissions: ['admin'] };
  // All managed installs for this user retain the same safety evidence. A fresh
  // application data directory must not bypass an earlier unknown hardware effect.
  const manifest = newManifestPath(directory);
  writeJson(manifest, runtimeManifest(bundle, path.join(safetyRoot, 'native-state')));
  const cfg: ServiceConfig & { bundleRoot: string; previous?: object } = { schemaVersion: 1, ...who, port: 47192, executable: bundle.executable, manifest, bundleRoot: bundle.root,
    principals: [admin], environment: { UMSDK_DATA_DIR: path.join(directory, 'data'), UMSDK_SHARED_SAFETY_DIR:safetyRoot, UMSDK_VOICE_ENABLED: '1', UMSDK_ASR_PROVIDER: 'windows-speech',
      ...(bundle.voiceUi ? { UMSDK_VOICE_UI_PATH: bundle.voiceUi } : {}) } };
  writeJson(path.join(directory, 'service.json'), cfg); writeJson(path.join(directory, 'admin.json'), { token });
  pairClient(directory, clientId); return { serviceConfig: path.join(directory, 'service.json'), connectorConfig: path.join(directory, 'clients', `${clientId}.json`) };
}
const permissions = ['device.read', 'voice', 'input.control'];
export function validateId(id: string): void { if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id) || /^(service|admin|versions|clients|con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id)) throw new Error('client_id_invalid'); }
export function pairClient(directory: string, id: string, grants?: string[], rotate = false): string {
  validateId(id);
  directory = fs.realpathSync.native(directory);
  const file = path.join(directory, 'service.json'), cfg = read(file) as ServiceConfig;
  const previous = cfg.principals.find(p => p.id.toLowerCase() === id.toLowerCase());
  if(!previous&&cfg.principals.length>=128)throw new Error('client_quota');
  if (previous && (!rotate || previous.id !== id)) throw new Error('client_already_paired');
  if (rotate && !previous) throw new Error('client_not_found');
  grants ??= previous?.permissions ?? permissions;
  if (!grants.length || grants.some(x => !permissions.includes(x))) throw new Error('permission_invalid');
  const token = randomBytes(32).toString('base64url'), clientFile = path.join(directory, 'clients', `${id}.json`);
  fs.mkdirSync(path.dirname(clientFile), { recursive: true });
  // Credentials go first: a crash can leave an unrecognized credential but cannot enable a missing secret.
  writeJson(clientFile, { schemaVersion: 1, pipe: pipeForSid(cfg.sid), serviceConfig: file, token });
  cfg.principals = [...cfg.principals.filter(p => p.id !== id), { id, tokenSha256: digest(token), permissions: grants }]; writeJson(file, cfg); return clientFile;
}
export function revokeClient(directory: string, id: string): void {
  validateId(id); const file = path.join(directory, 'service.json'), cfg = read(file) as ServiceConfig;
  if (!cfg.principals.some(p => p.id === id)) throw new Error('client_not_found');
  cfg.principals = cfg.principals.filter(p => p.id !== id); writeJson(file, cfg);
  const client = path.join(directory, 'clients', `${id}.json`); if (fs.existsSync(client)) fs.renameSync(client, `${client}.revoked-${randomUUID()}`);
}
export async function adminCall(directory: string, operation: string, closeConnections = false): Promise<Record<string, any> | null> {
  const cfg = read(path.join(directory, 'service.json')) as ServiceConfig, credential = read(path.join(directory, 'admin.json'));
  let socket: net.Socket;
  try {
    socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection({ host: '127.0.0.1', port: cfg.port });
      s.once('error', reject); s.setTimeout(2000, () => s.destroy(new Error('admin_connect_timeout'))); s.once('connect', () => resolve(s));
    });
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ECONNREFUSED') return null; throw e; }
  try {
    // Verify the server's Windows identity before sending the administrative bearer.
    const peer = JSON.parse(execFileSync(cfg.executable, ['--tcp-owner', String(socket.localPort), String(socket.remotePort)], { encoding: 'utf8', windowsHide: true, timeout: 2000 }));
    if (peer.sid !== cfg.sid || peer.windowsSessionId !== cfg.windowsSessionId) throw new Error('admin_peer_identity_mismatch');
    socket.setTimeout(0);
    const agent = new http.Agent(); agent.createConnection = () => socket;
    return await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: cfg.port, path: '/admin', method: 'POST', agent,
        headers: { Authorization: `Bearer ${credential.token}`, 'Content-Type': 'application/json' } }, res => {
        let body = ''; res.setEncoding('utf8'); res.on('data', b => { body += b; if (body.length > 65536) req.destroy(new Error('admin_response_limit')); });
        res.on('end', () => { if (res.statusCode !== 200) reject(new Error(`admin_rejected:${res.statusCode}`)); else { try { resolve(JSON.parse(body)); } catch { reject(new Error('admin_response_invalid')); } } });
      }); req.on('error', reject); req.setTimeout(50_000, () => req.destroy(new Error('admin_timeout'))); req.end(JSON.stringify({ operation, closeConnections }));
    });
  } finally { socket.destroy(); }
}
export async function stopForMaintenance(directory: string, closeConnections: boolean): Promise<void> {
  const r = await adminCall(directory, 'quiesce', closeConnections); if (!r) return;
  if (!r.quiesced || r.pid) throw new Error('sdk_not_quiescent');
  await adminCall(directory, 'shutdown');
  for (let i=0;i<100;i++) { await new Promise(r => setTimeout(r,50)); if (!await adminCall(directory, 'status').catch(e => { if (['ECONNRESET','EPIPE'].includes(e.code)) return {}; throw e; })) return; }
  throw new Error('service_still_running');
}
/** Starts only the listener. No MCP initialization, hence N stays zero and no SDK starts. */
export async function startService(directory: string): Promise<object> {
  if (fs.existsSync(path.join(directory, 'maintenance.json'))) throw new Error('installation_in_maintenance');
  const file = path.join(directory, 'service.json'), cfg = read(file) as ServiceConfig;
  const who = identity(cfg.executable);
  if (who.sid !== cfg.sid || who.windowsSessionId !== cfg.windowsSessionId) throw new Error('windows_identity_mismatch');
  const current = await adminCall(directory, 'status'); if (current) return { serviceStarted: false, ...current };
  await launchService(cfg.executable, serviceEntry(cfg), file);
  for(let i=0;i<100;i++) {
    await new Promise(r=>setTimeout(r,100));
    const status=await adminCall(directory,'status'); if(status)return{serviceStarted:true,...status};
  }
  throw new Error('service_start_timeout');
}
function checkNativeQuarantineCompatibility(state: string | undefined, bundle: Bundle): void {
  if (state && fs.existsSync(path.join(state, 'native-input-quarantine.json')) && bundle.nativeInputQuarantineVersion !== 1)
    throw new Error('input_quarantine_requires_compatible_bundle_or_hardware_recovery');
}
function checkInputQuarantineCompatibility(cfg: any, bundle: Bundle): void {
  checkNativeQuarantineCompatibility(read(cfg.manifest).plugins.find((p: any) => p.id === 'umouse')?.config?.runtimeStateDir, bundle);
}
type PrincipalConfig = { id: string; tokenSha256: string; permissions: string[] };
export function migrateInputGrants(grants: string[]): string[] {
  const permitted = grants.includes('cua.read') && grants.includes('cua.input');
  return [...new Set([...grants.filter(g => g !== 'cua.read' && g !== 'cua.input'), ...(permitted ? ['input.control'] : [])])];
}
function hardwareEnvironment(environment: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !key.startsWith('UMSDK_CUA_')));
}
export function upgradeInstallation(directory: string, bundle: Bundle): void {
  const file = path.join(directory, 'service.json'), cfg = read(file);
  checkInputQuarantineCompatibility(cfg, bundle);
  const oldManifest = read(cfg.manifest), oldMouse = oldManifest.plugins.find((p: any) => p.id === 'umouse');
  const capabilities = oldMouse?.config?.deviceCapabilities ?? {};
  const manifest = newManifestPath(directory);
  writeJson(manifest, runtimeManifest(bundle, oldMouse.config.runtimeStateDir, capabilities));
  const previous = { executable: cfg.executable, manifest: cfg.manifest, bundleRoot: cfg.bundleRoot, environment: cfg.environment };
  // One-time migration of old grants; read-only clients never gain input.
  const principals = cfg.principals.map((p: PrincipalConfig) => ({ ...p, permissions: migrateInputGrants(p.permissions) }));
  writeJson(file, { ...cfg, executable: bundle.executable, manifest, bundleRoot: bundle.root, previous, principals,
    environment: { ...hardwareEnvironment(cfg.environment),
      UMSDK_VOICE_UI: bundle.voiceUi ? (cfg.environment.UMSDK_VOICE_UI ?? '1') : '0', UMSDK_VOICE_UI_PATH: bundle.voiceUi ?? '' } });
}
export function rollbackInstallation(directory: string): void {
  const file = path.join(directory, 'service.json'), cfg = read(file); if (!cfg.previous) throw new Error('rollback_unavailable');
  const previousBundle = verifyBundle(cfg.previous.bundleRoot);
  checkInputQuarantineCompatibility(cfg, previousBundle);
  const { previous, ...rest } = cfg; writeJson(file, { ...rest, ...previous, previous: { executable: cfg.executable, manifest: cfg.manifest, bundleRoot: cfg.bundleRoot, environment: cfg.environment } });
}
export function recoverInstallation(directory: string, hardwareResetConfirmed: boolean): object {
  if (!hardwareResetConfirmed) throw new Error('explicit_hardware_reset_confirmation_required');
  const cfg = read(path.join(directory, 'service.json')); const manifest = read(cfg.manifest);
  const state = manifest.plugins.find((p: any) => p.id === 'umouse').config.runtimeStateDir;
  const sdkFile = path.join(state, 'sdk-running.json'), input = path.join(cfg.environment.UMSDK_SHARED_SAFETY_DIR ?? cfg.environment.UMSDK_DATA_DIR, 'shared-v2', 'input-uncertain.json');
  const hash = (p: string) => fs.existsSync(p) ? digest(fs.readFileSync(p)) : 'none';
  const nativeInput = path.join(state, 'native-input-quarantine.json');
  // The native lease rechecks all expected hashes before moving any evidence.
  // Keep the old form only when there is no in-flight marker to recover; a new
  // marker appearing before native admission makes the legacy form fail closed.
  const nativeHash = hash(nativeInput), inflightHash = hash(path.join(state, 'input-in-flight.json'));
  return JSON.parse(execFileSync(cfg.executable, ['--recover-state', cfg.manifest, hash(sdkFile), input, hash(input),
    ...(inflightHash !== 'none' ? [nativeHash, inflightHash] : nativeHash === 'none' ? [] : [nativeHash]),
    '--hardware-reset-confirmed'], { windowsHide: true, encoding: 'utf8', timeout: 5000 }));
}
export function validateCapabilities(profile: unknown): asserts profile is Record<string, Record<string, string>> {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('capability_profile_invalid');
  for (const [id, values] of Object.entries(profile)) {
    if (!id || id.length > 128 || id === '*' || !values || typeof values !== 'object' || Array.isArray(values)) throw new Error('capability_profile_invalid');
    for (const [key, value] of Object.entries(values)) if (!['mouse_control','keyboard_control'].includes(key) || !['supported','unsupported','unknown'].includes(value as string)) throw new Error('capability_profile_invalid');
  }
}
export function setCapabilities(directory: string, profile: unknown): void {
  validateCapabilities(profile);
  const file = path.join(directory, 'service.json'), cfg = read(file), manifest = read(cfg.manifest);
  const mouse = manifest.plugins.find((p: any) => p.id === 'umouse');
  mouse.config.deviceCapabilities = profile; mouse.config.allowHardwareInput = Object.values(profile).some((v: any) => v.mouse_control === 'supported' || v.keyboard_control === 'supported');
  const manifestFile = newManifestPath(directory); writeJson(manifestFile, manifest);
  writeJson(file, { ...cfg, manifest: manifestFile, environment: { ...cfg.environment, UMSDK_DEVICE_CAPS: JSON.stringify(profile) } });
}
