import { NativeClient } from '../../dist/shared/native-client.js';
import { once } from 'node:events';
const client = new NativeClient({ executable: process.argv[2], manifest: process.argv[3], testing: true });
const ready = await client.start();
const hanging = once(client, 'event');
void client.request('fake', 'hang', {}).catch(() => {});
await hanging;
process.stdout.write(JSON.stringify({ nativePid: ready.pid }) + '\n');
setInterval(() => {}, 1000);
