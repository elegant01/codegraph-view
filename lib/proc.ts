// codegraph 子进程执行器：并发信号量 + 队列上限 + shell 安全
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { assertShellSafe } from './validate.ts';

export interface RunOptions {
  /** 子进程输出缓冲上限（超出即报错），默认 20MB */
  maxBuffer?: number;
  /** 单次执行上限（默认 60s；大项目首次 query 需冷启动 codegraph，30s 常不够） */
  timeout?: number;
  /** 超时后重试次数（默认 0）。冷启动超时重试一次通常即命中已预热的进程 */
  retries?: number;
}

export interface Runner {
  /** 执行一次 codegraph 命令，resolve 出 stdout；失败/超时/超缓冲均 reject */
  run(args: string[], options?: RunOptions): Promise<string>;
  /** 是否用的包内 bundled codegraph（否则走 PATH 里的 codegraph.cmd / codegraph） */
  useBundled: boolean;
}

export interface RunnerOptions {
  /** 项目根（codegraph 索引所在），作为子进程 cwd */
  root: string;
  /** 本包目录（定位 bundled codegraph） */
  pkgDir: string;
  maxConcurrent?: number;
  maxQueue?: number;
}

export function createRunner({ root, pkgDir, maxConcurrent = 8, maxQueue = 64 }: RunnerOptions): Runner {
  const bundled = join(pkgDir, 'node_modules', '@colbymchenry', 'codegraph', 'npm-shim.js');
  const useBundled = existsSync(bundled);
  const bin = process.platform === 'win32' ? 'codegraph.cmd' : 'codegraph';
  const sem = { running: 0, queue: [] as Array<() => void> };

  function run(args: string[], { maxBuffer = 20 * 1024 * 1024, timeout = 60000, retries = 0 }: RunOptions = {}): Promise<string> {
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
          if (sem.queue.length) sem.queue.shift()!();
          if (err) {
            if (err.killed) {
              // 超时重试：直接复用 run（重新走并发信号量），避免排队语义被绕过
              if (retries > 0) return resolve(run(args, { maxBuffer, timeout, retries: retries - 1 }));
              return reject(new Error(`索引查询超时（${Math.round(timeout / 1000)} 秒未返回，命令：${args.join(' ')}）。大项目首次查询较慢，请重试，或点右上角 ⟳ 重新索引。`));
            }
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
