// 源码级调用解析：codegraph 解析不到动态调用（new X().method / this.repo.method() /
// X::instance()->method() / $svc->method() 等），从源码文本补全「目标类 + 方法」。兼容 TS/JS 与 PHP。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJson } from './textparse.mjs';

// 提取命名空间类名最后一段：`Services\Apis\Group\InfoService` -> `InfoService`
export function lastSeg(full) {
  const p = String(full).split('\\');
  return p[p.length - 1].trim();
}

export function parseSourceCalls(source, filePath, root) {
  const OBJ_RE = /(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?(?:new\s+([A-Z][\w$]*)|([A-Z][\w$]*)\s*\.\s*(?:instance|getInstance|get|create)\s*)\(/g;
  const PHP_OBJ_RE = /\$(\w+)\s*=\s*(?:\\?[A-Z][\w\\]*)\s*::\s*(?:instance|getInstance|get|singleton)\s*\(/g;
  const locals = new Map();
  for (const m of source.matchAll(OBJ_RE)) locals.set(m[1], m[2] || m[3]);
  for (const m of source.matchAll(PHP_OBJ_RE)) {
    const cm = m[0].match(/(?:\\?)([A-Z][\w\\]*)\s*::/);
    if (cm) locals.set('$' + m[1], lastSeg(cm[1]));
  }
  const fields = new Map(); // this.字段名 -> 类名（读整个类文件）
  const uses = new Map(); // PHP use 别名映射：短类名 -> 完整命名空间类名
  let className = null; // 文件主类名（用于同类方法调用 this.xxx() / $this->xxx()）
  if (filePath && root) {
    try {
      const fileSrc = readFileSync(join(root, filePath), 'utf8');
      for (const m of fileSrc.matchAll(/use\s+(\\?[\w\\]+)\s*;/g)) {
        const full = m[1].replace(/^\\/, '').trim();
        uses.set(full.split('\\').pop(), full);
      }
      const ns = fileSrc.match(/namespace\s+([\w\\]+)\s*;/);
      const nsStr = ns ? ns[1].trim() : '';
      const cm = fileSrc.match(/(?:export\s+)?(?:abstract\s+)?class\s+([A-Z][\w$]*)/) || fileSrc.match(/(?:abstract\s+)?class\s+([A-Z][\w$]*)/);
      if (cm) className = nsStr ? nsStr + '\\' + cm[1] : cm[1];
      const FIELD_RE = /(?:private|public|protected|readonly)\s+(\w+)\s*=\s*(?:await\s+)?(?:new\s+([A-Z][\w$]*)|([A-Z][\w$]*)\s*\.\s*(?:instance|getInstance|get|create)\s*)\(/g;
      const THIS_RE = /this\.(\w+)\s*=\s*(?:await\s+)?(?:new\s+([A-Z][\w$]*)|([A-Z][\w$]*)\s*\.\s*(?:instance|getInstance|get|create)\s*)\(/g;
      const PHP_FIELD_RE = /(?:private|public|protected)\s+\$(\w+)\s*=\s*(?:\\?[A-Z][\w\\]*)\s*::\s*(?:instance|getInstance|get|singleton)\s*\(/g;
      for (const m of fileSrc.matchAll(FIELD_RE)) fields.set(m[1], m[2] || m[3]);
      for (const m of fileSrc.matchAll(THIS_RE)) fields.set(m[1], m[2] || m[3]);
      for (const m of fileSrc.matchAll(PHP_FIELD_RE)) {
        const cm2 = m[0].match(/(?:\\?)([A-Z][\w\\]*)\s*::/);
        if (cm2) fields.set('$' + m[1], lastSeg(cm2[1]));
      }
    } catch { /* 文件不可读则跳过字段映射 */ }
  }
  const out = [];
  const push = (cls, method) => {
    if (cls && method) {
      const full = uses.get(cls) || cls;
      if (!out.some(c => c.cls === full && c.method === method)) out.push({ cls: full, method });
    }
  };
  for (const m of source.matchAll(/(this\.)?(\w+)\.(\w+)\s*\(/g)) {
    push(locals.get(m[2]) || (m[1] ? fields.get(m[2]) : null), m[3]);
  }
  for (const m of source.matchAll(/\$(\w+)\s*->\s*(\w+)\s*\(/g)) {
    push(locals.get('$' + m[1]), m[2]);
  }
  // PHP 静态工厂链式：X::instance()->method()
  for (const m of source.matchAll(/(?:\\?[A-Z][\w\\]*)\s*::\s*(?:instance|getInstance|get|singleton)\s*\(\)\s*->\s*(\w+)\s*\(/g)) {
    const cm = m[0].match(/(?:\\?)([A-Z][\w\\]*)\s*::/);
    if (cm) push(lastSeg(cm[1]), m[1]);
  }
  // 同类方法调用：this.xxx() / $this->xxx()（字段/局部变量除外）
  if (className) {
    for (const m of source.matchAll(/this\.(\w+)\s*\(/g)) {
      if (fields.has(m[1]) || locals.has(m[1])) continue;
      push(className, m[1]);
    }
    for (const m of source.matchAll(/\$this\s*->\s*(\w+)\s*\(/g)) {
      if (fields.has('$' + m[1]) || locals.has('$' + m[1])) continue;
      push(className, m[1]);
    }
  }
  return out;
}

// 用 codegraph query 反查 Class::method 符号；LRU 缓存（含失败），reindex 时清空
export function createSymbolResolver({ run, cap = 2000 }) {
  const cache = new Map(); // q -> sym | null（Map 有序，命中时重插到末尾实现 LRU）

  async function resolveSymbol(cls, method) {
    const short = lastSeg(cls);
    const q = cls + '::' + method;
    if (cache.has(q)) {
      const v = cache.get(q);
      cache.delete(q); cache.set(q, v); // LRU 触达
      return v;
    }
    const out = await run(['query', q, '--json', '-l', '10']);
    const list = parseJson(out, []);
    let hit = list.find(r => r.node && r.node.qualifiedName === q);
    if (!hit) hit = list.find(r => r.node && r.node.qualifiedName === q.replace(/\\/g, '::'));
    if (!hit) hit = list.find(r => r.node && r.node.qualifiedName.endsWith('::' + short + '::' + method));
    const sym = hit ? { name: hit.node.name || method, filePath: hit.node.filePath, startLine: hit.node.startLine, kind: hit.node.kind } : null;
    if (cache.size >= cap) cache.delete(cache.keys().next().value); // 淘汰最久未用
    cache.set(q, sym);
    return sym;
  }

  // 并发解析源码动态调用并去重补进 callees；MAX_RESOLVE 限制每节点补全数
  async function resolveSourceCalls(source, filePath, callees, root) {
    const MAX_RESOLVE = 10;
    const resolved = (await Promise.all(
      parseSourceCalls(source, filePath, root).slice(0, MAX_RESOLVE).map(async ({ cls, method }) => {
        try { return await resolveSymbol(cls, method); } catch { return null; }
      })
    )).filter(Boolean);
    for (const sym of resolved) {
      if (!callees.some(c => c.filePath === sym.filePath && c.name === sym.name)) callees.push(sym);
    }
    return callees;
  }

  return { resolveSymbol, resolveSourceCalls, clear: () => cache.clear() };
}
