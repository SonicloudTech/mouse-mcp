import { createInterface } from 'node:readline';
// 浮窗 stub：读 stdin 行协议，收到 U 即回 F（完成按钮模拟）；stdin 关闭退出
const rl = createInterface({ input: process.stdin });
rl.on('line', (l) => { const p = l.split('\t'); if (p[0] === 'U') process.stdout.write('F\t' + p[1] + '\n'); });
rl.on('close', () => process.exit(0));
