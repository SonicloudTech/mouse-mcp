'use strict';

// Packaging adapter only: the bundled legacy runtime remains unchanged.
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

if (process.platform !== 'win32' || process.arch !== 'x64') {
  console.error('[umouse-mcp] This MCPB requires Windows and an x64 Node.js runtime.');
  process.exit(1);
}

if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error('[umouse-mcp] This MCPB requires Node.js 22 or later.');
  process.exit(1);
}

if (!process.env.UMSDK_DATA_DIR?.trim()) {
  process.env.UMSDK_DATA_DIR = path.join(os.homedir(), '.umouse-mcp-mcpb');
}
const asrProvider = process.env.UMSDK_ASR_PROVIDER?.trim().toLowerCase() || 'disabled';
if (!['disabled', 'windows-speech'].includes(asrProvider)) {
  console.error('[umouse-mcp] Valid UMSDK_ASR_PROVIDER values for this MCPB are disabled and windows-speech.');
  process.exit(1);
}
process.env.UMSDK_ASR_PROVIDER = asrProvider;
if (!process.env.UMSDK_TAKEOVER?.trim()) {
  process.env.UMSDK_TAKEOVER = '0';
}

import(pathToFileURL(path.join(__dirname, 'mcp', 'dist', 'index.js')).href).catch(() => {
  console.error('[umouse-mcp] Could not load the bundled legacy runtime. Check the installed bundle and runtime requirements.');
  process.exitCode = 1;
});
