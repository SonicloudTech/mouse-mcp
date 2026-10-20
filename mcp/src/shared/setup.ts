import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { identity, pipeForSid, type ServiceConfig } from './daemon-main.js';
import { validateId } from './installation.js';

/** Explicit local pairing utility. Never edits an Agent's existing MCP configuration. */
console.error('[umouse-shared] legacy preview setup: new installations should use manage init with a verified shared-v2 bundle; this entry does not provide managed upgrade/recovery.');
const [directory, executable, manifest, principalId] = process.argv.slice(2);
validateId(principalId ?? '');
if (!directory || !executable || !manifest || !/^[a-zA-Z0-9_-]{1,64}$/.test(principalId ?? '') || ![directory, executable, manifest].every(path.isAbsolute)) {
  throw new Error('Usage: setup <absolute-directory> <absolute-sdk-host.exe> <absolute-manifest.json> <client-id>');
}
const who = identity(executable);
// Create only a new installation directory, so applying an ACL cannot accidentally change another tree.
fs.mkdirSync(directory, { recursive: false });
try {
  execFileSync('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${who.sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true, stdio: 'pipe' });
  const token = randomBytes(32).toString('base64url');
  const serviceFile = path.join(directory, 'service.json');
  const config: ServiceConfig = { schemaVersion: 1, ...who, port: 47192, executable, manifest,
    principals: [{ id: principalId, tokenSha256: createHash('sha256').update(token).digest('hex'), permissions: ['device.read', 'voice'] }],
    environment: { UMSDK_DATA_DIR: path.join(directory, 'data'), UMSDK_VOICE_ENABLED: '1', UMSDK_ASR_PROVIDER: 'windows-speech' } };
  fs.writeFileSync(serviceFile, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
  const clientFile = path.join(directory, `${principalId}.json`);
  fs.writeFileSync(clientFile, JSON.stringify({ schemaVersion: 1, pipe: pipeForSid(who.sid), serviceConfig: serviceFile, token }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ serviceConfig: serviceFile, connectorConfig: clientFile, credentialsPrinted: false, serviceStarted: false }));
} catch {
  // Retain the failed directory for diagnosis; never start with unverified permissions.
  throw new Error('setup_failed_no_service_started');
}
