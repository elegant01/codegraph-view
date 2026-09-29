// 全链路展开：从某符号出发 BFS，向下（callees，默认）或向上（callers，影响面分析）
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJson, parseTrail, parseNodeKind, extractSource, isImportRef, warnIfFormatDrift } from './textparse.mjs';

// 剔除类型引用节点（interface/type 非方法调用），只保留可调用的方法链路
const SKIP_KINDS = new Set(['interface', 'type']);

export async function traceChain(ctx, sym, file, { depth, maxNodes, direction = 'down', isCancelled, onProgress } = {}) {
  const { run, root, resolveSourceCalls } = ctx;
  const up = direction === 'up';
  const nodes = [];
  const indexOf = new Map(); // key -> 数组下标（节点唯一 key = filePath::name）
  const edges = [];
  const visited = new Set();
  let truncated = false;
  let cancelled = false;

  const keyOf = (n, f) => (f ? f + '::' : '') + n;
  const addNode = (name, filePath, kind, line) => {
    const k = keyOf(name, filePath);
    if (!indexOf.has(k)) {
      indexOf.set(k, nodes.length);
      nodes.push({ name, filePath, kind, line });
    }
    return indexOf.get(k);
  };

  const rootIdx = addNode(sym, file, null, null);
  visited.add(keyOf(sym, file));
  const queue = [{ idx: rootIdx, name: sym, file, d: 0 }];
  let rootRaw = ''; // 只保留根节点的原始输出（右侧源码用），中间节点的 raw 用完即弃
  let actualDepth = 0;

  // 拉取一个节点的直接邻居（向下=callees，向上=callers）。
  // 带 file 走 node -f 精确消歧，否则退回 callers/callees --json。
  // file 类型节点（如 route.ts）同名不消歧，直接读文件源码做调用解析（仅向下有意义）。
  async function fetchNeighbors(name, filePath) {
    if (!filePath) {
      const cmd = up ? 'callers' : 'callees';
      const raw = await run([cmd, name, '--json', '-l', '40']);
      const list = (parseJson(raw, {})[cmd === 'callers' ? 'callers' : 'callees'] || [])
        .filter(c => c.kind !== 'import' && !isImportRef(c.name));
      return { raw, neighbors: list, kind: null };
    }
    if (/\.min\.(?:js|ts)$/.test(filePath)) {
      // 压缩文件：bundled codegraph 不输出 Trail，且第三方库内部调用无业务价值，留作叶子
      return { raw: '', neighbors: [], kind: null };
    }
    const raw = await run(['node', name, '-f', filePath]);
    warnIfFormatDrift(raw);
    const kind = parseNodeKind(raw);
    if (kind === 'file') {
      if (up) return { raw, neighbors: [], kind }; // 文件节点不向上追溯
      let fileSrc = '';
      try { fileSrc = readFileSync(join(root, filePath), 'utf8'); } catch { /* 文件不可读则仅用 raw */ }
      const neighbors = [];
      await resolveSourceCalls(fileSrc || extractSource(raw), filePath, neighbors);
      return { raw: fileSrc ? '```\n' + fileSrc + '\n```' : raw, neighbors, kind };
    }
    const neighbors = parseTrail(raw, up ? 'Called by ←' : 'Calls →').filter(c => !isImportRef(c.name));
    if (!up) {
      const source = extractSource(raw);
      if (source) await resolveSourceCalls(source, filePath, neighbors);
    }
    return { raw, neighbors, kind };
  }

  const CONCURRENCY = 6;
  while (queue.length) {
    if (isCancelled && isCancelled()) { cancelled = true; break; }
    const batch = queue.splice(0, CONCURRENCY);
    const settled = await Promise.all(batch.map(async (item) => {
      try { return { item, ...(await fetchNeighbors(item.name, item.file)) }; }
      catch (e) { return { item, raw: '', neighbors: [], kind: null, error: String((e && e.message) || e) }; }
    }));
    for (const r of settled) {
      if (r.item.idx === rootIdx) rootRaw = r.raw;
      if (r.kind) nodes[r.item.idx].kind = r.kind;
      // 查询失败（r.error）的节点邻居为空，自然留作叶子，不阻塞链路
      for (const c of r.neighbors || []) {
        const ci = addNode(c.name, c.filePath, c.kind || null, c.startLine);
        // 边方向始终表达「调用 → 被调」：向下时当前节点→邻居；向上时邻居→当前节点
        edges.push(up ? [ci, r.item.idx] : [r.item.idx, ci]);
        actualDepth = Math.max(actualDepth, r.item.d + 1);
        const k = keyOf(c.name, c.filePath);
        if (!visited.has(k) && c.filePath) {
          visited.add(k);
          if (nodes.length > maxNodes) { truncated = true; break; }
          if (r.item.d + 1 >= depth) continue; // 达到深度上限，留作可点击叶子
          queue.push({ idx: ci, name: c.name, file: c.filePath, d: r.item.d + 1 });
        }
      }
    }
    if (nodes.length > maxNodes) { truncated = true; break; }
    if (onProgress) onProgress({ nodes: nodes.length, edges: edges.length });
  }

  const keepIdx = new Map();
  const kept = [];
  nodes.forEach((n, i) => {
    if (SKIP_KINDS.has(n.kind) && i !== rootIdx) return;
    keepIdx.set(i, kept.length);
    kept.push(n);
  });
  const keptEdges = [];
  for (const [a, b] of edges) {
    if (keepIdx.has(a) && keepIdx.has(b) && keepIdx.get(a) !== keepIdx.get(b)) keptEdges.push([keepIdx.get(a), keepIdx.get(b)]);
  }
  return { symbol: sym, file, direction, nodes: kept, edges: keptEdges, source: rootRaw, depth: actualDepth, truncated, cancelled, nodeCount: kept.length };
}
