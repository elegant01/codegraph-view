// CodeGraph 可视化服务（零依赖，node:http 内置模块）
// 用法: node server.mjs [端口] [--host 0.0.0.0]  →  打开 http://localhost:39267
// 默认仅监听 127.0.0.1（本机工具，防局域网访问源码）；需要共享时显式 --host 或 HOST 环境变量
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, stat as fsStat, readdir } from 'node:fs/promises';
import { watch, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { join, extname, normalize, relative, isAbsolute } from 'node:path';
import { safeArg, safeFile, clampInt } from './lib/validate.ts';
import { createRunner } from './lib/proc.ts';
import { parseJson, parseTrail, parseNodeKind, isImportRef, fuzzyMatch } from './lib/textparse.ts';
import { createRouteParser, matchRoute } from './lib/routes.ts';
import { createUrlMapper } from './lib/urlmap.ts';
import { createSymbolResolver } from './lib/sourcecalls.ts';
import { traceChain } from './lib/trace.ts';
import type { SymbolNode } from './lib/textparse.ts';
import type { TraceResult } from './lib/trace.ts';

// ===== 接口契约类型（API 出参与内部结构；handler 签名也靠它们对齐）=====
/** API 路由处理函数；`handler: null` 表示「已登记但仍在下方兼容分支里处理」 */
type ApiHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => unknown;
interface RouteDef { method: string; path: string; handler: ApiHandler | null }
/** 带时间戳的缓存项 */
interface CacheEntry<T> { at: number; data: T }
/** `/api/graph` 的响应 */
interface GraphPayload {
  symbol: string;
  kind: string | null;
  line: number | null;
  callers: SymbolNode[];
  callees: SymbolNode[];
  source: string;
}
/** `/api/symbols` 的响应 */
interface SymbolsPayload {
  file: string;
  symbols: Array<{ name: string; kind: string; line: number }>;
  total: number;
  truncated: boolean;
}
/** 聚合根下发现的嵌套 git 仓库 */
interface RepoInfo { name: string; path: string }
/** `/api/files` 的一项：文件路径 + 该文件被索引到的符号数 */
interface FileInfo { path: string; nodeCount: number }

const ROOT = process.cwd(); // 项目根目录（codegraph 索引所在）
const ROOT_NAME = ROOT.split(/[\\/]/).filter(Boolean).pop() || 'root';
const PKG = fileURLToPath(new URL('.', import.meta.url));

// 发现聚合根目录下的嵌套 Git 仓库；只返回相对路径，供前端给节点打仓库标签
let repoCache: RepoInfo[] | null = null;
async function discoverRepos(): Promise<RepoInfo[]> {
  if (repoCache) return repoCache;
  const found = [{ name: ROOT_NAME, path: '' }];
  const ignored = new Set(['.git', '.codegraph', 'node_modules', 'vendor', 'dist', 'build', 'out', '.next', '.nuxt', '.idea', '.vscode', 'coverage']);
  async function walk(dir, rel, depth) {
    if (depth > 8) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || ignored.has(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const child = join(dir, entry.name);
      try {
        const childEntries = await readdir(child, { withFileTypes: true });
        if (childEntries.some(e => e.name === '.git')) found.push({ name: entry.name, path: childRel });
        if (!childEntries.some(e => e.name === '.git')) await walk(child, childRel, depth + 1);
      } catch { /* 无权限或已删除目录，跳过 */ }
    }
  }
  await walk(ROOT, '', 0);
  repoCache = found.sort((a, b) => b.path.length - a.path.length);
  return repoCache;
}
const PUB = join(PKG, 'public');

// 端口/主机解析：--host 显式指定，否则默认仅本机回环
const argv = process.argv.slice(2);
const hostIdx = argv.indexOf('--host');
const HOST = hostIdx >= 0 && argv[hostIdx + 1] ? String(argv[hostIdx + 1]) : (process.env.HOST || '127.0.0.1');
const portArg = argv.find(a => /^\d+$/.test(a));
const PORT = clampInt(portArg ?? process.env.PORT ?? 39267, 39267, 1, 65535);
const EXPOSED = !/^(127\.|localhost$|::1$|\[::1\]$)/.test(HOST);
// --json：结构化输出启动信息（供脚本/CI 判断端口与就绪状态）；正常文本输出保持不变
const JSON_OUT = argv.includes('--json');
// --read-only：只读分享模式，禁用 reindex 等写操作接口，可安全部署到公共地址
const READ_ONLY = argv.includes('--read-only');

const { run, useBundled } = createRunner({ root: ROOT, pkgDir: PKG });
const routeParser = createRouteParser({ root: ROOT, run });
const urlMapper = createUrlMapper({ root: ROOT });
const symbolResolver = createSymbolResolver({ run, root: ROOT });

// gin 包级处理器（如 controllers.Add）：按名查询，取第一个 function/method 符号
async function resolveBareFunc(name: string): Promise<SymbolNode | null> {
  if (!name || !/^[\w]+$/.test(name)) return null;
  const out = await run(['query', name, '--json', '-l', '10']);
  const list = parseJson(out, []);
  const hit = list.find(r => r.node && r.node.name === name && /func|method/.test(r.node.kind || ''))
    || list.find(r => r.node && /func|method/.test(r.node.kind || ''));
  return hit ? { name: hit.node.name, filePath: hit.node.filePath, startLine: hit.node.startLine, kind: hit.node.kind } : null;
}

const normPath = (p: unknown): string => String(p || '').replace(/\\/g, '/');

// 从 `codegraph node` 输出提取 Location 行号（Trail 文本不含 kind，但 Location 带行号）
function parseNodeLine(raw: unknown): number | null {
  const m = String(raw).match(/\*\*Location:\*\*\s*\S*?:(\d+)/);
  return m ? Number(m[1]) : null;
}

// callers/callees --json 的结果带 kind（Trail 文本不带）。按 (filePath, name) 建索引回填，
// 让节点卡片显示正确类型，并让前端的 interface/type 噪音过滤生效。
function kindLookupFrom(...raws: unknown[]): Map<string, string> {
  const map = new Map();
  for (const raw of raws) {
    const parsed = parseJson(raw, null);
    if (!parsed) continue;
    for (const key of ['callers', 'callees']) {
      for (const c of parsed[key] || []) {
        if (!c || !c.name) continue;
        const k = normPath(c.filePath) + '::' + c.name;
        if (c.kind && !map.has(k)) map.set(k, c.kind);
      }
    }
  }
  return map;
}

// 等 promise 最多 ms 毫秒；超时返回 null，但底层查询继续跑完并自己写缓存（不取消）。
// 用于「可选增强」：拿得到就带上，拿不到也不能拖慢或污染主结果。
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  const timeout = new Promise<null>((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    if (t && typeof t.unref === 'function') t.unref(); // 别让这个计时器吊住进程
  });
  return Promise.race<T | null>([promise, timeout]);
}

// 查一次邻居 kind（两次 --json 并发，自带并发合流）。
// 只有「真的查到了」（至少一侧返回了合法 JSON）才写缓存；查失败/超时记一次冷却，
// 冷却期内不再重试——否则每次 graph 请求都要白等一个 KIND_WAIT_MS。
function primeKinds(sym: string): Promise<Map<string, string>> {
  const running = kindInflight.get(sym);
  if (running) return running;
  const p = (async () => {
    try {
      const raws = await Promise.all([
        run(['callers', sym, '--json', '-l', '40']).catch(() => ''),
        run(['callees', sym, '--json', '-l', '40']).catch(() => ''),
      ]);
      const map = kindLookupFrom(...raws);
      if (raws.some(r => parseJson(r, null) !== null)) {
        cacheSet(kindCache, sym, map, 300);
        kindFailedAt.delete(sym);
      } else {
        kindFailedAt.set(sym, Date.now());
      }
      return map;
    } finally {
      kindInflight.delete(sym);
    }
  })();
  kindInflight.set(sym, p);
  return p;
}

// 取 kind：命中缓存立即返回；否则起一次查询并最多等 KIND_WAIT_MS，超时先返回 null
// （本次不带 kind，查询在后台跑完写缓存，下次请求即命中）。
const KIND_WAIT_MS = 1500;
const KIND_RETRY_MS = 30000; // 查询失败后的冷却，避免每次请求都白等
async function kindsFor(sym: string): Promise<Map<string, string> | null> {
  const hit = cacheGet(kindCache, sym, TTL_KINDS * staleFactor());
  if (hit) return hit;
  if (Date.now() - (kindFailedAt.get(sym) || 0) < KIND_RETRY_MS) return null;
  return withDeadline(primeKinds(sym), KIND_WAIT_MS);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// JSON 响应：>1KB 且客户端支持时 gzip；统一加 nosniff
function json(req: IncomingMessage, res: ServerResponse, code: number, obj: unknown): void {
  let body = Buffer.from(JSON.stringify(obj));
  const headers: Record<string, string | number> = { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' };
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
// 索引过期（stale）时 TTL 减半：改码后旧结果更快让位，同时避免完全禁缓存打爆 CLI
const TTL_SEARCH = 20000, TTL_FILES = 30000, TTL_GRAPH = 30000, TTL_TRACE = 60000, TTL_KINDS = 60000;
const staleFactor = (): number => (indexStale ? 0.5 : 1);
const searchCache = new Map<string, CacheEntry<SymbolNode[]>>(); // key -> { at, data }
const graphCache = new Map<string, CacheEntry<GraphPayload>>();  // symbol|file -> { at, data }（点节点/展开都走它）
const traceCache = new Map<string, CacheEntry<TraceResult>>();   // symbol|file|depth|maxNodes|direction -> { at, data }
// 邻居 kind 单独缓存：它来自一次可失败/可超时的 --json 查询，不能和 graph 主结果
// （node -f 的 Trail，稳定且快）混在同一个缓存里，否则冷启动那次拿不到 kind 的结果
// 会把「无 kind」冻结一整个 TTL。key 是 symbol，value 是 Map<'file::name', kind>。
const kindCache = new Map<string, CacheEntry<Map<string, string>>>(); // symbol -> { at, map }
const kindInflight = new Map<string, Promise<Map<string, string>>>(); // symbol -> Promise<Map>（并发合流）
const kindFailedAt = new Map<string, number>(); // symbol -> 上次查询失败时间（冷却期内不再重试）
const filesCache: { at: number; data: FileInfo[] | null } = { at: 0, data: null };

function cacheGet<T>(map: Map<string, CacheEntry<T>>, key: string, ttl: number): T | null {
  const e = map.get(key);
  if (e && Date.now() - e.at < ttl) { map.delete(key); map.set(key, e); return e.data; }
  return null;
}
function cacheSet<T>(map: Map<string, CacheEntry<T>>, key: string, data: T, cap = 100): void {
  if (map.size >= cap) map.delete(map.keys().next().value as string);
  map.set(key, { at: Date.now(), data });
}
// 文件符号列表：`node -f <file> --symbols-only` 实测大文件要几十秒（nextjs-app 单文件 28s），
// 必须缓存；同文件并发请求合流，避免双击/多入口同时触发重复跑 CLI。
const TTL_SYMBOLS = 60000;
const symbolsCache = new Map<string, CacheEntry<SymbolsPayload>>();    // file -> { at, data }
const symbolsInflight = new Map<string, Promise<SymbolsPayload>>();     // file -> Promise<data>
function loadSymbols(file: string): Promise<SymbolsPayload> {
  const hit = cacheGet(symbolsCache, file, TTL_SYMBOLS * staleFactor());
  if (hit) return Promise.resolve(hit);
  const running = symbolsInflight.get(file);
  if (running) return running;
  const p = (async () => {
    try {
      const out = await run(['node', '-f', file, '--symbols-only']);
      const symbols: SymbolsPayload['symbols'] = [];
      for (const m of out.matchAll(/^- `([^`]+)` \(([^)]+)\)(?:.*?) — :(\d+)$/gm)) {
        symbols.push({ name: m[1], kind: m[2], line: Number(m[3]) });
      }
      // codegraph 符号表硬上限 200，超出时输出 `- … +N more`；透出给前端提示
      const more = out.match(/^- … \+(\d+) more$/m);
      const data: SymbolsPayload = { file, symbols, total: more ? symbols.length + Number(more[1]) : symbols.length, truncated: !!more };
      cacheSet(symbolsCache, file, data, 300);
      return data;
    } finally {
      symbolsInflight.delete(file); // 失败也要清，下次重试而不是把错误也缓存住
    }
  })();
  symbolsInflight.set(file, p);
  return p;
}

function invalidateAll(): void {
  searchCache.clear();
  graphCache.clear();
  traceCache.clear();
  kindCache.clear();
  kindFailedAt.clear();
  filesCache.at = 0; filesCache.data = null;
  symbolsCache.clear();
  routeParser.invalidate();
  urlMapper.invalidate();
  symbolResolver.clear();
}

// ===== 代码变更检测：watch 项目目录，提示「索引可能过期」 =====
let indexStale = false;
let staleFile = null;
let reindexState = { running: false, lastAt: 0 };
// Windows/网络盘上 fs.watch 会对「仅元数据变化」（atime/属性位/杀软扫描/同步工具）报 change，
// mtime 也不可靠（实测存在 mtime 比当前时间还晚的脏数据）。改用内容哈希甄别：
// 启动后异步为源码文件建 sha1 基线，watch 事件只有内容哈希真变了才提示过期。
const fileHashes = new Map(); // 相对路径 -> sha1
let hashBaselineReady = false;
const IGNORE_WATCH = /(^|[\\/])(\.git|\.codegraph|node_modules|vendor|dist|build|out|\.next|\.nuxt|\.idea|\.vscode|coverage|logs?|tmp|temp)([\\/]|$)/;
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|go|php|py|java|rs|vue|svelte)$/;
function hashFileContent(abs: string): string | null {
  try { return createHash('sha1').update(readFileSync(abs)).digest('hex'); } catch { return null; }
}
// 异步遍历建基线（不阻塞服务启动；大项目几秒级）
setImmediate(() => {
  const t0 = Date.now();
  const stack = [''];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(join(ROOT, dir || '.'), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const rel = dir ? dir + '\\' + e.name : e.name;
      if (e.isDirectory()) { if (!IGNORE_WATCH.test(rel + '\\')) stack.push(rel); continue; }
      if (!SOURCE_EXT.test(e.name)) continue;
      const h = hashFileContent(join(ROOT, rel));
      if (h) fileHashes.set(rel, h);
    }
  }
  hashBaselineReady = true;
  console.log(`[watch] 哈希基线就绪：${fileHashes.size} 个源码文件，耗时 ${Date.now() - t0}ms`);});
try {
  let debounce = null;
  watch(ROOT, { recursive: true }, (event, filename) => {
    if (!filename || indexStale || reindexState.running) return;
    // 只有源码文件变更才提示过期——日志/缓存/IDE 文件变更不该惊动用户
    if (IGNORE_WATCH.test(filename) || !SOURCE_EXT.test(filename)) return;
    const abs = join(ROOT, filename);
    const h = hashFileContent(abs);
    const base = fileHashes.get(filename);
    if (base === undefined) {
      // 基线未就绪时的早期事件只记录不告警；就绪后出现的未知文件 = 新建源码文件，算真实变更
      if (h) fileHashes.set(filename, h);
      if (!hashBaselineReady || h === null) return;
    } else if (h === base) {
      return; // 内容未变（仅元数据/mtime 变化），忽略
    } else {
      fileHashes.set(filename, h); // 内容真变了：更新基线
    }
    clearTimeout(debounce);
    debounce = setTimeout(() => { indexStale = true; staleFile = filename; }, 500);
  });
} catch { /* 平台不支持 recursive watch 时静默降级（仅无过期提示） */ }

// 轻量路由表：稳定的独立接口在这里声明，复杂业务 handler 可继续渐进迁移。
// 每个条目只负责匹配和响应，主请求函数不再堆叠这些基础分支。
const routeTable: RouteDef[] = [
  // 业务 API 目录：handler 为空的条目由兼容分支处理，便于后续逐个抽取而不改变响应行为。
  // 新增接口必须先登记到这里，避免路由散落且无法盘点。
  ...[
    '/api/search', '/api/graph', '/api/implementations', '/api/routes', '/api/route',
    '/api/reindex', '/api/urlmap', '/api/trace/stream', '/api/symbols', '/api/source', '/api/files',
  ].map(path => ({ method: 'GET', path, handler: null })),
  {
    method: 'GET', path: '/_health',
    handler: (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('{"ok":true}');
    },
  },
  { method: 'GET', path: '/api/repos', handler: async (req, res) => json(req, res, 200, await discoverRepos()) },
  {
    method: 'GET', path: '/api/status',
    handler: (req, res) => json(req, res, 200, {
      stale: indexStale, staleFile, reindexing: reindexState.running,
      bundled: useBundled, exposed: EXPOSED, readOnly: READ_ONLY,
      root: ROOT, // 前端用它把相对路径补成绝对路径（vscode://file/ 打开文件）
    }),
  },
];
function findRoute(method: string, path: string): RouteDef | null {
  return routeTable.find(route => route.method === method && route.path === path) || null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  try {
    const route = findRoute(req.method || 'GET', path);
    // 已登记但尚未抽取的兼容路由继续落入下方旧 handler；只有具备 handler 的条目在此直接分发。
    if (route && route.handler) return await route.handler(req, res, url);

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
      const cached = cacheGet(searchCache, cacheKey, TTL_SEARCH * staleFactor());
      if (cached) return json(req, res, 200, cached);
      // 搜索放宽超时并允许重试一次：大项目首次 query 要冷启动 codegraph，30s 不够
      const out = await run(['query', q, '--json', '-l', useRegex ? '200' : '40'], { timeout: 60000, retries: 1 });
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
      // 缓存：点同一个节点、展开→撤销→再展开都会重复请求同一个 (symbol,file)，
      // 每次都要跑 1–3 次 CLI，命中后基本免费（TTL 30s，stale 减半，reindex 失效）。
      // 缓存里只放「由 node -f 的 Trail 得到的主结果」——邻居 kind 不进去，见下方合并逻辑。
      const gkey = sym + '|' + file;
      let data = cacheGet(graphCache, gkey, TTL_GRAPH * staleFactor());
      if (!data) {
        if (file) {
          const nodeRaw = await run(['node', sym, '-f', file]);
          const dropImport = (c) => c && !isImportRef(c.name);
          data = {
            symbol: sym,
            kind: parseNodeKind(nodeRaw),
            line: parseNodeLine(nodeRaw),
            callers: parseTrail(nodeRaw, 'Called by ←').filter(dropImport),
            callees: parseTrail(nodeRaw, 'Calls →').filter(dropImport),
            source: nodeRaw,
          };
        } else {
          const [callersRaw, calleesRaw, nodeRaw] = await Promise.all([
            run(['callers', sym, '--json', '-l', '40']),
            run(['callees', sym, '--json', '-l', '40']),
            run(['node', sym]),
          ]);
          const callers = parseJson(callersRaw, {}).callers || [];
          const callees = parseJson(calleesRaw, {}).callees || [];
          data = { symbol: sym, kind: parseNodeKind(nodeRaw), line: parseNodeLine(nodeRaw), callers, callees, source: nodeRaw };
        }
        cacheSet(graphCache, gkey, data, 300);
      }
      // 邻居 kind 合并：只有 file 分支需要（Trail 文本不含 kind；非 file 分支的 --json 本就带）。
      // kind 来自另一次可失败/可超时的查询、且单独缓存，所以这里每次都尝试合并——不烤进上面那份
      // 缓存，否则冷启动那一次拿不到 kind 的结果会把「无 kind」冻结一整个 TTL。
      // 另外：--json 返回的是所有同名符号的合并结果，文件精确的邻居未必在其中，
      // 所以「部分邻居有 kind、部分为 null」是正常降级，不是 bug。
      if (file) {
        const kinds = await kindsFor(sym);
        if (kinds && kinds.size) {
          const withKind = (c) => ({ ...c, kind: kinds.get(normPath(c.filePath) + '::' + c.name) || c.kind });
          return json(req, res, 200, { ...data, callers: data.callers.map(withKind), callees: data.callees.map(withKind) });
        }
      }
      return json(req, res, 200, data);
    }
    // 查找接口/抽象方法的实现：查询同名候选，返回 class/method/function 实现项
    if (path === '/api/implementations') {
      const sym = safeArg(url.searchParams.get('symbol'));
      if (!sym) return json(req, res, 400, { error: 'missing ?symbol=' });
      const file = safeFile((url.searchParams.get('file') || '').trim());
      const short = sym.split(/::|\\/).pop();
      const queries = [...new Set([sym, short])];
      const found = new Map();
      for (const q of queries) {
        try {
          const list = parseJson(await run(['query', q, '--json', '-l', '200']), []);
          for (const row of list) {
            const n = row && row.node;
            if (!n || !n.name || !['class', 'method', 'function', 'interface'].includes(n.kind)) continue;
            if (file && n.filePath === file && n.name === short) continue;
            const text = `${n.name} ${n.qualifiedName || ''}`.toLowerCase();
            if (!text.includes(short.toLowerCase())) continue;
            const key = `${n.filePath || ''}::${n.qualifiedName || n.name}`;
            found.set(key, { name: n.name, qualifiedName: n.qualifiedName || n.name, kind: n.kind, filePath: n.filePath || '', startLine: n.startLine || null });
          }
        } catch { /* 未初始化或查询失败时返回空实现列表 */ }
      }
      return json(req, res, 200, [...found.values()].slice(0, 100));
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
    // 重新建立索引：single-flight + 5s 冷却，防连点/并发写坏索引；--read-only 模式禁用
    if (path === '/api/reindex') {
      if (READ_ONLY) return json(req, res, 403, { error: '只读模式（--read-only）下禁止重建索引' });
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
      // 链路展开要跑几十次 CLI（实测单次 5s 起），同一组参数重复展开直接回放结果。
      // 取消产生的部分结果不缓存（它取决于断开时机，不该被当成完整链路复用）。
      const tkey = [sym, file, depth, maxNodes, direction].join('|');
      const thit = cacheGet(traceCache, tkey, TTL_TRACE * staleFactor());
      if (thit) { send('result', thit); if (!closed) res.end(); return; }
      try {
        const result = await traceChain({ run, root: ROOT, resolveSourceCalls: symbolResolver.resolveSourceCalls }, sym, file, {
          depth, maxNodes, direction,
          isCancelled: () => closed,
          onProgress: (p) => send('progress', p),
        });
        if (!result.cancelled) cacheSet(traceCache, tkey, result, 50);
        send('result', result);
      } catch (e) {
        send('error', { error: String((e && e.message) || e) });
      }
      if (!closed) res.end();
      return;
    }
    // 文件内的符号列表（60s 缓存 + 同文件并发合流，见 loadSymbols）
    if (path === '/api/symbols') {
      const file = safeFile((url.searchParams.get('file') || '').trim());
      if (!file) return json(req, res, 400, { error: 'missing or invalid ?file=' });
      return json(req, res, 200, await loadSymbols(file));
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
      if (filesCache.data && Date.now() - filesCache.at < TTL_FILES * staleFactor()) return json(req, res, 200, filesCache.data);
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
server.on('error', (e: NodeJS.ErrnoException) => {
  if (e && e.code === 'EADDRINUSE') {
    console.log(`[错误] 端口 ${PORT} 已被占用，换个端口重试，例如: cgv view ${PORT + 1}`);
  } else {
    console.log('[错误] 服务启动失败:', (e && e.message) || e);
  }
  process.exit(1);
});
server.listen(PORT, HOST, async () => {
  const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
  if (JSON_OUT) {
    // 结构化输出：脚本用 await readiness 后 JSON.parse(stdout) 即可拿到端口与状态
    console.log(JSON.stringify({ ok: true, url, port: PORT, host: HOST, root: ROOT, exposed: EXPOSED, pid: process.pid }));
  } else {
    console.log(`CodeGraph Viz: ${url}  (项目: ${ROOT})`);
    if (EXPOSED) console.log(`[警告] 服务绑定在 ${HOST}，局域网/外部可访问本机源码与接口，仅在可信网络使用`);
    if (READ_ONLY) console.log('[只读模式] reindex 接口已禁用，适合部署到公共地址分享');
  }
  // 启动探测：确认 codegraph 可用并记录版本。
  // 注意：输出格式漂移告警（textparse.warnIfFormatDrift）只在链路展开解析时触发，不在这里。
  try {
    const v = (await run(['--version'], { timeout: 10000 })).trim().split('\n')[0];
    if (v && !JSON_OUT) console.log(`codegraph: ${v}${useBundled ? ' (bundled)' : ' (PATH)'}`);
  } catch (e) {
    if (!JSON_OUT) console.log('[警告] codegraph 不可用：' + ((e && e.message) || e) + '，搜索/调用图将失败');
  }
});
