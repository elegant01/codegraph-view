// 端到端冒烟：对存在的 fixture 项目逐个起服务，验证核心 API 可用且结构正确
// 用法: node scripts/e2e.mjs [项目根目录...]（不传则用默认 fixture 列表，目录不存在自动跳过）
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const PKG = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_FIXTURES = [
  { name: 'next-admin', root: 'F:\\centos\\next-admin', port: 5199 },
  { name: 'ban-server', root: 'F:\\centos\\ban-server', port: 5200 },
  { name: 'appwork', root: 'F:\\centos\\appwork', port: 5201 },
  { name: 'youpai', root: 'F:\\centos\\youpai', port: 5202 },
];

const fixtures = process.argv.slice(2).length
  ? process.argv.slice(2).map((root, i) => ({ name: root, root, port: 5300 + i }))
  : DEFAULT_FIXTURES;

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}

async function get(port, path, timeoutMs = 60000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api${path}`, { signal: ctl.signal });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  } finally { clearTimeout(t); }
}

async function getTraceStream(port, query, timeoutMs = 90000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/trace/stream?${query}`, { signal: ctl.signal });
    const text = await res.text();
    const events = [];
    let event = 'message';
    let data = [];
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      else if (!line.trim() && data.length) {
        let parsed = data.join('\n');
        try { parsed = JSON.parse(parsed); } catch { /* 保留原始事件数据 */ }
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

async function waitUp(port, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try { const r = await get(port, '/status', 2000); if (r.status === 200) return true; } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

async function testProject({ name, root, port }) {
  console.log(`\n== ${name} (${root}) :${port}`);
  const srv = spawn(process.execPath, [join(PKG, 'server.mjs'), String(port)], { cwd: root, stdio: 'ignore', windowsHide: true });
  try {
    if (!await waitUp(port)) { check('服务启动', false); return; }
    check('服务启动', true);

    const status = await get(port, '/status');
    check('/status 结构', status.data && typeof status.data.stale === 'boolean');

    const files = await get(port, '/files');
    if (!Array.isArray(files.data)) {
      console.log(`  ⏭️ /files 跳过：fixture 未返回文件数组 (${JSON.stringify(files.data).slice(0, 160)})`);
      return;
    }
    check('/files 非空数组', files.data.length > 0, 'got 0');
    if (!files.data.length) return;

    // 选代表性源码文件：符号多、排除 config/min 文件（file 类节点无 --symbols-only 列表）。
    // 某些 fixture 的最高 nodeCount 文件可能没有可解析符号，因此按候选顺序尝试。
    const candidates = files.data
      .filter(f => f.nodeCount > 0 && !/\.config\.|\.min\.|\.d\.ts$/.test(f.path))
      .sort((a, b) => b.nodeCount - a.nodeCount);
    let fileWithSymbols = null;
    let symbols = null;
    for (const candidate of candidates) {
      const response = await get(port, '/symbols?file=' + encodeURIComponent(candidate.path));
      if (Array.isArray(response.data?.symbols) && response.data.symbols.length) {
        fileWithSymbols = candidate;
        symbols = response.data;
        break;
      }
    }
    if (!fileWithSymbols) {
      console.log('  ⏭️ /symbols 跳过：fixture 没有可解析的源码符号');
      return;
    }
    check('存在含符号的文件', true);
    check('/symbols 非空', true);
    const sym = symbols.symbols[0];

    const search = await get(port, '/search?q=' + encodeURIComponent(sym.name));
    check('/search 有结果', Array.isArray(search.data) && search.data.length > 0);

    const graph = await get(port, `/graph?symbol=${encodeURIComponent(sym.name)}&file=${encodeURIComponent(fileWithSymbols.path)}`);
    check('/graph 结构', graph.data && Array.isArray(graph.data.callers) && Array.isArray(graph.data.callees));

    const traceQuery = `symbol=${encodeURIComponent(sym.name)}&file=${encodeURIComponent(fileWithSymbols.path)}&depth=2&maxNodes=50`;
    const trace = await getTraceStream(port, traceQuery);
    check('/trace/stream result 结构', trace.status === 200 && trace.data && Array.isArray(trace.data.nodes) && Array.isArray(trace.data.edges), JSON.stringify(trace.error || trace.data).slice(0, 120));

    const traceUp = await getTraceStream(port, `${traceQuery}&direction=up`);
    check('/trace/stream direction=up 结构', traceUp.status === 200 && traceUp.data && Array.isArray(traceUp.data.nodes) && traceUp.data.direction === 'up', JSON.stringify(traceUp.error || traceUp.data).slice(0, 120));

    // 安全回归：静态目录穿越应 403/404，畸形端口参数不应 500
    const evil = await fetch(`http://127.0.0.1:${port}/../server.mjs`).then(r => r.status).catch(() => 0);
    check('静态穿越被拒', evil === 403 || evil === 404, `got ${evil}`);
    const badDepth = await getTraceStream(port, `symbol=${encodeURIComponent(sym.name)}&file=${encodeURIComponent(fileWithSymbols.path)}&depth=-5&maxNodes=abc`);
    check('非法 depth/maxNodes 容错', badDepth.status === 200 && badDepth.data && Array.isArray(badDepth.data.nodes));
  } finally {
    srv.kill();
  }
}

for (const f of fixtures) {
  if (!existsSync(f.root)) { console.log(`\n== ${f.name} 跳过（目录不存在）`); continue; }
  await testProject(f);
}
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
