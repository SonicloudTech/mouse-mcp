// uMouse Mouse Capability Lab — 本地事件/目标/状态服务（零依赖）。
// 用法: node lab-server.mjs [port]   默认 8123
// 页面会把鼠标事件与目标物理坐标上报到这里，测试脚本通过 /api/* 读取做闭环验证。
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const port = parseInt(process.argv[2] || process.env.PORT || '8123', 10);
const page = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'lab-page.html'));
let events = [];   // { seq, type, zone, ts, screenPhys, data }
let targets = null; // { zones:[{id,x,y,w,h}], calib }
let latest = null;  // 页面最新状态快照
let seqAll = 0;

const send = (res, code, body, type = 'application/json') => {
  const buf = Buffer.isBuffer(body) ? body : typeof body === 'string' ? Buffer.from(body) : Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
};
const readBody = req => new Promise(resolve => {
  let data = '';
  req.on('data', c => { data += c; if (data.length > 1 << 20) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
});

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  console.log(JSON.stringify({ req: req.method + ' ' + req.pathname0 || req.url, ua: (req.headers['user-agent'] || '').slice(0, 40) }));
  try {
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, page, 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/targets') return send(res, 200, { targets, events: events.length });
    if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, { latest, targets, events: events.length });
    if (req.method === 'GET' && url.pathname === '/api/events') {
      const since = parseInt(url.searchParams.get('since') || '0', 10);
      return send(res, 200, { events: events.filter(e => e.seq > since), last: seqAll });
    }
    if (req.method === 'POST' && url.pathname === '/api/event') {
      const { event, state } = await readBody(req);
      if (event) { event.seq = ++seqAll; events.push(event); if (events.length > 3000) events.splice(0, 1000); }
      if (state) latest = state;
      return send(res, 200, { ok: true, seq: seqAll });
    }
    if (req.method === 'POST' && url.pathname === '/api/targets') { const b = await readBody(req); targets = b; return send(res, 200, { ok: true }); }
    if (req.method === 'POST' && url.pathname === '/api/hello') { const b = await readBody(req); return send(res, 200, { ok: true, got: b.calib }); }
    if (req.method === 'POST' && url.pathname === '/api/reset') { events = []; latest = null; seqAll = 0; return send(res, 200, { ok: true }); }
    send(res, 404, { error: 'not_found' });
  } catch (e) { send(res, 500, { error: String(e && e.message || e) }); }
}).listen(port, '127.0.0.1', () => console.log(JSON.stringify({ lab: 'mouse-capability', url: `http://127.0.0.1:${port}/`, pid: process.pid })));
