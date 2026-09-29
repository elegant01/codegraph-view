// codegraph 子进程执行器：并发信号量 + 队列上限 + shell 安全
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { assertShellSafe } from './validate.mjs';

// root: 项目根（codegraph 索引所在）；pkgDir: 本包目录（定位 bundled codegraph）
export function createRunner({ root, pkgDir, maxConcurrent = 8, maxQueue = 64 }) {
  const bundled = join(pkgDir, 'node_modules', '@colbymchenry', 'codegraph', 'npm-shim.js');
  const useBundled = existsSync(bundled);
  const bin = process.platform === 'win32' ? 'codegraph.cmd' : 'codegraph';
  const sem = { running: 0, queue: [] };

  function run(args, { maxBuffer = 20 * 1024 * 1024, timeout = 30000 } = {}) {
    const cmd = useBundled ? process.execPath : bin;
    const cmdArgs = useBundled ? [bundled, ...args] : args;
    // Windows 下 .cmd shim 必须经 shell 执行；Unix / bundled 直接 spawn 更安全
    const shell = !useBundled && process.platform === 'win32';
    if (shell) assertShellSafe(cmdArgs); // 同步抛出，在进入队列前拒绝
    return new Promise((resolve, reject) => {
      if (sem.queue.length >= maxQueue) {
        return reject(new Error('后台查询排队已满，请稍后重试'));
      }
      const execute = () => {
        sem.running++;
        execFile(cmd, cmdArgs, { cwd: root, maxBuffer, windowsHide: true, shell, timeout }, (err, stdout, stderr) => {
          sem.running--;
          if (sem.queue.length) sem.queue.shift()();
          if (err) {
            if (err.killed) return reject(new Error(`codegraph 命令超时（${timeout}ms）：${args.join(' ')}`));
            if (/maxBuffer/i.test(String(err.message))) {
              return reject(new Error(`codegraph 输出超过缓冲上限（${Math.round(maxBuffer / 1048576)}MB）`));
            }
            return reject(new Error((stderr || '').trim() || err.message));
          }
          resolve(stdout);
        });
      };
      if (sem.running >= maxConcurrent) sem.queue.push(execute);
      else execute();
    });
  }

  return { run, useBundled };
}
