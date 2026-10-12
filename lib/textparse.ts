// codegraph CLI 文本输出解析（契约层：CLI 输出格式变化只会影响这里）
//
// 为什么这个文件是 .ts：它是「外部 CLI 输出 → 内部结构」的唯一转换点，契约类型定义在这里，
// 下游 server.mjs / trace.mjs / routes.mjs / sourcecalls.mjs 就能被 checkJs 校验到字段名与形状。
// 运行时不需要任何构建：Node ≥22.18 原生剥离类型后直接执行（只允许可擦除语法，见 tsconfig 的
// erasableSyntaxOnly）。其余 .mjs 直接 `import './textparse.ts'` 即可，见 README「为什么是 .ts」。

/** codegraph 索引里的一个符号节点（`query` / `callers` / `callees --json` 的元素形状） */
export interface SymbolNode {
  name: string;
  /** method / function / class / interface / type / property / variable / route / file */
  kind?: string | null;
  filePath?: string;
  startLine?: number | null;
  qualifiedName?: string | null;
}

/** Trail 段里的一条调用关系：`**Calls →** name (file:line)` */
export interface TrailEntry {
  name: string;
  /** Trail 文本本身不含 kind，解析结果固定为 null；需要 kind 时另用 --json 结果回填 */
  kind: string | null;
  filePath: string;
  startLine: number;
}

/** `codegraph query <q> --json` 的一行：符号包在 node 字段里 */
export interface QueryRow {
  node?: SymbolNode;
}

/** `codegraph callers/callees --json` 的返回结构 */
export interface NeighborsPayload {
  symbol?: string;
  callers?: SymbolNode[];
  callees?: SymbolNode[];
}

// CLI 在无结果/歧义时输出 "ℹ ..." 提示而非 JSON，容错解析。
// 返回 any 是有意的：这是不可信的 CLI 边界，调用方各自按需窄化；
// 想收紧时可改成 unknown 并为每种 --json 形状提供专用解析函数（见 NeighborsPayload）。
export function parseJson(raw: unknown, fallback: any): any {
  try { return JSON.parse(String(raw)); } catch { return fallback; }
}

// 解析 `codegraph node <name> -f <file>` 输出里的 Trail 段：
//   **Calls →** name (file:line), ...
//   **Called by ←** name (file:line), ..., +N more
export function parseTrail(src: unknown, label: string): TrailEntry[] {
  const m = String(src).match(new RegExp('\\*\\*' + label + '\\*\\* (.+)', 'm'));
  if (!m) return [];
  const out: TrailEntry[] = [];
  for (const e of m[1].matchAll(/([^,()+]+) \(([^()]+):(\d+)\)/g)) {
    out.push({ name: e[1].trim(), kind: null, filePath: e[2], startLine: Number(e[3]) });
  }
  return out;
}

// 从 `codegraph node` 输出首行解析真实 kind：**getList** (method)
export function parseNodeKind(src: unknown): string | null {
  const m = String(src).match(/^\*\*\S+\*\* \(([^)]+)\)/m);
  return m ? m[1].trim() : null;
}

// 判断是否为 import 引用（别名/相对路径形式，非可展开的方法调用）
export function isImportRef(name: string): boolean {
  return /^(@\/|\.\/|\.\.\/|\/|node:)/.test(name);
}

// 从 `codegraph node` 输出提取源码代码块（```typescript ... ```）
export function extractSource(raw: unknown): string {
  const m = String(raw).match(/```[\w-]*\n([\s\S]*?)```/);
  return m ? m[1] : '';
}

// 输出格式漂移探测：node 命令输出应包含 **name** (kind) / ``` 代码块 / ### 段标题之一。
// codegraph 升版后若三者皆无，大概率是输出格式变了，提醒而不是静默出空图。
export function looksLikeNodeOutput(raw: unknown): boolean {
  const s = String(raw);
  return /\*\*\S+\*\* \([^)]+\)/.test(s) || /```[\w-]*\n/.test(s) || /^###\s/m.test(s) || /^\s*ℹ/m.test(s);
}

let driftWarned = false;
export function warnIfFormatDrift(raw: unknown, log: (msg: string) => void = console.warn): void {
  if (driftWarned) return;
  const s = String(raw || '');
  if (s.trim() && !looksLikeNodeOutput(s)) {
    driftWarned = true;
    log('[警告] codegraph 输出格式无法识别（可能已升级变更），调用图可能不完整。建议锁定/回退 codegraph 版本或更新解析器。');
  }
}

// 模糊匹配：q 的字符按顺序出现在 s 中即命中（忽略大小写），如 "getlst" → getList
export function fuzzyMatch(q: string, s: string): boolean {
  if (!q || !s) return false;
  const ql = q.toLowerCase();
  const sl = s.toLowerCase();
  if (sl.includes(ql)) return true;
  let i = 0;
  for (const ch of sl) {
    if (ch === ql[i]) i++;
    if (i >= ql.length) return true;
  }
  return false;
}
