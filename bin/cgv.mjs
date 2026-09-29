#!/usr/bin/env node
// cgv 分发器：`cgv view [端口]` 启动可视化；其余命令原样转发给 codegraph
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHIM = join(ROOT, 'node_modules', '@colbymchenry', 'codegraph', 'npm-shim.js');
const args = process.argv.slice(2);

function run(cmd, cmdArgs) {
  const p = spawn(cmd, cmdArgs, { stdio: 'inherit', windowsHide: true });
  p.on('exit', (code) => process.exit(code ?? 0));
}

if (args[0] === 'view') {
  run(process.execPath, [join(ROOT, 'server.mjs'), ...args.slice(1)]);
} else if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
  console.log(`用法: cgv <命令> [参数]

  cgv view [端口]        启动调用关系可视化（默认 39267，浏览器打开 http://localhost:端口）
  cgv <其他命令>          等同于 codegraph <命令>（init / query / callers / callees / node ...）

查看 codegraph 全部命令: cgv codegraph --help 或 codegraph --help`);
} else if (args[0] === 'codegraph') {
  run(process.execPath, [SHIM, ...args.slice(1)]);
} else {
  run(process.execPath, [SHIM, ...args]);
}
