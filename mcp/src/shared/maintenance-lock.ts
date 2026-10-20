import net from 'node:net';
import path from 'node:path';
import { createHash } from 'node:crypto';
export async function withInstallLock<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const server = net.createServer(s => s.destroy());
  const key = createHash('sha256').update(path.resolve(directory).toLowerCase()).digest('hex').slice(0, 24);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(`\\\\.\\pipe\\umouse-mcp-maint-${key}`, resolve); });
  try { return await action(); } finally { await new Promise<void>(r => server.close(() => r())); }
}
