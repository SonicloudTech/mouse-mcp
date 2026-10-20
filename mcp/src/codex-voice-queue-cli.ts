import fs from 'node:fs';
import path from 'node:path';
import { CodexVoiceQueue, type QueueOptions } from './codex-voice-queue.js';

// Explicit configuration file binds one inbox/owner to one user-authorized conversation.
// No global config edits, auto-discovery, arbitrary command arguments or auto-start at import.
const configPath = process.argv[2];
if (!configPath || !path.isAbsolute(configPath) || fs.statSync(configPath).size > 16384) throw new Error('absolute_config_required');
const value = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (value.schemaVersion !== 1 || value.enabled !== true) throw new Error('queue_binding_disabled');
const options: QueueOptions = { inbox: value.inbox, directory: value.directory, threadId: value.threadId,
  codexPath: value.codexPath, ownerPid: value.ownerPid, includeEventId: value.includeEventId };
const queue = new CodexVoiceQueue(options);
const binding = JSON.stringify(value);
await queue.start();
process.stdout.write(JSON.stringify(queue.status()) + '\n');
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; await queue.stop(); process.exit(0); };
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
// Configuration/lifecycle checks do not call the agent. Disabling is a local off switch.
const timer = setInterval(() => {
  try {
    if (!queue.status().running || fs.statSync(configPath).size > 16384 || JSON.stringify(JSON.parse(fs.readFileSync(configPath, 'utf8'))) !== binding) void stop();
  } catch { void stop(); }
}, 1000);
timer.unref();
