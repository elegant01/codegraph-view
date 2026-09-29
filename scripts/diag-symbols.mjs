// 诊断：对每个项目，取符号数最多的 N 个文件，查 /api/symbols，统计空结果比例
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const PKG = fileURLToPath(new URL('..', import.meta.url));
const PROJECTS = [
  { name: 'appwork', root: 'F:\\centos\\appwork', port: 5211 },
  { name: 'ban-server', root: 'F:\\centos\\ban-server', port: 5212 },
  { name: 'youpai', root: 'F:\\centos\\youpai', port: 5213 },
  { name: 'dify-chat', root: 'F:\\centos\\dify-chat', port: 5214 },
];
const TOP_N = 12;

async function get(port, path, timeoutMs = 90000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api${path}`, { signal: ctl.signal });
    return { status: res.status, data: await res.json().catch(() => null) };
  } finally { clearTimeout(t); }
}
async function waitUp(port, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try { const r = await get(port, '/status', 2000); if (r.status === 200) return true; } catch { }
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

for (const p of PROJECTS) {
  if (!existsSync(p.root)) { console.log(`\n== ${p.name} 跳过（目录不存在）`); continue; }
  console.log(`\n== ${p.name} :${p.port}`);
  const srv = spawn(process.execPath, [join(PKG, 'server.mjs'), String(p.port)], { cwd: p.root, stdio: 'ignore', windowsHide: true });
  try {
    if (!await waitUp(p.port)) { console.log('  服务启动失败'); continue; }
    const files = await get(p.port, '/files');
    if (!Array.isArray(files.data)) { console.log('  /files 失败'); continue; }
    const all = files.data.filter(f => f.nodeCount > 0).sort((a, b) => b.nodeCount - a.nodeCount);
    // 分层抽样：top 8 + 中部随机 12 + 低符号数 8（nodeCount 1-2，边界情况）
    const top = all.slice(0, 8);
    const mid = all.slice(8).filter((_, i) => i % 17 === 0).slice(0, 12);
    const low = all.filter(f => f.nodeCount <= 2).slice(0, 8);
    const sample = [...top, ...mid, ...low];
    let empty = 0;
    for (const f of sample) {
      const r = await get(p.port, '/symbols?file=' + encodeURIComponent(f.path));
      const n = r.data && Array.isArray(r.data.symbols) ? r.data.symbols.length : -1;
      if (n <= 0) { empty++; console.log(`  ❌ [nodes=${f.nodeCount}] ${f.path} → symbols=${n}`); }
      else console.log(`  ✅ [nodes=${String(f.nodeCount).padStart(3)}] ${f.path} → ${n} 个符号`);
    }
    console.log(`  小计: ${sample.length - empty}/${sample.length} 正常`);
  } finally { srv.kill(); }
}
