#!/usr/bin/env node
// cgv 分发器：`cgv view [端口]` 启动可视化；其余命令原样转发给 codegraph
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// 两种布局都要能跑：
//   源码布局（仓库内）：<pkg>/bin/cgv.ts       → 包根是上一级，入口 <pkg>/server.ts
//   编译布局（npm 包）：<pkg>/dist/bin/cgv.js  → 包根是上两级，入口 <pkg>/dist/server.js
// 为什么要编译见 tsconfig.build.json：Node 不对 node_modules 下的 .ts 做类型剥离。
const COMPILED = import.meta.url.endsWith('.js');
const ROOT = fileURLToPath(new URL(COMPILED ? '../../' : '../', import.meta.url)); // 包根（node_modules 所在）
const SHIM = join(ROOT, 'node_modules', '@colbymchenry', 'codegraph', 'npm-shim.js');
const SERVER = COMPILED ? join(ROOT, 'dist', 'server.js') : join(ROOT, 'server.ts');
const args = process.argv.slice(2);

function run(cmd: string, cmdArgs: string[]): void {
  const p = spawn(cmd, cmdArgs, { stdio: 'inherit', windowsHide: true });
  p.on('exit', (code) => process.exit(code ?? 0));
}

// 从源码直接跑时（仓库内布局），lib/ 下的 .ts 依赖 Node 原生类型剥离，需要 Node ≥ 22.18；
// 版本不够会以 ERR_UNKNOWN_FILE_EXTENSION 崩掉，这里提前拦住并说清楚该升级到什么版本。
// 编译布局（npm 包）跑的是 dist/ 下的 .js，没有这个要求，因此不做拦截。
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
const TYPESCRIPT_READY = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 18);

if (args[0] === 'view') {
  if (!COMPILED && !TYPESCRIPT_READY) {
    console.error(`[错误] 从源码运行 cgv view 需要 Node ≥ 22.18（当前 v${process.versions.node}）：`
      + 'lib/ 下的 .ts 依赖 Node 原生类型剥离，项目刻意不做构建。请升级 Node 后重试。');
    process.exit(1);
  }
  run(process.execPath, [SERVER, ...args.slice(1)]);
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
