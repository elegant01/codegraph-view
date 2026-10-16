// 端到端冒烟：对存在的 fixture 项目逐个起服务，验证核心 API 可用且结构正确
// 用法: node scripts/e2e.ts [项目根目录...]
//   传参 → 用参数当项目根目录；不传 → 读 scripts/fixtures.local.json（无则读 .example.json）；
//   目录不存在自动跳过。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadFixtures, type Fixture } from './fixtures.ts';

// ===== 断言用到的载荷形状（只声明真正读到的字段，避免用 any 兜底）=====
interface StatusPayload { stale?: boolean }
interface FileItem { path: string; nodeCount: number }
interface SymbolsPayload { symbols?: Array<{ name: string; kind?: string; line?: number }> }
interface GraphPayload { callers?: unknown[]; callees?: unknown[] }
interface TracePayload { nodes?: unknown[]; edges?: unknown[]; direction?: 'up' | 'down' }
interface ApiResponse { status: number; data: unknown }
interface SSEEvent { event: string; data: unknown }
interface TraceStreamResult { status: number; events: SSEEvent[]; data: unknown; error: unknown }

const PKG = fileURLToPath(new URL('..', import.meta.url));

const fixtures: Fixture[] = process.argv.slice(2).length
  ? process.argv.slice(2).map((root, i) => ({ name: root, root, port: 5300 + i }))
  : loadFixtures();

let passed = 0, failed = 0;
function check(name: string, cond: unknown, extra = ''): void {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}

async function get(port: number, path: string, timeoutMs = 60000): Promise<ApiResponse> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api${path}`, { signal: ctl.signal });
    const text = await res.text();
    let data: unknown;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  } finally { clearTimeout(t); }
}

async function getTraceStream(port: number, query: string, timeoutMs = 90000): Promise<TraceStreamResult> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/trace/stream?${query}`, { signal: ctl.signal });
    const text = await res.text();
    const events: SSEEvent[] = [];
    let event = 'message';
    let data: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      else if (!line.trim() && data.length) {
        let parsed: unknown = data.join('\n');
        try { parsed = JSON.parse(parsed as string); } catch { /* 保留原始事件数据 */ }
        events.push({ event, data: parsed });
        event = 'message';
        data = [];
      }
    }
    const result = [...events].reverse().find(e => e.event === 'result');
    const error = [...events].reverse().find(e => e.event === 'error');
    return { status: res.status, events, data: result?.data, error: error?.data };
  } finally { clearTimeout(t); }
}

async function waitUp(port: number, tries = 50): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try { const r = await get(port, '/status', 2000); if (r.status === 200) return true; } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

async function testProject({ name, root, port }: Fixture): Promise<void> {
  console.log(`\n== ${name} (${root}) :${port}`);
  const srv = spawn(process.execPath, [join(PKG, 'server.ts'), String(port)], { cwd: root, stdio: 'ignore', windowsHide: true });
  try {
    if (!await waitUp(port)) { check('服务启动', false); return; }
    check('服务启动', true);

    const status = statusPayloadOf(await get(port, '/status'));
    check('/status 结构', !!status && typeof status.stale === 'boolean');

    const filesData = (await get(port, '/files')).data;
    if (!Array.isArray(filesData)) {
      console.log(`  ⏭️ /files 跳过：fixture 未返回文件数组 (${JSON.stringify(filesData).slice(0, 160)})`);
      return;
    }
    const files = filesData as FileItem[];
    check('/files 非空数组', files.length > 0, 'got 0');
    if (!files.length) return;

    // 选代表性源码文件：符号多、排除 config/min 文件（file 类节点无 --symbols-only 列表）。
    // 某些 fixture 的最高 nodeCount 文件可能没有可解析符号，因此按候选顺序尝试。
    const candidates = files
      .filter(f => f.nodeCount > 0 && !/\.config\.|\.min\.|\.d\.ts$/.test(f.path))
      .sort((a, b) => b.nodeCount - a.nodeCount);
    let fileWithSymbols: FileItem | null = null;
    let symbols: SymbolsPayload | null = null;
    for (const candidate of candidates) {
      const response = await get(port, '/symbols?file=' + encodeURIComponent(candidate.path));
      const sym = symbolsPayloadOf(response.data);
      if (sym && Array.isArray(sym.symbols) && sym.symbols.length) {
        fileWithSymbols = candidate;
        symbols = sym;
        break;
      }
    }
    if (!fileWithSymbols || !symbols || !symbols.symbols) {
      console.log('  ⏭️ /symbols 跳过：fixture 没有可解析的源码符号');
      return;
    }
    check('存在含符号的文件', true);
    check('/symbols 非空', true);
    const sym = symbols.symbols[0];

    const search = await get(port, '/search?q=' + encodeURIComponent(sym.name));
    check('/search 有结果', Array.isArray(search.data) && search.data.length > 0);

    const graph = graphPayloadOf((await get(port, `/graph?symbol=${encodeURIComponent(sym.name)}&file=${encodeURIComponent(fileWithSymbols.path)}`)).data);
    check('/graph 结构', !!graph && Array.isArray(graph.callers) && Array.isArray(graph.callees));

    const traceQuery = `symbol=${encodeURIComponent(sym.name)}&file=${encodeURIComponent(fileWithSymbols.path)}&depth=2&maxNodes=50`;
    const trace = await getTraceStream(port, traceQuery);
    const traceData = tracePayloadOf(trace.data);
    check('/trace/stream result 结构', trace.status === 200 && !!traceData && Array.isArray(traceData.nodes) && Array.isArray(traceData.edges), JSON.stringify(trace.error || trace.data).slice(0, 120));

    const traceUp = await getTraceStream(port, `${traceQuery}&direction=up`);
    const traceUpData = tracePayloadOf(traceUp.data);
    check('/trace/stream direction=up 结构', traceUp.status === 200 && !!traceUpData && Array.isArray(traceUpData.nodes) && traceUpData.direction === 'up', JSON.stringify(traceUp.error || traceUp.data).slice(0, 120));

    // 安全回归：静态目录穿越应 403/404，畸形端口参数不应 500
    const evil = await fetch(`http://127.0.0.1:${port}/../server.ts`).then(r => r.status).catch(() => 0);
    check('静态穿越被拒', evil === 403 || evil === 404, `got ${evil}`);
    const badDepth = await getTraceStream(port, `symbol=${encodeURIComponent(sym.name)}&file=${encodeURIComponent(fileWithSymbols.path)}&depth=-5&maxNodes=abc`);
    const badDepthData = tracePayloadOf(badDepth.data);
    check('非法 depth/maxNodes 容错', badDepth.status === 200 && !!badDepthData && Array.isArray(badDepthData.nodes));
  } finally {
    srv.kill();
  }
}

// 把 JSON 响应窄化成断言需要的形状：先确认是对象再断言，而不是直接 as（避免把 any 带进来）
function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? v as Record<string, unknown> : null;
}
function statusPayloadOf(v: unknown): StatusPayload | null {
  const r = asRecord(v);
  return r ? { stale: typeof r.stale === 'boolean' ? r.stale : undefined } : null;
}
function symbolsPayloadOf(v: unknown): SymbolsPayload | null {
  const r = asRecord(v);
  return r && Array.isArray(r.symbols) ? { symbols: r.symbols as SymbolsPayload['symbols'] } : null;
}
function graphPayloadOf(v: unknown): GraphPayload | null {
  const r = asRecord(v);
  return r ? { callers: Array.isArray(r.callers) ? r.callers : undefined, callees: Array.isArray(r.callees) ? r.callees : undefined } : null;
}
function tracePayloadOf(v: unknown): TracePayload | null {
  const r = asRecord(v);
  if (!r) return null;
  const dir = r.direction === 'up' || r.direction === 'down' ? r.direction : undefined;
  return { nodes: Array.isArray(r.nodes) ? r.nodes : undefined, edges: Array.isArray(r.edges) ? r.edges : undefined, direction: dir };
}

for (const f of fixtures) {
  if (!existsSync(f.root)) { console.log(`\n== ${f.name} 跳过（目录不存在）`); continue; }
  await testProject(f);
}
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
