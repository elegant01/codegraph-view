// codegraph CLI 文本输出解析（契约层：CLI 输出格式变化只会影响这里）

// CLI 在无结果/歧义时输出 "ℹ ..." 提示而非 JSON，容错解析
export function parseJson(raw, fallback) {
  try { return JSON.parse(raw); } catch { return fallback; }
}

// 解析 `codegraph node <name> -f <file>` 输出里的 Trail 段：
//   **Calls →** name (file:line), ...
//   **Called by ←** name (file:line), ..., +N more
export function parseTrail(src, label) {
  const m = String(src).match(new RegExp('\\*\\*' + label + '\\*\\* (.+)', 'm'));
  if (!m) return [];
  const out = [];
  for (const e of m[1].matchAll(/([^,()+]+) \(([^()]+):(\d+)\)/g)) {
    out.push({ name: e[1].trim(), kind: null, filePath: e[2], startLine: Number(e[3]) });
  }
  return out;
}

// 从 `codegraph node` 输出首行解析真实 kind：**getList** (method)
export function parseNodeKind(src) {
  const m = String(src).match(/^\*\*\S+\*\* \(([^)]+)\)/m);
  return m ? m[1].trim() : null;
}

// 判断是否为 import 引用（别名/相对路径形式，非可展开的方法调用）
export function isImportRef(name) {
  return /^(@\/|\.\/|\.\.\/|\/|node:)/.test(name);
}

// 从 `codegraph node` 输出提取源码代码块（```typescript ... ```）
export function extractSource(raw) {
  const m = String(raw).match(/```[\w-]*\n([\s\S]*?)```/);
  return m ? m[1] : '';
}

// 输出格式漂移探测：node 命令输出应包含 **name** (kind) / ``` 代码块 / ### 段标题之一。
// codegraph 升版后若三者皆无，大概率是输出格式变了，提醒而不是静默出空图。
export function looksLikeNodeOutput(raw) {
  const s = String(raw);
  return /\*\*\S+\*\* \([^)]+\)/.test(s) || /```[\w-]*\n/.test(s) || /^###\s/m.test(s) || /^\s*ℹ/m.test(s);
}

let driftWarned = false;
export function warnIfFormatDrift(raw, log = console.warn) {
  if (driftWarned) return;
  const s = String(raw || '');
  if (s.trim() && !looksLikeNodeOutput(s)) {
    driftWarned = true;
    log('[警告] codegraph 输出格式无法识别（可能已升级变更），调用图可能不完整。建议锁定/回退 codegraph 版本或更新解析器。');
  }
}

// 模糊匹配：q 的字符按顺序出现在 s 中即命中（忽略大小写），如 "getlst" → getList
export function fuzzyMatch(q, s) {
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
