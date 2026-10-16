// 打包构建：tsc 把 bin / lib / server.ts 编译到 dist/，再把 public/ 原样拷进 dist/public/。
//
// 为什么要拷 public：server.ts 用 `new URL('.', import.meta.url)` 定位自己的目录再拼 `public/`，
// 编译后那是 dist/server.js，所以静态资源必须跟着落到 dist/public 才找得到。
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(PKG, 'dist');
const TSC = join(PKG, 'node_modules', 'typescript', 'bin', 'tsc');

rmSync(DIST, { recursive: true, force: true });

// 用 process.execPath 跑 tsc 而不是走 shell，避免 Windows 上 .cmd shim 的引号问题
const tsc = spawnSync(process.execPath, [TSC, '-p', join(PKG, 'tsconfig.build.json')], { stdio: 'inherit' });
if (tsc.status !== 0) process.exit(tsc.status ?? 1);

cpSync(join(PKG, 'public'), join(DIST, 'public'), { recursive: true });

for (const required of [join(DIST, 'server.js'), join(DIST, 'bin', 'cgv.js'), join(DIST, 'public', 'index.html')]) {
  if (!existsSync(required)) {
    console.error(`[build] 产物缺失：${required}`);
    process.exit(1);
  }
}
console.log('[build] dist/ 就绪（tsc 产出 + public/ 已拷入）');
