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

// lib/ 下的 .ts（目前是 textparse.ts，CLI 输出契约层）靠 Node 原生类型剥离直接运行，
// 不经过任何构建，因此需要 Node ≥ 22.18。老版本会以 ERR_UNKNOWN_FILE_EXTENSION 崩掉，
// 这里提前拦住并说清楚该升级到什么版本。其余命令转发给 codegraph，不受影响。
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
const TYPESCRIPT_READY = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 18);

if (args[0] === 'view') {
  if (!TYPESCRIPT_READY) {
    console.error(`[错误] cgv view 需要 Node ≥ 22.18（当前 v${process.versions.node}）：`
      + 'lib/ 下的 .ts 依赖 Node 原生类型剥离，项目刻意不做构建。请升级 Node 后重试。');
    process.exit(1);
  }
  run(process.execPath, [join(ROOT, 'server.mjs'), ...args.slice(1)]);
} else if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
  console.log(`用法: cgv <命令> [参数]

  cgv view [端口] [--json]  启动调用关系可视化（默认 39267）；--json 输出结构化启动信息供脚本解析
  cgv <其他命令>          等同于 codegraph <命令>（init / query / callers / callees / node ...）

查看 codegraph 全部命令: cgv codegraph --help 或 codegraph --help`);
} else if (args[0] === 'codegraph') {
  run(process.execPath, [SHIM, ...args.slice(1)]);
} else {
  run(process.execPath, [SHIM, ...args]);
}
