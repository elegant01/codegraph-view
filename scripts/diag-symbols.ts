// 诊断：对每个 fixture 项目起服务，按「符号数最多的 / 中段 / 最少」分层抽样文件，
// 查 /api/symbols 统计空结果比例（用于排查 codegraph 符号表解析的覆盖情况）。
// 项目列表读 scripts/fixtures.local.json（无则读 .example.json），端口按序 +12 避开 e2e 的占用。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadFixtures, type Fixture } from './fixtures.ts';

interface FileItem { path: string; nodeCount: number }
interface ApiResponse { status: number; data: unknown }

const PKG = fileURLToPath(new URL('..', import.meta.url));
const PROJECTS: Fixture[] = loadFixtures().map(f => ({ ...f, port: f.port + 12 }));

async function get(port: number, path: string, timeoutMs = 90000): Promise<ApiResponse> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api${path}`, { signal: ctl.signal });
    return { status: res.status, data: await res.json().catch((): null => null) };
  } finally { clearTimeout(t); }
}
async function waitUp(port: number, tries = 50): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try { const r = await get(port, '/status', 2000); if (r.status === 200) return true; } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

for (const p of PROJECTS) {
  if (!existsSync(p.root)) { console.log(`\n== ${p.name} 跳过（目录不存在）`); continue; }
  console.log(`\n== ${p.name} :${p.port}`);
  const srv = spawn(process.execPath, [join(PKG, 'server.ts'), String(p.port)], { cwd: p.root, stdio: 'ignore', windowsHide: true });
  try {
    if (!await waitUp(p.port)) { console.log('  服务启动失败'); continue; }
    const files = await get(p.port, '/files');
    if (!Array.isArray(files.data)) { console.log('  /files 失败'); continue; }
    const all = (files.data as FileItem[]).filter(f => f.nodeCount > 0).sort((a, b) => b.nodeCount - a.nodeCount);
    // 分层抽样：top 8 + 中部随机 12 + 低符号数 8（nodeCount 1-2，边界情况）
    const top = all.slice(0, 8);
    const mid = all.slice(8).filter((_, i) => i % 17 === 0).slice(0, 12);
    const low = all.filter(f => f.nodeCount <= 2).slice(0, 8);
    const sample = [...top, ...mid, ...low];
    let empty = 0;
    for (const f of sample) {
      const r = await get(p.port, '/symbols?file=' + encodeURIComponent(f.path));
      const rec = r.data && typeof r.data === 'object' ? r.data as Record<string, unknown> : null;
      const n = rec && Array.isArray(rec.symbols) ? rec.symbols.length : -1;
      if (n <= 0) { empty++; console.log(`  ❌ [nodes=${f.nodeCount}] ${f.path} → symbols=${n}`); }
      else console.log(`  ✅ [nodes=${String(f.nodeCount).padStart(3)}] ${f.path} → ${n} 个符号`);
    }
    console.log(`  小计: ${sample.length - empty}/${sample.length} 正常`);
  } finally { srv.kill(); }
}
