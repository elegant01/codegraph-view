// 服务端集成测试：真实起 server 子进程，验证 API 契约与安全防护（防逃逸/404/400）
// codegraph CLI 不可用的环境也可跑：/api/source 与静态文件不依赖 codegraph
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = dirname(fileURLToPath(import.meta.url)) + '/..';
const PORT = 39771; // 独立端口，避免与开发实例冲突
const BASE = `http://127.0.0.1:${PORT}`;

let child = null;
async function startServer() {
  child = spawn(process.execPath, [join(PKG, 'server.mjs'), String(PORT)], { cwd: PKG, stdio: 'ignore' });
  // 轮询等端口就绪（最多 5s）
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/api/status'); return; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error('server 未在 5s 内就绪');
}
async function stopServer() {
  if (child) { child.kill(); child = null; }
}

before(startServer);
after(stopServer);

test('GET /api/source 返回目标行 ±8 行片段', async () => {
  const res = await fetch(`${BASE}/api/source?file=lib/validate.mjs&line=5`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.file, 'lib/validate.mjs');
  assert.equal(data.line, 5);
  assert.ok(data.start >= 1 && data.start <= 5, 'start 应落在目标行之前');
  assert.ok(data.end > 5, 'end 应覆盖目标行');
  assert.ok(data.snippet.includes('export function safeFile'), '片段应含目标函数定义行');
  assert.equal(data.snippet.split('\n').length, data.end - data.start + 1);
});

test('GET /api/source 拒绝 ../ 目录逃逸', async () => {
  const res = await fetch(`${BASE}/api/source?file=../package.json&line=1`);
  assert.equal(res.status, 400); // safeFile 直接拒绝
  const res2 = await fetch(`${BASE}/api/source?file=sub/../../package.json&line=1`);
  assert.equal(res2.status, 400);
});

test('GET /api/source 拒绝绝对路径与盘符', async () => {
  for (const f of ['/etc/passwd', 'C:/Windows/win.ini']) {
    const res = await fetch(`${BASE}/api/source?file=${encodeURIComponent(f)}&line=1`);
    assert.equal(res.status, 400, f);
  }
});

test('GET /api/source 缺参 400 / 文件不存在 404 / 非法行号回落 1', async () => {
  assert.equal((await fetch(`${BASE}/api/source`)).status, 400);
  assert.equal((await fetch(`${BASE}/api/source?file=nope-not-exist.js&line=1`)).status, 404);
  const res = await fetch(`${BASE}/api/source?file=lib/validate.mjs&line=999999`);
  assert.equal(res.status, 200); // clampInt 钳到文件末尾附近而非报错
  const data = await res.json();
  assert.ok(data.total >= data.end, 'end 不应超过总行数');
});

test('静态文件：/ 返回 HTML 且引用拆分资源', async () => {
  const res = await fetch(BASE + '/');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('href="style.css"'), 'index.html 应引用 style.css');
  assert.ok(html.includes('src="app.js"'), 'index.html 应引用 app.js');
});

test('静态文件：路径穿越返回 403（relative 防绕过）', async () => {
  // startsWith(PUB) 前缀检查骗不过的场景，静态分支必须用 relative 判定
  const res = await fetch(BASE + '/..%2f..%2fpackage.json');
  assert.ok([403, 404].includes(res.status), '穿越路径不得 200，实际: ' + res.status);
});

test('未知路径返回 404 JSON', async () => {
  const res = await fetch(BASE + '/no-such-page');
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not found' });
});

test('GET /api/status 返回服务状态结构', async () => {
  const res = await fetch(BASE + '/api/status');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(typeof data.stale, 'boolean');
  assert.equal(typeof data.reindexing, 'boolean');
});

// CI 环境无 codegraph 索引时接口应报错而非挂起——验证超时兜底。
// 首次调用可能触发 codegraph 冷启动（spawn shim / 建缓存）；runner 默认 timeout 30s，
// codegraph 不可用时 /api/search 等满 30s 才报 500，故中止阈值放宽到 45s。
test('GET /api/search 在 codegraph 不可用时快速失败（不挂起）', async () => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 45000);
  try {
    const res = await fetch(`${BASE}/api/search?q=getList`, { signal: ctrl.signal });
    // codegraph 可用 → 200 + 数组；不可用 → 500；两者皆可，唯独不允许挂起/崩溃
    assert.ok([200, 500].includes(res.status), '实际: ' + res.status);
    if (res.status === 200) assert.ok(Array.isArray(await res.json()));
  } catch (e) {
    if (e.name === 'AbortError') assert.fail('/api/search 45s 未响应，疑似挂起');
    throw e;
  } finally { clearTimeout(t); }
});
