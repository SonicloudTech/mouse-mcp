/*
 * takeover.test.mjs —— 旧进程接管单元/行为测试
 *
 * 1. selectOldPids 纯函数：入口路径各形态命中、边界排除（自身 PID、无关进程、
 *    SDK-MCP\dist 这类同尾串路径不误杀）
 * 2. terminateAndWait：用真实临时子进程验证终止与等待退出；已消亡 PID 不计 survivor
 *
 * 注意：本测试不调用 takeoverOldProcesses（它会枚举真实进程列表并终止本机在跑的
 * umouse server，属于运行期副作用——该路径由 smoke 的双服务器检查端到端覆盖）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { selectOldPids, terminateAndWait, selectOlderProcesses, isOurPackage } from '../dist/takeover.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SELF = process.pid;

test('selectOldPids：命中本 server 入口的各路径形态', () => {
  const listing = [
    `101 node D:\\SDK-MCP\\mcp\\dist\\index.js`,
    `102 node D:/SDK-MCP/release/umouse-mcp-win-x64/mcp/dist/index.js`,
    `103 "C:\\Program Files\\nodejs\\node.exe" "D:\\SDK-MCP\\mcp\\dist\\index.js"`,
    `104 /usr/bin/node /opt/umouse/mcp/dist/index.js`,
  ].join('\n');
  assert.deepEqual(selectOldPids(listing, SELF), [101, 102, 103, 104]);
});

test('selectOldPids：排除自身与无关进程；同尾串路径不误杀', () => {
  const listing = [
    `PID COMMAND`,                                   // ps 表头
    `${SELF} node D:\\SDK-MCP\\mcp\\dist\\index.js`, // 自身
    `200 node D:\\SDK-MCP\\mcp\\test\\smoke.mjs`,    // 测试脚本（非入口）
    `201 node D:\\app\\server.js`,                   // 其它 node 进程
    `202 node D:\\SDK-MCP\\dist\\index.js`,          // 无 mcp 段
    '',                                              // 空行
  ].join('\n');
  assert.deepEqual(selectOldPids(listing, SELF), []);
});

test('selectOldPids：入口后带参数仍命中（cwd 换行等杂行忽略）', () => {
  const listing = '300 node D:\\SDK-MCP\\mcp\\dist\\index.js --flag\nsome garbage line';
  assert.deepEqual(selectOldPids(listing, SELF), [300]);
});

test('terminateAndWait：终止真实子进程并等待退出', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  const exit = new Promise((r) => child.once('exit', () => r(true)));
  await new Promise((r) => child.on('spawn', r));
  const { killed, survivors } = await terminateAndWait([child.pid]);
  assert.deepEqual(killed, [child.pid]);
  assert.deepEqual(survivors, []);
  const exited = await exit;
  assert.equal(exited, true);
});

test('terminateAndWait：已消亡 PID 不计 survivor', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await new Promise((r) => child.on('exit', r));
  const { killed, survivors } = await terminateAndWait([child.pid]);
  assert.deepEqual(killed, []);
  assert.deepEqual(survivors, []);
});

test('entry matcher: duplicate separators and relative lexical path', () => {
  assert.deepEqual(selectOldPids('301 node D:\\\\SDK-MCP\\\\mcp\\\\dist\\\\index.js', SELF), [301]);
  assert.deepEqual(selectOldPids('302 node mcp/dist/index.js', SELF), [302]);
});

test('entry matcher: never match suffix, later argument, eval, preload, or non-node', () => {
  for (const command of [
    'node D:/app/mcp/dist/index.js.backup',
    'node "D:/app/mcp/dist/index.js".backup',
    'node D:/worker.js D:/SDK-MCP/mcp/dist/index.js',
    'node -e "console.log(\'D:/SDK-MCP/mcp/dist/index.js\')"',
    'node --require D:/SDK-MCP/mcp/dist/index.js D:/worker.js',
    'python /opt/mcp/dist/index.js',
    'node --check /opt/mcp/dist/index.js',
  ]) assert.deepEqual(selectOldPids('303 '+command, SELF), [], command);
});

test('takeover: never target newer, same-time or unknown-age processes', () => {
  const row = (pid, createdAt) => ({pid, createdAt, command:'node /opt/umouse/mcp/dist/index.js'});
  const rows = [row(100,1000),row(101,900),row(102,1100),row(103,NaN),row(104,1000)];
  assert.deepEqual(selectOlderProcesses(rows,100).map(p=>p.pid),[101]);
  assert.deepEqual(selectOlderProcesses(rows,999),[]);
});

test('takeover: package identity and absolute existing entry required', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'takeover-'));
  try {
    const entry=path.join(dir,'mcp/dist/index.js');
    fs.mkdirSync(path.dirname(entry),{recursive:true}); fs.writeFileSync(entry,'');
    const command='"'+process.execPath+'" "'+entry+'"';
    assert.equal(isOurPackage(command),false);
    fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name:'another-mcp'}));
    assert.equal(isOurPackage(command),false);
    fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name:'umouse-mcp'}));
    assert.equal(isOurPackage(command),true);
    assert.equal(isOurPackage('node mcp/dist/index.js'),false);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
