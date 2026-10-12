// 输入校验与数值钳制
import { normalize } from 'node:path';

// 文件路径校验：拒绝控制字符、盘符绝对路径、/ 开头、.. 穿越。
// 返回归一化后的相对路径（统一成 / 分隔），非法则 null。
export function safeFile(file: unknown): string | null {
  if (!file || typeof file !== 'string') return null;
  if (/[\x00-\x1f]/.test(file)) return null;
  const normalized = normalize(file).replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(normalized)) return null;
  if (normalized.startsWith('/') || normalized.startsWith('..') || normalized.includes('/../')) return null;
  return normalized;
}

// 通用参数校验：拒绝全部控制字符（含 \t \n \r，防止日志/协议注入），限长
export function safeArg(s: unknown, maxLen = 200): string | null {
  if (!s || typeof s !== 'string') return null;
  if (/[\x00-\x1f]/.test(s)) return null;
  const trimmed = s.trim();
  if (!trimmed || trimmed.length > maxLen) return null;
  return trimmed;
}

// Windows cmd.exe 元字符：仅在 shell:true 路径（PATH 里的 codegraph.cmd）使用。
// bundled shim / Unix 直接 spawn，无需此校验。
// 注意：symbol/query 参数不会包含这些字符；URL 参数不会传给 CLI，不受影响。
const SHELL_META = /[&|<>^"%!'`$;\r\n\t]/;
export function assertShellSafe(args: readonly unknown[]): void {
  for (const a of args) {
    const s = String(a);
    if (SHELL_META.test(s)) {
      throw new Error('参数含 shell 元字符，已拒绝执行：' + JSON.stringify(s.slice(0, 60)));
    }
  }
}

// 把任意输入钳到 [min, max] 内的整数；非法/缺失时取默认值
export function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
