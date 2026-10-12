// 前端纯函数测试：不引入 jsdom（保持零依赖），用 node:vm + 最小 DOM stub 载入 public/app.js。
//
// 做法说明：app.js 是经典脚本（非 module），顶层 `function` 声明会成为脚本全局对象的属性，
// 但 `const`/`let` 不会。所以在源码末尾追加一段「导出垫片」，用同一脚本作用域把需要的绑定
// 挂到 globalThis.__app 上再执行——这样无需改动 app.js 本身，也无需构建。
//
// 覆盖重点：图算法（路径/可达集）、连线几何、URL/堆栈解析、HTML 转义（防 XSS）、SSE 生命周期。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import vm from 'node:vm';

const APP_PATH = dirname(fileURLToPath(import.meta.url)) + '/../public/app.js';

// 需要从脚本作用域取出的绑定（必须是 app.js 里真实存在的名字）
const EXPORTS = [
  // 纯函数
  'nodeKey', 'edgePath', 'findPath', 'reachableSet', 'isNoise', 'shouldShow', 'nodeBox',
  'vscodeUrl', 'parseStackFrames', 'highlightCode', 'highlightLine', 'renderGroupedHits',
  'esc', 'escAttr', 'badge',
  // 图状态与操作
  'graph', 'pathHL', 'posOverride', 'KIND_LABEL',
  'addNode', 'addEdge', 'clearGraphEdges', 'snapshotGraph', 'restoreSnapshot',
  // 链路（SSE）
  'startTrace', 'cancelTrace',
];

function makeCtxStub() {
  const ctx2d = {
    clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fillRect() {}, strokeRect() {},
    fillStyle: '', strokeStyle: '', lineWidth: 1,
  };
  const el = {
    style: { setProperty() {}, removeProperty() {} },
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {},
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    appendChild() {}, insertBefore() {}, remove() {}, after() {},
    querySelector() { return makeEl(); }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { x: 0, y: 0, width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600 }; },
    getScreenCTM() { return null; },
    cloneNode() { return makeEl(); },
    getContext() { return ctx2d; },
    focus() {}, blur() {}, select() {}, scrollIntoView() {}, click() {},
    textContent: '', innerHTML: '', value: '', checked: false,
    width: 168, height: 118, clientWidth: 800, clientHeight: 600, offsetWidth: 100, offsetHeight: 60,
    title: '', href: '', download: '',
    firstChild: null, nextElementSibling: null, parentNode: null,
  };
  return el;
}
function makeEl() { return makeCtxStub(); }

const documentEl = makeEl();

// 记录 EventSource 实例，供 SSE 测试手动派发事件
const esInstances = [];
class StubEventSource {
  constructor(url) {
    this.url = url;
    this.readyState = 1; // OPEN
    this.closed = false;
    this.retried = 0;
    this.listeners = new Map();
    esInstances.push(this);
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  close() { this.closed = true; this.readyState = 2; }
  // 测试用：派发一个事件
  emit(type, data) {
    for (const fn of this.listeners.get(type) || []) fn(data === undefined ? {} : { data: JSON.stringify(data) });
  }
}
StubEventSource.CLOSED = 2;
StubEventSource.CONNECTING = 0;

const fetchCalls = [];
function stubFetch(url) {
  fetchCalls.push(String(url));
  const body = String(url).includes('/api/status') ? { root: '/fake/root' } : [];
  return Promise.resolve({ ok: true, status: 200, json: async () => body });
}

function makeSandbox() {
  const sandbox = {
    console,
    document: {
      querySelector: () => makeEl(),
      querySelectorAll: () => [],
      getElementById: () => makeEl(),
      createElement: () => makeEl(),
      createElementNS: () => makeEl(),
      addEventListener() {},
      documentElement: documentEl,
      body: makeEl(),
      styleSheets: [],
    },
    window: {
      addEventListener() {}, innerWidth: 1600, innerHeight: 900, open() {},
      history: { replaceState() {}, pushState() {} },
      location: { hash: '', href: 'http://127.0.0.1:3999/', pathname: '/', origin: 'http://127.0.0.1:3999' },
    },
    location: { hash: '', href: 'http://127.0.0.1:3999/', pathname: '/', origin: 'http://127.0.0.1:3999' },
    navigator: { clipboard: { writeText: async () => {} } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    requestAnimationFrame: () => 0,
    // 定时器一律空实现：避免测试进程被 setInterval / notice 的自动隐藏吊住
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    CSS: { escape: (s) => String(s).replace(/["\\\]]/g, '\\$&') },
    // vm 上下文只有 ECMAScript 内建，Web/Node 全局要显式注入（app.js 用到 URLSearchParams 等）
    URL, URLSearchParams, TextEncoder, TextDecoder,
    Blob: class { constructor() {} },
    Image: class { constructor() { this.onload = null; this.onerror = null; } },
    DOMPoint: class { constructor(x, y) { this.x = x; this.y = y; } },
    XMLSerializer: class { serializeToString() { return ''; } },
    fetch: stubFetch,
    EventSource: StubEventSource,
    getComputedStyle: () => ({ backgroundColor: '#000' }),
  };
  sandbox.window.document = sandbox.document;
  sandbox.window.localStorage = sandbox.localStorage;
  sandbox.globalThis = sandbox;
  return sandbox;
}

// 载入一次（各测试共用同一份图状态，测试之间用 clearGraphEdges 复位）
const src = readFileSync(APP_PATH, 'utf8')
  + `\n;globalThis.__app = { ${EXPORTS.join(', ')} };`;
const ctx = vm.createContext(makeSandbox());
vm.runInContext(src, ctx, { filename: 'public/app.js' });
const app = ctx.__app;

// app.js 末尾的启动逻辑（loadRepos/loadFiles/checkStale）是异步的，先让它们跑完再测
await new Promise((r) => setImmediate(r));
await new Promise((r) => setImmediate(r));

// ===== 基础辅助 =====
test('app.js 能在纯 Node 环境载入并导出待测绑定', () => {
  for (const name of EXPORTS) assert.ok(app[name] !== undefined, `缺少导出：${name}`);
});

test('nodeKey 拼接 file 与符号名', () => {
  assert.equal(app.nodeKey('getList', 'src/a.ts'), 'src/a.ts::getList');
  assert.equal(app.nodeKey('orphan', null), 'orphan');
});

// ===== 连线几何（Dify 风格：锚点必须落在卡片侧边中点） =====
test('edgePath 从左向右：起于源卡右边中点、止于目标卡左边内缩 3px', () => {
  const pa = { x: 0, y: 0 }, pb = { x: 300, y: 0 };
  const ba = { w: 200 }, bb = { w: 160 };
  assert.equal(app.edgePath(pa, pb, ba, bb, false, 0), 'M 100 0 C 158.5 0, 158.5 0, 217 0');
});

test('edgePath 从右向左：方向翻转，锚点落在卡片左侧边', () => {
  const pa = { x: 300, y: 0 }, pb = { x: 0, y: 0 };
  const ba = { w: 200 }, bb = { w: 160 };
  assert.equal(app.edgePath(pa, pb, ba, bb, false, 0), 'M 200 0 C 141.5 0, 141.5 0, 83 0');
});

test('edgePath 回边走上方绕行（Q 曲线），且不同 edgeIndex 弧度错开', () => {
  const pa = { x: 0, y: 0 }, pb = { x: 200, y: 0 };
  const ba = { w: 100 }, bb = { w: 100 };
  const a = app.edgePath(pa, pb, ba, bb, true, 0);
  const b = app.edgePath(pa, pb, ba, bb, true, 1);
  assert.match(a, /^M .* Q /);
  assert.notEqual(a, b, '并行回边应错开弧度，避免重叠');
});

// ===== 图算法 =====
function buildGraph(edges) {
  const g = app.graph;
  g.nodes.clear();
  app.clearGraphEdges();
  app.posOverride.clear();
  const keys = new Map();
  const node = (id) => {
    if (!keys.has(id)) keys.set(id, app.addNode(id, `src/${id}.ts`).key);
    return keys.get(id);
  };
  for (const [a, b] of edges) app.addEdge(node(a), node(b));
  return keys;
}

test('findPath 有向 BFS 求最短调用路径', () => {
  const keys = buildGraph([['A', 'B'], ['B', 'C'], ['A', 'C']]);
  const found = app.findPath(keys.get('A'), keys.get('C'));
  // vm 上下文里构造的数组原型与本测试 realm 不同，比较前先归一成本 realm 的数组
  assert.deepEqual(Array.from(found.nodes), [keys.get('A'), keys.get('C')], '应取最短路径 A→C，而不是绕经 B');
  assert.equal(found.edges.length, 1);
  assert.equal(app.findPath(keys.get('C'), keys.get('A')), null, '反向不可达应返回 null');
});

test('findPath 同节点返回单点路径', () => {
  const keys = buildGraph([['A', 'B']]);
  const self = app.findPath(keys.get('A'), keys.get('A'));
  assert.deepEqual({ nodes: Array.from(self.nodes), edges: Array.from(self.edges) }, { nodes: [keys.get('A')], edges: [] });
});

// reachableSet 必须是有向的：A→B、C→B、D→C 时，从 A 出发不该顺着 B 把「B 的其他调用者」
// 以及它们上游一起拉进来（否则高扇出中心会把全图点亮）
test('reachableSet 有向可达集，不把旁路上游带回', () => {
  const keys = buildGraph([['A', 'B'], ['C', 'B'], ['D', 'C']]);
  const set = app.reachableSet(keys.get('A'));
  assert.ok(set.has(keys.get('A')));
  assert.ok(set.has(keys.get('B')), '下游应包含');
  assert.ok(!set.has(keys.get('C')), 'B 的其它调用者 C 属于旁路，不该包含');
  assert.ok(!set.has(keys.get('D')), '更不该顺着 C 继续往上带');
});

// ===== 噪音过滤 =====
test('isNoise 识别压缩文件/依赖目录/编译产物', () => {
  assert.ok(app.isNoise({ file: 'src/utils/vendorLib.min.js' }));
  assert.ok(app.isNoise({ file: 'proj/node_modules/lib/a.js' }));
  assert.ok(app.isNoise({ file: 'proj/vendor/pkg/b.php' }));
  assert.ok(app.isNoise({ file: 'proj/dist/out.js' }));
  assert.ok(app.isNoise({ file: 'external/sdk.js' }));
  assert.ok(!app.isNoise({ file: 'src/service/example/ExampleService.ts' }));
});

test('shouldShow：中心节点始终显示，噪音节点受开关控制', () => {
  const g = app.graph;
  g.nodes.clear(); app.clearGraphEdges();
  const center = app.addNode('main', 'src/main.ts');
  const noise = app.addNode('junk', 'proj/dist/junk.js');
  g.centerKey = noise.key;
  assert.ok(app.shouldShow(noise.key), '中心节点即使是噪音也必须显示');
  g.centerKey = center.key;
  assert.ok(!app.shouldShow(noise.key), '噪音开关关闭时不显示噪音节点');
  assert.ok(app.shouldShow(center.key));
  g.centerKey = null;
});

// ===== 快照 / 撤销 =====
test('snapshot/restore 回滚边集与手工拖动位置', () => {
  const keys = buildGraph([['A', 'B']]);
  app.posOverride.set(keys.get('A'), { x: 11, y: 22, layer: 0 });
  const snap = app.snapshotGraph();
  // 展开：新增节点与边，并拖动 A 到别处
  app.addNode('Z', 'src/Z.ts');
  app.addEdge(keys.get('A'), keys.get('Z'));
  app.posOverride.set(keys.get('A'), { x: 999, y: 999, layer: 0 });
  app.restoreSnapshot(snap);
  assert.equal(app.graph.nodes.has(app.nodeKey('Z', 'src/Z.ts')), false, '新增节点应被回滚');
  assert.deepEqual(app.posOverride.get(keys.get('A')), { x: 11, y: 22, layer: 0 }, '拖动手工位置应一并回滚');
});

// ===== 编辑器 URL =====
test('vscodeUrl 把相对路径补成绝对路径并做转义', () => {
  assert.equal(
    app.vscodeUrl('src/a.ts', 42, 'F:\\projects\\nextjs-app'),
    'vscode://file/f:/projects/nextjs-app/src/a.ts:42',
  );
  assert.equal(app.vscodeUrl('src/a b/c.ts', 7, 'F:\\x'), 'vscode://file/f:/x/src/a%20b/c.ts:7');
  // 已是绝对路径则原样使用（盘符转小写）
  assert.equal(app.vscodeUrl('F:/x/y.ts', 3, '/proj'), 'vscode://file/f:/x/y.ts:3');
});

// ===== 堆栈解析 =====
test('parseStackFrames 提取 file:line 并过滤依赖/产物目录', () => {
  const stack = [
    'Error: boom',
    '    at getItemList (src/api/room.ts:42:8)',
    '    at handler (src/server.ts:18:3)',
    '    at x (/proj/node_modules/pkg/index.js:1:1)',
    '    at y (vendor/lib/a.php:9)',
    '    at z (dist/bundle.js:5)',
    '    at getItemList (src/api/room.ts:42:8)', // 重复
  ].join('\n');
  const frames = app.parseStackFrames(stack);
  assert.deepEqual(Array.from(frames, (f) => `${f.file}:${f.line}`), ['src/api/room.ts:42', 'src/server.ts:18']);
});

// ===== 转义（防 XSS，前端全部靠 innerHTML 拼串） =====
test('esc/escAttr 转义 HTML 元字符', () => {
  assert.equal(app.esc('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(app.esc('a & "b"'), 'a &amp; &quot;b&quot;');
  // escAttr 只用于双引号属性值：转义 & 和 " 就足以阻止属性逃逸（< > 在属性内无害）
  assert.equal(app.escAttr('"><script>'), '&quot;><script>');
});

test('highlightCode 逐段 token 化后仍完整转义', () => {
  const out = app.highlightCode('const a = "<script>alert(1)</script>"; // x');
  assert.ok(!out.includes('<script>'), '字符串里的标签必须被转义');
  assert.ok(out.includes('&lt;script&gt;'));
  assert.ok(out.includes('tok-str'), '字符串应有高亮 class');
  assert.ok(out.includes('tok-com'), '注释应有高亮 class');
  assert.ok(out.includes('tok-kw'), '关键字应有高亮 class');
});

test('renderGroupedHits 按类型分组并转义符号名', () => {
  const html = app.renderGroupedHits([
    { name: 'a', kind: 'method', filePath: 'src/a.ts', startLine: 1 },
    { name: '"><img src=x>', kind: 'class', filePath: 'src/b.ts', startLine: 2 },
  ]);
  assert.ok(html.includes('方法'), '应有方法分组标题');
  assert.ok(html.includes('类'), '应有类分组标题');
  assert.ok(html.includes('(1)'), '分组应带计数');
  // 文本节点必须完整转义；属性值里 escAttr 会把 " 转成 &quot;，所以不能出现能闭合属性的序列
  assert.ok(html.includes('&lt;img src=x&gt;'), '文本节点里的符号名必须转义');
  assert.ok(!html.includes('"><img'), '属性值不得被引号逃逸');
});

// ===== 节点卡片尺寸 =====
test('nodeBox 宽度钳制在 150–248，高度随入度增长（热点视图关闭时固定 56）', () => {
  const short = app.nodeBox({ key: 'k1', label: 'ab', file: 'src/a.ts' });
  const long = app.nodeBox({ key: 'k2', label: 'x'.repeat(80), file: 'src/a.ts' });
  assert.equal(short.w, 150);
  assert.equal(long.w, 248);
  assert.equal(short.h, 56);
});

// ===== SSE 链路生命周期 =====
test('startTrace：收到 result 立即关闭连接，不会让 EventSource 自动重连', () => {
  esInstances.length = 0;
  app.startTrace('getItemList', 'getItemList', 'src/a.ts', 'down');
  const es = esInstances.at(-1);
  assert.ok(es, '应创建 EventSource');
  assert.match(es.url, /^\/api\/trace\/stream\?/);
  // direction=down 是服务端默认值，前端不显式传；up 才带参数（见下一个测试）
  assert.ok(!es.url.includes('direction='), '向下展开不该传 direction');
  assert.equal(es.closed, false);
  es.emit('result', { nodes: [{ name: 'getItemList', filePath: 'src/a.ts', kind: 'method' }], edges: [], symbol: 'getItemList', depth: 0 });
  assert.equal(es.closed, true, 'result 后必须 close，否则流结束后 EventSource 会自动重连再跑一次链路');
});

test('startTrace：连接级 error 也关闭连接，且 settled 保证只处理一次', () => {
  esInstances.length = 0;
  app.startTrace('foo', 'foo', 'src/f.ts', 'down');
  const es = esInstances.at(-1);
  es.readyState = StubEventSource.CLOSED;
  es.emit('error');
  assert.equal(es.closed, true, '连接中断后应关闭，避免自动重连重复跑链路');
  const events = es.listeners.get('error').length;
  assert.equal(events, 1);
  // 再补一个 result（异常时序）不应改变状态：settled 已置位
  es.emit('result', { nodes: [], edges: [] });
  assert.equal(es.closed, true);
});

test('cancelTrace 关闭进行中的 EventSource', () => {
  esInstances.length = 0;
  app.startTrace('bar', 'bar', 'src/b.ts', 'up');
  const es = esInstances.at(-1);
  assert.match(es.url, /direction=up/, '向上展开应显式传 direction=up');
  assert.equal(es.closed, false);
  app.cancelTrace(true);
  assert.equal(es.closed, true);
});
