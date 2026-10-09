// CodeGraph 可视化服务（零依赖，node:http 内置模块）
// 用法: node server.mjs [端口] [--host 0.0.0.0]  →  打开 http://localhost:39267
// 默认仅监听 127.0.0.1（本机工具，防局域网访问源码）；需要共享时显式 --host 或 HOST 环境变量
import { createServer } from 'node:http';
import { readFile, stat as fsStat } from 'node:fs/promises';
import { watch } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { join, extname, normalize, relative, isAbsolute } from 'node:path';
import { safeArg, safeFile, clampInt } from './lib/validate.mjs';
import { createRunner } from './lib/proc.mjs';
import { parseJson, parseTrail, parseNodeKind, isImportRef, fuzzyMatch } from './lib/textparse.mjs';
import { createRouteParser, matchRoute } from './lib/routes.mjs';
import { createUrlMapper } from './lib/urlmap.mjs';
import { createSymbolResolver } from './lib/sourcecalls.mjs';
import { traceChain } from './lib/trace.mjs';

const ROOT = process.cwd(); // 项目根目录（codegraph 索引所在）
const PKG = fileURLToPath(new URL('.', import.meta.url));
const PUB = join(PKG, 'public');

// 端口/主机解析：--host 显式指定，否则默认仅本机回环
const argv = process.argv.slice(2);
const hostIdx = argv.indexOf('--host');
const HOST = hostIdx >= 0 && argv[hostIdx + 1] ? String(argv[hostIdx + 1]) : (process.env.HOST || '127.0.0.1');
const portArg = argv.find(a => /^\d+$/.test(a));
const PORT = clampInt(portArg ?? process.env.PORT ?? 39267, 39267, 1, 65535);
const EXPOSED = !/^(127\.|localhost$|::1$|\[::1\]$)/.test(HOST);

const { run, useBundled } = createRunner({ root: ROOT, pkgDir: PKG });
const routeParser = createRouteParser({ root: ROOT, run });
const urlMapper = createUrlMapper({ root: ROOT });
const symbolResolver = createSymbolResolver({ run });

// gin 包级处理器（如 controllers.Add）：按名查询，取第一个 function/method 符号
async function resolveBareFunc(name) {
  if (!name || !/^[\w]+$/.test(name)) return null;
  const out = await run(['query', name, '--json', '-l', '10']);
  const list = parseJson(out, []);
  const hit = list.find(r => r.node && r.node.name === name && /func|method/.test(r.node.kind || ''))
    || list.find(r => r.node && /func|method/.test(r.node.kind || ''));
  return hit ? { name: hit.node.name, filePath: hit.node.filePath, startLine: hit.node.startLine, kind: hit.node.kind } : null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// JSON 响应：>1KB 且客户端支持时 gzip；统一加 nosniff
function json(req, res, code, obj) {
  let body = Buffer.from(JSON.stringify(obj));
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' };
  const ae = String(req.headers['accept-encoding'] || '');
  if (body.length > 1024 && /\bgzip\b/.test(ae)) {
    body = gzipSync(body);
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = body.length;
  res.writeHead(code, headers);
  res.end(body);
}

// ===== 短 TTL 缓存（搜索结果 / 文件列表），reindex 时失效 =====
const TTL_SEARCH = 20000, TTL_FILES = 30000;
const searchCache = new Map(); // key -> { at, data }
const filesCache = { at: 0, data: null };
function cacheGet(map, key, ttl) {
  const e = map.get(key);
  if (e && Date.now() - e.at < ttl) { map.delete(key); map.set(key, e); return e.data; }
  return null;
}
function cacheSet(map, key, data, cap = 100) {
  if (map.size >= cap) map.delete(map.keys().next().value);
  map.set(key, { at: Date.now(), data });
}
function invalidateAll() {
  searchCache.clear();
  filesCache.at = 0; filesCache.data = null;
  routeParser.invalidate();
  urlMapper.invalidate();
  symbolResolver.clear();
}

// ===== 代码变更检测：watch 项目目录，提示「索引可能过期」 =====
let indexStale = false;
let staleFile = null;
let reindexState = { running: false, lastAt: 0 };
try {
  const IGNORE_WATCH = /(^|[\\/])(\.git|\.codegraph|node_modules|vendor|dist|build|out|\.next|\.nuxt|\.idea|\.vscode|coverage|logs?|tmp|temp)([\\/]|$)/;
  const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|go|php|py|java|rs|vue|svelte)$/;
  let debounce = null;
  watch(ROOT, { recursive: true }, (event, filename) => {
    if (!filename || indexStale || reindexState.running) return;
    // 只有源码文件变更才提示过期——日志/缓存/IDE 文件变更不该惊动用户
    if (IGNORE_WATCH.test(filename) || !SOURCE_EXT.test(filename)) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => { indexStale = true; staleFile = filename; }, 500);
  });
} catch { /* 平台不支持 recursive watch 时静默降级（仅无过期提示） */ }

// ===== 全链路任务注册表：支持取消与进度查询 =====
const traceTasks = new Map(); // id -> { nodes, edges, done, error, cancelled }
function expireTraceTask(id) { setTimeout(() => traceTasks.delete(id), 30000); }

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  try {
    // 轻量探活：不触发任何 codegraph 调用，供 pm2/systemd/容器健康检查使用
    if (path === '/_health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('{"ok":true}');
    }
    // 搜索符号（支持 kind 过滤 / 正则模式）
    if (path === '/api/search') {
      const q = safeArg(url.searchParams.get('q'));
      if (!q) return json(req, res, 400, { error: 'missing ?q=' });
      const kind = safeArg(url.searchParams.get('kind'));
      const useRegex = url.searchParams.get('regex') === '1';
      let re = null;
      if (useRegex) {
        try { re = new RegExp(q, 'i'); }
        catch { return json(req, res, 400, { error: '正则表达式无效：' + q }); }
      }
      const cacheKey = q + '|' + (kind || '') + '|' + (useRegex ? 're' : '');
      const cached = cacheGet(searchCache, cacheKey, TTL_SEARCH);
      if (cached) return json(req, res, 200, cached);
      const out = await run(['query', q, '--json', '-l', useRegex ? '200' : '40']);
      let list = parseJson(out, []).map((r) => r.node);
      // 去重：同一文件内重载/重写的同名符号只保留一个
      const seen = new Set();
      list = list.filter(h => {
        const key = (h.filePath || '') + '::' + (h.qualifiedName || h.name);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      // 精确匹配结果太少时自动触发本地模糊匹配（容忍拼写偏差）；正则模式下拉宽候选后本地过滤
      if (useRegex || (list.length < 3 && q.length > 2)) {
        try {
          const wide = await run(['query', q, '--json', '-l', useRegex ? '500' : '200']);
          for (const r of parseJson(wide, [])) {
            const n = r && r.node;
            if (!n) continue;
            const name = n.name || '';
            const qn = n.qualifiedName || '';
            const hitRe = re ? (re.test(name) || re.test(qn)) : (fuzzyMatch(q, name) || fuzzyMatch(q, qn));
            if (!hitRe) continue;
            const key = (n.filePath || '') + '::' + (n.qualifiedName || n.name);
            if (seen.has(key)) continue;
            seen.add(key);
            list.push(n);
            if (list.length >= 50) break;
          }
        } catch { /* 补全失败则维持原结果 */ }
      }
      if (useRegex && re) list = list.filter(n => re.test(n.name || '') || re.test(n.qualifiedName || ''));
      if (kind && kind !== 'all') list = list.filter(n => n.kind === kind);
      cacheSet(searchCache, cacheKey, list);
      return json(req, res, 200, list);
    }
    // 调用关系图: callers + callees + 源码
    // 带 file 时走 `node -f` 精确定位单个符号（callers/callees CLI 不支持文件消歧，
    // 会把所有同名符号的调用者合并，重名方法如 getList 会冒出几十个假调用者）
    if (path === '/api/graph') {
      const sym = safeArg(url.searchParams.get('symbol'));
      if (!sym) return json(req, res, 400, { error: 'missing ?symbol=' });
      const file = safeFile((url.searchParams.get('file') || '').trim());
      if (file) {
        const nodeRaw = await run(['node', sym, '-f', file]);
        const dropImport = (c) => c && !isImportRef(c.name);
        return json(req, res, 200, {
          symbol: sym,
          callers: parseTrail(nodeRaw, 'Called by ←').filter(dropImport),
          callees: parseTrail(nodeRaw, 'Calls →').filter(dropImport),
          source: nodeRaw,
        });
      }
      const [callersRaw, calleesRaw, nodeRaw] = await Promise.all([
        run(['callers', sym, '--json', '-l', '40']),
        run(['callees', sym, '--json', '-l', '40']),
        run(['node', sym]),
      ]);
      const callers = parseJson(callersRaw, {}).callers || [];
      const callees = parseJson(calleesRaw, {}).callees || [];
      return json(req, res, 200, { symbol: sym, callers, callees, source: nodeRaw });
    }
    // 列出所有路由（接口发现面板；Laravel + Go beego/gin 合并）
    if (path === '/api/routes') {
      const [php, go] = await Promise.all([routeParser.parseLaravelRoutes(), routeParser.parseGoRoutes()]);
      return json(req, res, 200, [...php, ...go]);
    }
    // 路由定位（Laravel/PHP + Go beego/gin）：输入 /xxx 匹配路由定义，返回对应 handler 符号
    if (path === '/api/route') {
      const routeUrl = safeArg(url.searchParams.get('url'));
      if (!routeUrl) return json(req, res, 400, { error: 'missing ?url=' });
      const fuzzy = url.searchParams.get('fuzzy') === '1';
      const clean = routeUrl.replace(/[?#].*$/, '').replace(/^\/+/, '');
      // 同时支持带/不带 api 前缀：路由定义 url 通常不带 api，用户可能输入 /api/xxx
      const candidates = clean === clean.replace(/^api\//, '')
        ? [clean]
        : [clean, clean.replace(/^api\//, '')];
      const [phpRoutes, goRoutes] = await Promise.all([routeParser.parseLaravelRoutes(), routeParser.parseGoRoutes()]);
      const list = [...phpRoutes, ...goRoutes];
      // 模糊模式 hits 可能很多，只解析前 10 条，避免串行 execFile 拖垮响应
      const hits = fuzzy
        ? list.filter(r => candidates.some(c => r.url.toLowerCase().includes(c.toLowerCase()))).slice(0, 10)
        : list.filter(r => candidates.some(c => matchRoute(r.url, c))).slice(0, 10);
      const out = [];
      for (const r of hits) {
        // 匿名处理器：解析期已带文件/行号，直接可用
        if (r.filePath && r.startLine) { out.push({ url: r.url, method: r.method, handler: r.handler, line: r.line, name: r.name, filePath: r.filePath, startLine: r.startLine }); continue; }
        const [cls, method] = (r.handler || '').split('@');
        try {
          // 有类名走 Class::method 精确解析；裸函数名（gin 包级处理器）按名查询取第一个函数/方法
          const sym = method
            ? await symbolResolver.resolveSymbol(cls, method)
            : await resolveBareFunc(cls);
          if (sym) out.push({ url: r.url, method: r.method, handler: r.handler, line: r.line, ...sym });
        } catch { /* 符号定位失败跳过 */ }
      }
      return json(req, res, 200, out);
    }
    // 重新建立索引：single-flight + 5s 冷却，防连点/并发写坏索引
    if (path === '/api/reindex') {
      if (reindexState.running) return json(req, res, 409, { error: '索引正在重建中，请等待当前任务完成' });
      if (Date.now() - reindexState.lastAt < 5000) return json(req, res, 429, { error: '索引刚重建过，请稍候几秒再试' });
      reindexState.running = true;
      try {
        const out = await run(['init'], { maxBuffer: 20 * 1024 * 1024, timeout: 120000 });
        invalidateAll();
        indexStale = false;
        staleFile = null;
        reindexState.lastAt = Date.now();
        const m = String(out).match(/indexed|symbols|done|完成/i);
        return json(req, res, 200, { ok: true, message: m ? m[0] : '索引已重建' });
      } catch (e) {
        return json(req, res, 500, { error: '重新索引失败：' + ((e && e.message) || e) });
      } finally {
        reindexState.running = false;
      }
    }
    // 自定义 route-map 规则定位（任意框架）：URL → controller/method 符号
    if (path === '/api/urlmap') {
      const urlPath = safeArg(url.searchParams.get('url'));
      if (!urlPath) return json(req, res, 400, { error: 'missing ?url=' });
      const hit = urlMapper.matchUrlMap(urlPath);
      if (!hit) return json(req, res, 200, []);
      return json(req, res, 200, [{ ...hit, url: urlPath }]);
    }
    // 服务状态：索引过期提示 / 运行信息
    if (path === '/api/status') {
      return json(req, res, 200, { stale: indexStale, staleFile, reindexing: reindexState.running, bundled: useBundled, exposed: EXPOSED });
    }
    // 全链路递归展开（轮询模式，兼容旧客户端）：direction=down（默认）| up（向上 callers 链）
    if (path === '/api/trace') {
      const sym = safeArg(url.searchParams.get('symbol'));
      if (!sym) return json(req, res, 400, { error: 'missing ?symbol=' });
      const file = safeFile((url.searchParams.get('file') || '').trim());
      const depth = clampInt(url.searchParams.get('depth'), 6, 1, 10);
      const maxNodes = clampInt(url.searchParams.get('maxNodes'), 300, 10, 800);
      const direction = url.searchParams.get('direction') === 'up' ? 'up' : 'down';
      const id = safeArg(url.searchParams.get('id'));
      if (id) traceTasks.set(id, { nodes: 0, edges: 0, done: false, error: null, cancelled: false });
      try {
        const result = await traceChain({ run, root: ROOT, resolveSourceCalls: symbolResolver.resolveSourceCalls }, sym, file, {
          depth, maxNodes, direction,
          isCancelled: () => !!(id && traceTasks.get(id) && traceTasks.get(id).cancelled),
          onProgress: (p) => { if (id && traceTasks.has(id)) traceTasks.set(id, { ...traceTasks.get(id), ...p, done: false, error: null }); },
        });
        if (id) {
          traceTasks.set(id, { nodes: result.nodeCount, edges: result.edges.length, done: true, error: null, cancelled: result.cancelled });
          expireTraceTask(id);
        }
        return json(req, res, 200, result);
      } catch (e) {
        if (id) {
          traceTasks.set(id, { nodes: 0, edges: 0, done: true, error: String((e && e.message) || e), cancelled: false });
          expireTraceTask(id);
        }
        throw e;
      }
    }
    // 全链路展开（SSE 流式）：进度事件实时推送，客户端断开即取消后端展开
    if (path === '/api/trace/stream') {
      const sym = safeArg(url.searchParams.get('symbol'));
      if (!sym) return json(req, res, 400, { error: 'missing ?symbol=' });
      const file = safeFile((url.searchParams.get('file') || '').trim());
      const depth = clampInt(url.searchParams.get('depth'), 6, 1, 10);
      const maxNodes = clampInt(url.searchParams.get('maxNodes'), 300, 10, 800);
      const direction = url.searchParams.get('direction') === 'up' ? 'up' : 'down';
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': ok\n\n');
      let closed = false;
      req.on('close', () => { closed = true; });
      const send = (event, data) => { if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
      try {
        const result = await traceChain({ run, root: ROOT, resolveSourceCalls: symbolResolver.resolveSourceCalls }, sym, file, {
          depth, maxNodes, direction,
          isCancelled: () => closed,
          onProgress: (p) => send('progress', p),
        });
        send('result', result);
      } catch (e) {
        send('error', { error: String((e && e.message) || e) });
      }
      if (!closed) res.end();
      return;
    }
    // 全链路进度轮询（兼容旧客户端）
    if (path === '/api/trace/progress') {
      const id = safeArg(url.searchParams.get('id'));
      return json(req, res, 200, (id && traceTasks.get(id)) || { nodes: 0, edges: 0, done: false });
    }
    // 取消进行中的全链路展开
    if (path === '/api/trace/cancel') {
      const id = safeArg(url.searchParams.get('id'));
      const t = id && traceTasks.get(id);
      if (t && !t.done) { t.cancelled = true; return json(req, res, 200, { ok: true }); }
      return json(req, res, 200, { ok: false });
    }
    // 文件内的符号列表
    if (path === '/api/symbols') {
      const file = safeFile((url.searchParams.get('file') || '').trim());
      if (!file) return json(req, res, 400, { error: 'missing or invalid ?file=' });
      const out = await run(['node', '-f', file, '--symbols-only']);
      const symbols = [];
      for (const m of out.matchAll(/^- `([^`]+)` \(([^)]+)\)(?:.*?) — :(\d+)$/gm)) {
        symbols.push({ name: m[1], kind: m[2], line: Number(m[3]) });
      }
      // codegraph 符号表硬上限 200，超出时输出 `- … +N more`；透出给前端提示
      const more = out.match(/^- … \+(\d+) more$/m);
      const total = more ? symbols.length + Number(more[1]) : symbols.length;
      return json(req, res, 200, { file, symbols, total, truncated: !!more });
    }
    // 源码片段（节点悬停预览）：file + line，返回该行 ±8 行
    if (path === '/api/source') {
      const file = safeFile((url.searchParams.get('file') || '').trim());
      if (!file) return json(req, res, 400, { error: 'missing or invalid ?file=' });
      const line = clampInt(url.searchParams.get('line'), 1, 1, 1e9);
      // 相对 ROOT 解析（与 codegraph 索引一致），path.relative 防目录逃逸
      const full = normalize(join(ROOT, file));
      const rel = relative(ROOT, full);
      if (rel.startsWith('..') || isAbsolute(rel)) return json(req, res, 403, { error: 'forbidden' });
      try {
        let stat;
        try { stat = await fsStat(full); } catch { return json(req, res, 404, { error: 'file not found' }); }
        if (stat.size > 2 * 1024 * 1024) return json(req, res, 413, { error: 'file too large' });
        const text = await readFile(full, 'utf8');
        const lines = text.split('\n');
        const start = Math.max(1, line - 8);
        const end = Math.min(lines.length, line + 8);
        return json(req, res, 200, { file, line, start, end, total: lines.length, snippet: lines.slice(start - 1, end).join('\n') });
      } catch (e) {
        return json(req, res, 500, { error: '读取失败：' + ((e && e.message) || e) });
      }
    }
    // 文件列表（30s 缓存）
    if (path === '/api/files') {
      if (filesCache.data && Date.now() - filesCache.at < TTL_FILES) return json(req, res, 200, filesCache.data);
      const out = await run(['files', '--json']);
      const data = parseJson(out, []);
      filesCache.at = Date.now();
      filesCache.data = data;
      return json(req, res, 200, data);
    }
    // 静态文件：path.relative 防前缀绕过（startsWith(PUB) 会被 ../public-evil 骗过）
    const file = path === '/' ? 'index.html' : decodeURIComponent(path.slice(1));
    const full = normalize(join(PUB, file));
    const rel = relative(PUB, full);
    if (rel.startsWith('..') || isAbsolute(rel)) return json(req, res, 403, { error: 'forbidden' });
    try {
      const body = await readFile(full);
      // ETag：基于内容大小 + mtime，命中 If-None-Match 返回 304 省流量
      const stat = await fsStat(full);
      const etag = `W/"${stat.size}-${stat.mtimeMs.toString(36)}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag });
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': MIME[extname(full)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', ETag: etag, 'Cache-Control': 'no-cache' });
      return res.end(body);
    } catch {
      return json(req, res, 404, { error: 'not found' });
    }
  } catch (e) {
    json(req, res, 500, { error: String((e && e.message) || e) });
  }
});
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.log(`[错误] 端口 ${PORT} 已被占用，换个端口重试，例如: cgv view ${PORT + 1}`);
  } else {
    console.log('[错误] 服务启动失败:', (e && e.message) || e);
  }
  process.exit(1);
});
server.listen(PORT, HOST, async () => {
  console.log(`CodeGraph Viz: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (项目: ${ROOT})`);
  if (EXPOSED) console.log(`[警告] 服务绑定在 ${HOST}，局域网/外部可访问本机源码与接口，仅在可信网络使用`);
  // 启动探测：确认 codegraph 可用并记录版本（输出格式漂移告警见 textparse.warnIfFormatDrift）
  try {
    const v = (await run(['--version'], { timeout: 10000 })).trim().split('\n')[0];
    if (v) console.log(`codegraph: ${v}${useBundled ? ' (bundled)' : ' (PATH)'}`);
  } catch (e) {
    console.log('[警告] codegraph 不可用：' + ((e && e.message) || e) + '，搜索/调用图将失败');
  }
});
