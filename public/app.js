const $ = (s) => document.querySelector(s);
const svg = $('#svg');
const viewport = $('#viewport');
const NS = 'http://www.w3.org/2000/svg';
const g = (tag, attrs) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  return el;
};
const KIND_LABEL = { function:'函数', method:'方法', class:'类', interface:'接口', type:'类型', property:'属性', variable:'变量', route:'路由' };
const KIND_CLASS = { function:'function', method:'method', class:'class', interface:'interface', type:'type', property:'property', variable:'variable', route:'route' };

// ===== 图数据模型（支持多级展开）=====
const SEP = '';
const graph = { nodes: new Map(), edges: new Set(), centerKey: null };
const history = [];
const expandStack = []; // 展开撤销栈：每次点击节点展开前保存图快照
let allFiles = [];
let viewTransform = { x: 0, y: 0, k: 1 };
let expanding = false;
let showNoise = false; // 噪音节点开关：默认关闭=过滤不显示，打开=全部显示
try { showNoise = localStorage.getItem('cgv-noise') === '1'; } catch (e) { /* 隐私模式忽略 */ }
let renderAllNodes = false; // 大图精简渲染：默认只渲染靠近中心的前 MAX_VISIBLE 个节点，角标可切换显示全部

// 噪音节点规则（通用模式，跨语言跨项目生效）：
//  - 压缩/混淆文件 .min.js/.min.ts
//  - 依赖目录：node_modules / vendor / 第三方包
//  - 编译产物：dist / build / out / target / .next / .nuxt
//  - 外部引入目录：external / third_party
// 注意：不写死具体项目路径（如 src/lib/db），避免在其他语言项目误伤业务代码。
const NOISE_RE = /(\.min\.(?:js|ts)$|\/node_modules\/|\/vendor\/|\/(?:dist|build|out|target|\.next|\.nuxt)\/|^external\/|\/external\/|\/third_party\/)/;
function isNoise(node) { return node && node.file && NOISE_RE.test(node.file); }
// 某节点是否应显示（中心始终显示；开关关闭时过滤噪音）
function shouldShow(key) {
  if (showNoise || key === graph.centerKey) return true;
  const n = graph.nodes.get(key);
  return n ? !isNoise(n) : false;
}

function nodeKey(name, file) { return (file ? file + '::' : '') + name; }
function addNode(name, file, kind, line) {
  const key = nodeKey(name, file);
  if (!graph.nodes.has(key)) graph.nodes.set(key, { key, name, label: name, query: name, file, kind, line: line || null, expanded: false });
  return graph.nodes.get(key);
}
// 邻接表：addEdge 时同步维护，callersOf/calleesOf 由 O(n) 全边扫描降为 O(1) 取表
const adjIn = new Map();  // key -> Set<callerKey>
const adjOut = new Map(); // key -> Set<calleeKey>
function adjAdd(map, a, b) { if (!map.has(a)) map.set(a, new Set()); map.get(a).add(b); }
function addEdge(aKey, bKey) {
  if (aKey === bKey || graph.edges.has(aKey + SEP + bKey)) return;
  graph.edges.add(aKey + SEP + bKey);
  adjAdd(adjOut, aKey, bKey);
  adjAdd(adjIn, bKey, aKey);
}
function callersOf(key) { return adjIn.has(key) ? [...adjIn.get(key)] : []; }
function calleesOf(key) { return adjOut.has(key) ? [...adjOut.get(key)] : []; }
function neighborsOf(key) { return callersOf(key).concat(calleesOf(key)); }
function clearGraphEdges() {
  graph.edges.clear();
  adjIn.clear(); adjOut.clear();
}

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function escAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }
function badge(kind) {
  const label = KIND_LABEL[kind] || (kind || '符号');
  return `<span class="badge k-${KIND_CLASS[kind] || 'property'}">${esc(label)}</span>`;
}

function notice(msg) {
  const el = $('#notice');
  el.classList.remove('info');
  if (!msg) { el.style.display = 'none'; return; }
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(notice._t);
  notice._t = setTimeout(() => { el.style.display = 'none'; }, 4500);
}
// 加载提示：一直显示直到 clearLoading()，区别于会自动消失的报错
let progressTimer = null; // 顶部进度条递增定时器
function loading(msg) {
  const el = $('#notice');
  clearTimeout(notice._t);
  el.classList.add('info');
  el.textContent = '⏳ ' + msg;
  el.style.display = 'block';
  // 顶部进度条：显示并模拟递增至 90%，结束时在 clearLoading 补到 100%
  const pf = $('#progressBarFill');
  $('#progressBar').style.display = 'block';
  pf.style.opacity = '1';
  let w = 0;
  pf.style.width = '2%';
  clearInterval(progressTimer);
  progressTimer = setInterval(() => {
    if (w < 90) w = Math.min(90, w + Math.random() * 14 + 4); // 快速逼近 90%
    else w = Math.min(99, w + 0.4); // 90% 后极慢爬升，保证进度条一直在动、明确"仍在加载"
    pf.style.width = w + '%';
  }, 350);
}
function clearLoading() {
  const el = $('#notice');
  if (el.classList.contains('info')) { el.classList.remove('info'); el.style.display = 'none'; }
  // 进度条完成：冲到 100% 后淡出隐藏，复位等待下一次
  const pf = $('#progressBarFill');
  clearInterval(progressTimer);
  pf.style.width = '100%';
  setTimeout(() => {
    const bar = $('#progressBar');
    if (bar.style.display !== 'none') { bar.style.display = 'none'; pf.style.width = '0%'; }
  }, 450);
}

async function api(path, params, opts) {
  const url = '/api' + path + (params ? '?' + new URLSearchParams(params) : '');
  const res = await fetch(url, opts && opts.signal ? { signal: opts.signal } : undefined);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ===== 最近搜索（localStorage，最多 12 条，datalist 下拉提示） =====
function loadRecent() {
  try { return JSON.parse(localStorage.getItem('cgv-recent') || '[]'); } catch { return []; }
}
function saveRecent(q) {
  try {
    const list = loadRecent().filter(x => x !== q);
    list.unshift(q);
    localStorage.setItem('cgv-recent', JSON.stringify(list.slice(0, 12)));
    renderRecent();
  } catch { /* 隐私模式忽略 */ }
}
function renderRecent() {
  $('#recentList').innerHTML = loadRecent().map(q => `<option value="${escAttr(q)}">`).join('');
}

// ===== 缩放/平移 =====
function applyTransform() { viewport.setAttribute('transform', `translate(${viewTransform.x.toFixed(2)}, ${viewTransform.y.toFixed(2)}) scale(${viewTransform.k.toFixed(4)})`); }
function updateZoomLevel() { $('#zoomLevel').textContent = Math.round(viewTransform.k * 100) + '%'; }
function resetView() { viewTransform = { x: 0, y: 0, k: 1 }; applyTransform(); updateZoomLevel(); }
function zoomBy(factor, cx, cy) {
  const rect = svg.getBoundingClientRect();
  const px = cx == null ? rect.width / 2 : cx;
  const py = cy == null ? rect.height / 2 : cy;
  const newK = Math.max(0.05, Math.min(20, viewTransform.k * factor));
  viewTransform.x = px - (px - viewTransform.x) * (newK / viewTransform.k);
  viewTransform.y = py - (py - viewTransform.y) * (newK / viewTransform.k);
  viewTransform.k = newK;
  applyTransform();
  updateZoomLevel();
}
let panning = false, panStart = null, panOrigin = null, didPan = false;
svg.addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  panning = true; didPan = false;
  panStart = { x: e.clientX, y: e.clientY };
  panOrigin = { x: viewTransform.x, y: viewTransform.y };
  svg.classList.add('dragging');
});
window.addEventListener('mousemove', e => {
  if (!panning) return;
  if (Math.abs(e.clientX - panStart.x) + Math.abs(e.clientY - panStart.y) > 4) didPan = true;
  viewTransform.x = panOrigin.x + (e.clientX - panStart.x);
  viewTransform.y = panOrigin.y + (e.clientY - panStart.y);
  applyTransform();
});
window.addEventListener('mouseup', () => { panning = false; svg.classList.remove('dragging'); setTimeout(() => { didPan = false; }, 0); });
svg.addEventListener('wheel', e => { e.preventDefault(); const r = svg.getBoundingClientRect(); zoomBy(e.deltaY < 0 ? 1.15 : 0.87, e.clientX - r.left, e.clientY - r.top); }, { passive: false });
$('#zoomIn').onclick = () => zoomBy(1.25);
$('#zoomOut').onclick = () => zoomBy(0.8);
$('#zoomReset').onclick = resetView;

function showPanel(name) {
  $('#filePanel').style.display = name === 'files' ? 'flex' : 'none';
  $('#results').style.display = name === 'results' ? 'flex' : 'none';
}

async function doSearch() {
  const q = $('#q').value.trim();
  if (!q) return;
  loading('正在搜索：' + q);
  try {
    // 输入以 / 开头（如 /api/activity/DanceImage/list）时按接口 URL 定位
    if (q.startsWith('/')) { saveRecent(q); return searchByUrl(q); }
    const kind = $('#kindFilter').value;
    const params = { q };
    if (kind && kind !== 'all') params.kind = kind;
    if ($('#chkRegex').checked) params.regex = '1';
    const hits = await api('/search', params);
    saveRecent(q);
    showPanel('results');
    $('#resultsTitle').textContent = '🔍 搜索结果';
    $('#resultsSub').textContent = `「${q}」共 ${hits.length} 个匹配，点击查看调用图 · 右侧「⧉ 链路」展开全部方法链`;
    $('#resultsBody').innerHTML = hits.length
      ? hits.map(h =>
        `<div class="hit" data-symbol="${escAttr(h.qualifiedName || h.name)}" data-name="${escAttr(h.name)}" data-file="${escAttr(h.filePath)}">
           <div class="row1">${badge(h.kind)}<span class="nm" title="${escAttr(h.name)}">${esc(h.name)}</span><span class="trace-btn" title="点击=向下展开它调用的全部方法链 · Shift+点击=向上展开谁调用了它">⧉ 链路</span></div>
           <div class="meta" title="${escAttr(h.filePath + ':' + h.startLine)}">${esc(h.filePath)}:${h.startLine}</div>
         </div>`).join('')
      : '<div class="hit">没有匹配的符号</div>';
    bindHits($('#resultsBody'));
    updateHeaderInfo(`${hits.length} 个搜索结果`);
    clearLoading();
  } catch (e) { notice('搜索失败：' + e.message); clearLoading(); }
}

// 接口 URL / 页面路由定位：/api/xxx/yyy → 匹配 route.ts 接口文件；/xxx/yyy → 匹配 app 目录下 page.tsx 页面
// 支持：动态路由段（/api/user/123 → [id]/route.ts，/group/come → 忽略 (admin) 路由组）、剥离 query/hash
// 模糊降级：精确匹配无结果时自动模糊匹配（输入部分片段如 /api/room → 列出所有相关接口/页面）
async function searchByUrl(urlPath) {
  loading('正在定位路由：' + urlPath);
  // 1) 先尝试 Laravel/PHP 路由精确定位（/api/route），命中则展示 handler 方法
  try {
    const routeHits = await api('/route', { url: urlPath });
    if (routeHits && routeHits.length) { renderRouteHits('路由定位', urlPath, routeHits); return; }
  } catch (e) { /* 路由定位不可用则退回文件匹配 */ }
  const files = await api('/files');
  // 剥离 query 与 hash，去掉首尾 /
  const pathOnly = urlPath.replace(/[?#].*$/, '').replace(/^\/+/, '').replace(/\/+$/, '');
  let segs = pathOnly.split('/').filter(Boolean);
  if (segs[0] && segs[0].toLowerCase() === 'api') segs.shift();
  if (!segs.length) { notice('路径不完整，例如：/api/room/list 或 /group/come'); return; }
  // 2) 接口文件严格匹配：文件路径按 api/ 之后逐段比对，[xxx] 动态段视为通配
  const exact = matchRouteFiles(files, segs);
  if (exact.length) { renderFileHits('接口定位', urlPath, exact, '接口文件'); return; }
  // 3) 页面路由严格匹配：app/ 之后逐段比对，忽略 (xxx) 路由组，[xxx] 动态段通配
  const pages = matchPageFiles(files, segs);
  if (pages.length) { renderFileHits('页面定位', urlPath, pages, '页面文件'); return; }
  // 3.5) 自定义 route-map 规则定位（任意框架，如 youpai 的 /youpai/xxx.html → ctlXxx.php::funcXxx）
  try {
    const urlHits = await api('/urlmap', { url: urlPath });
    if (urlHits && urlHits.length) {
      const h = urlHits[0];
      renderRouteHits('路由定位', urlPath, [{ method: 'URL', url: urlPath, handler: h.name, name: h.name, filePath: h.filePath, line: h.line }]);
      return;
    }
  } catch (e) { /* route-map 不可用则继续 */ }
  // 4) 精确匹配无结果 → 模糊匹配：路由 URL / 文件路径包含输入片段即命中
  loading('精确匹配无结果，尝试模糊匹配：' + urlPath);
  try {
    const fuzzyRoutes = await api('/route', { url: urlPath, fuzzy: '1' });
    if (fuzzyRoutes && fuzzyRoutes.length) { renderRouteHits('路由模糊匹配', urlPath, fuzzyRoutes); return; }
  } catch (e) { /* 模糊路由不可用则退回文件模糊匹配 */ }
  const fzSegs = segs.map(s => s.toLowerCase());
  // 4a) 接口文件模糊
  const fzApi = files.filter(f => {
    const p = (f.path || '').replace(/\\/g, '/').toLowerCase();
    if (!p.includes('api/') || !p.endsWith('route.ts')) return false;
    let idx = -1; // 输入各段按顺序出现在文件路径中
    return fzSegs.every(s => (idx = p.indexOf(s, idx + 1)) >= 0);
  }).slice(0, 20);
  if (fzApi.length) { renderFileHits('接口模糊匹配', urlPath, fzApi, '接口文件'); return; }
  // 4b) 页面文件模糊
  const fzPage = files.filter(f => {
    const rel = pageSegsOf(f.path);
    if (!rel) return false;
    const base = rel.join('/').toLowerCase();
    let idx = -1; // 输入各段按顺序出现在页面路径段中
    return fzSegs.every(s => (idx = base.indexOf(s, idx + 1)) >= 0);
  }).slice(0, 30);
  if (fzPage.length) { renderFileHits('页面模糊匹配', urlPath, fzPage, '页面文件'); return; }
  renderFileHits('路径定位', urlPath, []);
}

// route.ts 文件严格匹配：段数一致 + [xxx] 动态段通配
function matchRouteFiles(files, segs) {
  return files.filter(f => {
    const p = (f.path || '').replace(/\\/g, '/');
    const pSegs = p.split('/');
    const apiIdx = pSegs.findIndex(s => s === 'api');
    if (apiIdx < 0) return false;
    const rel = pSegs.slice(apiIdx + 1); // api/ 之后的全部段（含 route.ts）
    if (rel[rel.length - 1] !== 'route.ts') return false;
    const relSegs = rel.slice(0, -1); // 去掉 route.ts
    if (relSegs.length !== segs.length) return false;
    return relSegs.every((rs, i) => rs === segs[i] || (/^\[.*\]$/.test(rs) && !!segs[i]));
  });
}

// 提取页面路由路径段：src/app/<path>/page.tsx，忽略 (路由组)，排除 api 目录，[xxx] 动态段保留
function pageSegsOf(filePath) {
  const p = (filePath || '').replace(/\\/g, '/');
  const pSegs = p.split('/');
  const appIdx = pSegs.findIndex(s => s === 'app');
  if (appIdx < 0) return null;
  const rel = pSegs.slice(appIdx + 1);
  if (rel[rel.length - 1] !== 'page.tsx') return null;
  const segs = rel.slice(0, -1).filter(s => !/^\(.+\)$/.test(s)); // 去掉 (xxx) 路由组
  if (!segs.length || segs[0] === 'api') return null;
  return segs;
}

// 页面路由严格匹配：段数一致 + [xxx] 动态段通配
function matchPageFiles(files, segs) {
  return files.filter(f => {
    const rel = pageSegsOf(f.path);
    if (!rel) return false;
    if (rel.length !== segs.length) return false;
    return rel.every((rs, i) => rs === segs[i] || (/^\[.*\]$/.test(rs) && !!segs[i]));
  });
}

// Laravel 路由结果渲染
function renderRouteHits(title, urlPath, hits) {
  showPanel('results');
  $('#resultsTitle').textContent = '🔍 ' + title;
  $('#resultsSub').textContent = `「${urlPath}」匹配 ${hits.length} 条路由，点击查看调用图 · 右侧「⧉ 链路」展开全部方法链`;
  $('#resultsBody').innerHTML = hits.map(h =>
    `<div class="hit" data-symbol="${escAttr(h.name)}" data-name="${escAttr(h.name)}" data-file="${escAttr(h.filePath)}">
       <div class="row1">${badge('route')}<span class="nm" title="${escAttr(h.method + ' ' + h.url + ' → ' + h.handler)}">${esc(h.method)} ${esc(h.url)} → ${esc(h.handler)}</span><span class="trace-btn" title="点击=向下展开该路由方法调用的全部链路 · Shift+点击=向上">⧉ 链路</span></div>
       <div class="meta" title="${escAttr(h.filePath + ':' + h.line + ' · ' + h.name)}">${esc(h.filePath)}:${h.line} · ${esc(h.name)}</div>
     </div>`).join('');
  bindHits($('#resultsBody'));
  updateHeaderInfo(`${title}：${hits.length} 个匹配`);
  clearLoading();
}

// 接口/页面文件结果渲染
function renderFileHits(title, urlPath, hits, kind = '接口文件') {
  showPanel('results');
  $('#resultsTitle').textContent = '🔍 ' + title;
  $('#resultsSub').textContent = `「${urlPath}」匹配到 ${hits.length} 个${kind}，点击查看调用图 · 右侧「⧉ 链路」展开全部方法链`;
  $('#resultsBody').innerHTML = hits.length
    ? hits.map(f => {
        const nm = (f.path || '').split('/').pop();
        return `<div class="hit" data-symbol="${escAttr(nm)}" data-name="${escAttr(nm)}" data-file="${escAttr(f.path)}">
          <div class="row1">${badge('route')}<span class="nm" title="${escAttr(f.path)}">${esc(f.path)}</span><span class="trace-btn" title="点击=向下展开该文件符号的全部调用链路 · Shift+点击=向上">⧉ 链路</span></div>
          <div class="meta">${kind} · ${f.nodeCount} 个符号</div>
        </div>`;
      }).join('')
    : '<div class="hit">未找到匹配的文件，可尝试直接用符号名搜索</div>';
  bindHits($('#resultsBody'));
  updateHeaderInfo(`${title}：${hits.length} 个匹配`);
  clearLoading();
}

// 统一绑定搜索结果/文件符号的命中项：主体点击=单层图，⧉ 按钮=全链路（Shift+点击=向上链路）
function bindHits(root) {
  resFocusReset();
  root.querySelectorAll('.hit[data-symbol]').forEach(el => {
    el.onclick = () => startGraph(el.dataset.symbol, el.dataset.name, el.dataset.file);
    const tb = el.querySelector('.trace-btn');
    if (tb) tb.onclick = (e) => { e.stopPropagation(); startTrace(el.dataset.symbol, el.dataset.name, el.dataset.file, e.shiftKey ? 'up' : 'down'); };
  });
}

function updateCrumbs() {
  $('#crumbs').innerHTML = history.map((h, i) => {
    const label = esc(h.symbol);
    if (i === history.length - 1) return `<b>${label}</b>`;
    return `<span data-idx="${i}">${label}</span> → `;
  }).join('');
  $('#crumbs').querySelectorAll('span[data-idx]').forEach(el => {
    el.onclick = () => {
      const idx = Number(el.dataset.idx);
      const item = history[idx];
      if (!item) return;
      history.length = idx + 1;
      recenter(item.key, item.symbol, item.file);
    };
  });
}
function updateHeaderInfo(text) { $('#headerInfo').textContent = text || ''; }

// ===== URL 状态：当前图写入 location.hash，刷新/分享链接可恢复 =====
// 格式：#g=symbol&f=file（单层图）或 #t=symbol&f=file&d=up（链路图）
let hashGuard = false; // 自己写 hash 时不触发 hashchange 恢复
function saveHash() {
  const h = history[history.length - 1];
  hashGuard = true;
  if (!h) { window.history.replaceState(null, '', location.pathname); hashGuard = false; return; }
  const p = new URLSearchParams();
  p.set(h.trace ? 't' : 'g', h.symbol);
  if (h.file) p.set('f', h.file);
  if (h.direction === 'up') p.set('d', 'up');
  window.history.replaceState(null, '', '#' + p.toString());
  setTimeout(() => { hashGuard = false; }, 0);
}
function restoreFromHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  const g = h.get('g'), t = h.get('t');
  const f = h.get('f') || null;
  const shortName = (s) => s.split('::').pop();
  if (t) startTrace(t, shortName(t), f, h.get('d') === 'up' ? 'up' : 'down');
  else if (g) startGraph(g, shortName(g), f);
}
window.addEventListener('hashchange', () => { if (!hashGuard) restoreFromHash(); });
// 一键复制分享链接：当前 hash 即图状态（中心符号/文件/链路方向），打开即恢复
$('#btnShareLink').onclick = () => copyText(location.href, '已复制分享链接');

// ===== 源码语法高亮：轻量 tokenizer，注释/字符串/数字/关键字/函数调用 =====
const KW = new Set(('function class return if else elif elseif for while foreach do switch case default break continue new delete typeof instanceof ' +
  'const let var public private protected static readonly abstract final async await yield import from export extends implements interface type enum namespace use as ' +
  'try catch finally throw throws func package go defer chan struct map range select nil true false null nil none self this super echo print require include_once require_once include ' +
  'fn let mut impl trait pub mod crate where match loop move ref box dyn async await').split(/\s+/));
const TOKEN_RE = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*)|('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)|(\b[A-Za-z_]\w*(?=\s*\())|(\b[A-Za-z_]\w*\b)/g;
function highlightCode(code) {
  let out = '', last = 0;
  for (const m of code.matchAll(TOKEN_RE)) {
    out += esc(code.slice(last, m.index));
    const [tok, com, str, num, fn, word] = m;
    if (com != null) out += `<span class="tok-com">${esc(com)}</span>`;
    else if (str != null) out += `<span class="tok-str">${esc(str)}</span>`;
    else if (num != null) out += `<span class="tok-num">${esc(num)}</span>`;
    else if (fn != null) out += KW.has(fn) ? `<span class="tok-kw">${esc(fn)}</span>` : `<span class="tok-fn">${esc(fn)}</span>`;
    else if (word != null) out += KW.has(word) ? `<span class="tok-kw">${esc(word)}</span>` : esc(word);
    last = m.index + tok.length;
  }
  return out + esc(code.slice(last));
}

let curSource = { symbol: '', file: '', raw: '' }; // 当前源码面板内容（复制按钮用）
function showSource(data, file) {
  $('#src').style.display = 'flex';
  $('#srcTitle').textContent = '📄 ' + data.symbol;
  $('#srcSub').textContent = file || '';
  const raw = data.source || '';
  curSource = { symbol: data.symbol || '', file: file || '', raw };
  // 优先提取代码块做高亮；无代码块（提示文本）则原样显示
  const m = raw.match(/```[\w-]*\n([\s\S]*?)```/);
  $('#srcBody').innerHTML = m ? highlightCode(m[1].replace(/\n$/, '')) : esc(raw || '（无源码信息）');
}
async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* 忽略 */ }
    ta.remove();
  }
  notice(okMsg);
}
$('#btnCopySrc').onclick = () => {
  const m = curSource.raw.match(/```[\w-]*\n([\s\S]*?)```/);
  copyText(m ? m[1] : curSource.raw, '已复制源码');
};
$('#btnCopyPath').onclick = () => copyText(curSource.file || curSource.symbol, '已复制路径');

// 把一次 /api/graph 结果并入图模型（过滤 import 引用与类型节点，保持图干净）
function isImportRef(name) { return /^(@\/|\.\/|\.\.\/|\/|node:)/.test(name); }
const GRAPH_SKIP_KIND = new Set(['import', 'interface', 'type']);
function isRefNoise(c) { return c && (GRAPH_SKIP_KIND.has(c.kind) || isImportRef(c.name)); }
function integrate(data, key) {
  for (const c of data.callers || []) { if (isRefNoise(c)) continue; const n = addNode(c.name, c.filePath, c.kind, c.startLine); addEdge(n.key, key); }
  for (const c of data.callees || []) { if (isRefNoise(c)) continue; const n = addNode(c.name, c.filePath, c.kind, c.startLine); addEdge(key, n.key); }
}

// 全新开始：以 symbol 为中心。query 用于 API（可为限定名），name+file 用于节点键
async function startGraph(query, name, file) {
  loading('正在加载调用图：' + name);
  try {
    const data = await api('/graph', file ? { symbol: query, file } : { symbol: query });
    graph.nodes.clear(); clearGraphEdges();
    expandStack.length = 0;
    const center = addNode(name, file || null, null);
    center.query = query;
    center.expanded = true;
    graph.centerKey = center.key;
    integrate(data, center.key);
    // 默认展开一层：直接邻居标记为已展开（实线框），首次加载即能看到完整一层调用关系
    for (const k of neighborsOf(center.key)) {
      const n = graph.nodes.get(k);
      if (n) n.expanded = true;
    }
    history.push({ symbol: data.symbol, file, key: center.key, trace: false });
    updateCrumbs();
    saveHash();
    showSource(data, file);
    relayout();
    resetView();
    clearLoading();
  } catch (e) { notice('加载调用图失败：' + e.message); }
}

// 全链路：递归展开某符号的调用链（direction=down 向下它调谁 / up 向上谁调它），SSE 流式进度，可取消
let traceES = null; // 进行中的 EventSource，取消/重置时关闭
function cancelTrace(silent) {
  if (traceES) { traceES.close(); traceES = null; if (!silent) notice('已取消链路展开'); clearLoading(); }
}
function traceLoading(msg) {
  const el = $('#notice');
  clearTimeout(notice._t);
  el.classList.add('info');
  el.innerHTML = '⏳ ' + esc(msg) + ' <button class="secondary cancel-trace" id="btnCancelTrace">取消</button>';
  el.style.display = 'block';
  $('#btnCancelTrace').onclick = () => cancelTrace();
}
function startTrace(query, name, file, direction = 'down') {
  cancelTrace(true);
  const dirLabel = direction === 'up' ? '上游链路（谁调用了它）' : '全链路';
  traceLoading(`正在展开${dirLabel}：${name || query}`);
  // SSE 进度：后端每处理完一批节点推送一次，进度条按已发现节点数爬升
  const pf = $('#progressBarFill');
  $('#progressBar').style.display = 'block';
  pf.style.opacity = '1';
  pf.style.width = '2%';
  clearInterval(progressTimer);
  let dynMax = 20;
  const driveProgress = (n) => {
    dynMax = Math.max(dynMax, n * 1.15 + 3);
    const target = Math.min(95, (n / dynMax) * 95);
    const cur = parseFloat(pf.style.width) || 0;
    pf.style.width = Math.max(target, Math.min(95, cur + 0.5)) + '%';
  };
  const params = new URLSearchParams({ symbol: query });
  if (file) params.set('file', file);
  if (direction === 'up') params.set('direction', 'up');
  const es = new EventSource('/api/trace/stream?' + params.toString());
  traceES = es;
  let settled = false; // result/error 任一到达后忽略后续事件（连接关闭也会触发 error，避免误报）
  es.addEventListener('progress', (e) => {
    try {
      const p = JSON.parse(e.data);
      driveProgress(p.nodes || 0);
      $('#notice').innerHTML = `⏳ 正在展开${dirLabel}：${esc(name || query)} · 已加载 ${p.nodes || 0} 个节点 <button class="secondary cancel-trace" id="btnCancelTrace">取消</button>`;
      $('#btnCancelTrace').onclick = () => cancelTrace();
    } catch { /* 进度事件解析失败忽略 */ }
  });
  es.addEventListener('result', (e) => {
    if (settled) return;
    settled = true;
    es.close(); traceES = null;
    let data;
    try { data = JSON.parse(e.data); } catch { notice('链路数据解析失败'); clearLoading(); return; }
    if (!data.nodes || !data.nodes.length) { notice('未找到可展开的调用链路'); clearLoading(); return; }
    graph.nodes.clear(); clearGraphEdges();
    expandStack.length = 0;
    const refs = data.nodes.map(n => addNode(n.name, n.filePath, n.kind));
    for (const [a, b] of data.edges || []) {
      if (refs[a] && refs[b]) addEdge(refs[a].key, refs[b].key);
    }
    const center = refs[0];
    center.query = query;
    center.expanded = true;
    graph.centerKey = center.key;
    // 有出边的节点已随链路展开；叶子保持可点击继续展开
    for (const n of refs) {
      if (n.key !== center.key && calleesOf(n.key).length > 0) n.expanded = true;
    }
    history.push({ symbol: data.symbol, file, key: center.key, trace: true, direction });
    updateCrumbs();
    saveHash();
    showSource(data, file);
    relayout();
    resetView();
    clearLoading();
    updateHeaderInfo(`${document.querySelector('#headerInfo').textContent} · ${direction === 'up' ? '上游链' : '链路'}深度 ${data.depth}${data.truncated ? ' · ⚠ 已截断' : ''}${data.cancelled ? ' · 已取消（部分结果）' : ''}`);
  });
  es.addEventListener('error', (e) => {
    if (settled) return;
    settled = true;
    // 服务端业务错误以 error 事件下发；连接级错误 EventSource 会自动重试，这里只在有数据时报错
    if (e.data) {
      try { notice('全链路展开失败：' + (JSON.parse(e.data).error || '未知错误')); }
      catch { notice('全链路展开失败'); }
    } else if (es.readyState === EventSource.CLOSED) {
      notice('全链路展开失败：连接中断');
    }
    es.close(); traceES = null;
    clearLoading();
  });
}

// 保留现有图，仅切换中心（面包屑用）。切中心后撤销栈失效，清空避免错乱。
function recenter(key, symbol, file) {
  expandStack.length = 0;
  if (graph.nodes.has(key)) { graph.centerKey = key; relayout(); }
  else startGraph(symbol, symbol, file);
}

// 当前图状态快照（用于展开撤销）。节点需浅拷贝，避免展开时改动的 expanded 等状态污染快照。
function snapshotGraph() {
  const nodes = new Map();
  for (const [k, n] of graph.nodes) nodes.set(k, { ...n });
  return { nodes, edges: new Set(graph.edges), centerKey: graph.centerKey };
}
function restoreSnapshot(snap) {
  graph.nodes = snap.nodes;
  graph.edges = snap.edges;
  graph.centerKey = snap.centerKey;
  // 快照只存了边集合，邻接索引需按边集重建
  adjIn.clear(); adjOut.clear();
  for (const e of graph.edges) {
    const i = e.indexOf(SEP);
    const a = e.slice(0, i), b = e.slice(i + 1);
    adjAdd(adjOut, a, b);
    adjAdd(adjIn, b, a);
  }
}
// 撤销最近一次展开，恢复展开前的图
function undoExpand() {
  const snap = expandStack.pop();
  if (!snap) { notice('没有可撤销的展开'); return; }
  restoreSnapshot(snap);
  relayout(); // relayout 内部会更新状态栏
}

// 点击节点：展开它的调用关系并入图
async function expandNode(key) {
  const node = graph.nodes.get(key);
  if (!node || expanding) return;
  expanding = true;
  const snap = snapshotGraph(); // 展开前快照：成功入栈供撤销，失败恢复现场
  loading('正在展开：' + node.name);
  try {
    const data = await api('/graph', node.file ? { symbol: node.query || node.name, file: node.file } : { symbol: node.query || node.name });
    expandStack.push(snap);
    if (expandStack.length > 20) expandStack.shift();
    node.expanded = true;
    integrate(data, key);
    showSource(data, node.file);
    relayout();
    // 高亮本次展开新增的节点，让用户清楚看到"展开到了哪里"
    const addedKeys = [...graph.nodes.keys()].filter(k => !snap.nodes.has(k));
    if (addedKeys.length) {
      addedKeys.forEach(ak => {
        const el = document.querySelector(`#viewport .node[data-key="${CSS.escape(ak)}"]`);
        if (el) el.classList.add('newly');
      });
    }
    clearLoading();
    const addedCount = graph.nodes.size - snap.nodes.size;
    // 只有 graph 接口本身就没返回任何调用者/被调用者，才算"真没有更多"；
    // 否则即使新增为 0，也只是因为 trace/之前的展开已经把邻居全部加进来了，不应误导用户。
    const noRelations = !(data.callers && data.callers.length) && !(data.callees && data.callees.length);
    if (noRelations) notice('该节点没有更多调用关系');
    else if (addedCount === 0) notice('该节点的调用关系已全部展开');
  } catch (e) {
    restoreSnapshot(snap);
    relayout();
    notice('展开失败，已恢复：' + e.message);
  }
  finally { expanding = false; }
}

// 展开上层（调用它的）：与 expandNode 同流程，但只并入 callers，不展开 callees
async function expandCallers(key) {
  const node = graph.nodes.get(key);
  if (!node || expanding) return;
  expanding = true;
  const snap = snapshotGraph();
  loading('正在展开上层：' + node.name);
  try {
    const data = await api('/graph', node.file ? { symbol: node.query || node.name, file: node.file } : { symbol: node.query || node.name });
    expandStack.push(snap);
    if (expandStack.length > 20) expandStack.shift();
    node.expanded = true;
    // 只并入调用者侧，避免「展开上层」把它的被调用者也带进来
    for (const c of data.callers || []) { if (isRefNoise(c)) continue; const n = addNode(c.name, c.filePath, c.kind, c.startLine); addEdge(n.key, key); }
    relayout();
    const added = graph.nodes.size - snap.nodes.size;
    notice(added ? `已展开 ${added} 个调用者` : '没有更多调用者');
    clearLoading();
  } catch (e) {
    restoreSnapshot(snap);
    relayout();
    notice('展开失败，已恢复：' + e.message);
  }
  finally { expanding = false; }
}

// ===== 布局：从中心 BFS 分层，左调用者右被调用者 =====
function layoutGraph() {
  const layerOf = new Map([[graph.centerKey, 0]]);
  const q = [graph.centerKey];
  while (q.length) {
    const u = q.shift();
    const L = layerOf.get(u);
    for (const v of callersOf(u)) if (!layerOf.has(v) && shouldShow(v)) { layerOf.set(v, L - 1); q.push(v); }
    for (const v of calleesOf(u)) if (!layerOf.has(v) && shouldShow(v)) { layerOf.set(v, L + 1); q.push(v); }
  }
  const byLayer = new Map();
  for (const [k, L] of layerOf) { if (!byLayer.has(L)) byLayer.set(L, []); byLayer.get(L).push(k); }
  const pos = new Map();
  const CX = 0, CY = 0, colW = 250, rowH = 56;
  const order = [...byLayer.keys()].sort((a, b) => Math.abs(a) - Math.abs(b) || a - b);
  const innerY = (k, innerL) => {
    if (innerL == null) return CY;
    const ys = neighborsOf(k).filter(n => layerOf.get(n) === innerL && pos.has(n)).map(n => pos.get(n).y);
    return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : CY;
  };
  for (const L of order) {
    const nodes = byLayer.get(L);
    const innerL = L < 0 ? L + 1 : (L > 0 ? L - 1 : null);
    nodes.sort((a, b) => innerY(a, innerL) - innerY(b, innerL));
    const x = CX + L * colW;
    let y = CY - ((nodes.length - 1) * rowH) / 2;
    for (const k of nodes) { pos.set(k, { x, y, layer: L }); y += rowH; }
  }
  return pos;
}

function nodeClass(node, layer) {
  if (node.key === graph.centerKey) return 'center';
  if (layer < 0) return 'caller';
  if (layer > 0) return 'callee';
  return 'callee';
}

function relayout() {
  if (!graph.centerKey || graph.nodes.size === 0) return;
  const pos = layoutGraph();
  viewport.innerHTML = '';

  // 大图防卡顿：节点过多时只渲染靠近中心的部分（MAX_VISIBLE），其余以角标提示
  const MAX_VISIBLE = 150;
  const allKeys = [...pos.keys()].sort((a, b) => Math.abs(pos.get(a).layer) - Math.abs(pos.get(b).layer));
  const visibleKeys = renderAllNodes ? allKeys : allKeys.slice(0, MAX_VISIBLE);
  const hiddenCount = allKeys.length - visibleKeys.length;
  const visibleSet = new Set(visibleKeys);

  // 箭头标记
  const defs = g('defs', {});
  const mkMarker = (id, cls) => { const m = g('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 9, markerHeight: 9, orient: 'auto-start-reverse' }); m.appendChild(g('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: cls })); return m; };
  defs.appendChild(mkMarker('arr', 'marker-arr'));
  defs.appendChild(mkMarker('arrIn', 'marker-arrIn'));
  defs.appendChild(mkMarker('arrOut', 'marker-arrOut'));
  viewport.appendChild(defs);

  // 边（两端都可见才画，避免指向未渲染节点）
  let edgeCount = 0;
  for (const e of graph.edges) {
    const i = e.indexOf(SEP);
    const a = e.slice(0, i), b = e.slice(i + 1);
    if (!visibleSet.has(a) || !visibleSet.has(b)) continue;
    const pa = pos.get(a), pb = pos.get(b);
    if (!pa || !pb) continue;
    edgeCount++;
    let cls = 'edge', marker = 'arr';
    if (b === graph.centerKey) { cls += ' to-center'; marker = 'arrIn'; }
    else if (a === graph.centerKey) { cls += ' from-center'; marker = 'arrOut'; }
    // 回边（指向同层或上层的边）= 调用环/回调，橙色虚线提示
    if (pb.layer <= pa.layer) cls += ' cycle';
    if (pathHL.edges.has(a + SEP + b)) cls += ' on-path';
    const dx = pb.x - pa.x, dy = pb.y - pa.y;
    const len = Math.hypot(dx, dy) || 1;
    const off = 100; // 节点半宽余量
    const x2 = pb.x - (dx / len) * Math.min(off, len * 0.4);
    const y2 = pb.y - (dy / len) * Math.min(off * 0.2, len * 0.4);
    viewport.appendChild(g('line', { x1: pa.x, y1: pa.y, x2, y2, 'class': cls, 'marker-end': `url(#${marker})`, 'data-a': a, 'data-b': b }));
  }

  // 节点
  for (const key of visibleKeys) {
    const node = graph.nodes.get(key);
    const el = mkNode(node, pos.get(key));
    if (pathHL.nodes.has(key)) el.setAttribute('class', el.getAttribute('class') + ' on-path');
    viewport.appendChild(el);
  }

  // 视野适配（按可见节点）
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  for (const key of visibleKeys) {
    const p = pos.get(key);
    minX = Math.min(minX, p.x - 130); maxX = Math.max(maxX, p.x + 130);
    minY = Math.min(minY, p.y - 30); maxY = Math.max(maxY, p.y + 30);
  }
  const pad = 30;
  const vb = { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
  svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  lastLayout = { pos, vb, visibleKeys }; // minimap 用

  $('#empty').style.display = 'none';
  const hidden = graph.nodes.size - pos.size;
  // 角标：点击切换「显示全部 / 精简渲染」
  const badge = $('#moreBadge');
  if (hiddenCount > 0) {
    badge.textContent = renderAllNodes ? `显示全部 ${allKeys.length} 个 · 点击恢复精简` : `+${hiddenCount} more · 点击显示全部`;
    badge.style.display = 'block';
  } else {
    badge.style.display = 'none';
  }
  updateHeaderInfo(`${visibleKeys.length} 个节点 · ${edgeCount} 条连线${hidden > 0 ? ` · 已过滤 ${hidden} 个` : ''}${hiddenCount > 0 ? ` · ${hiddenCount} 个未渲染` : ''}`);
  hoverKey = null; // DOM 已重建，旧 hover 状态失效；下次 mouseover 重新触发
  if (clickKey && graph.nodes.has(clickKey)) applyChainHighlight(clickKey); // 点击固定的高亮重放
  else applyHighlight(); // 重建 DOM 后重放节点高亮搜索
  drawMinimap();
}

function mkNode(node, p) {
  const label = node.label;
  const w = Math.min(220, Math.max(96, label.length * 7 + 30));
  const cls = nodeClass(node, p.layer) + (node.expanded || node.key === graph.centerKey ? '' : ' leaf');
  const grp = g('g', { 'class': 'node ' + cls, style: `--tx:${p.x}px; --ty:${p.y}px`, 'data-key': node.key });
  grp.appendChild(g('rect', { x: -w / 2, y: -19, width: w, height: 38 }));
  const t = g('text', { x: 0, y: 4, 'text-anchor': 'middle' });
  t.textContent = label.length > 24 ? label.slice(0, 23) + '…' : label;
  grp.appendChild(t);
  if (!node.expanded && node.key !== graph.centerKey) {
    const plus = g('text', { x: w / 2 - 12, y: -8, 'class': 'plus', 'text-anchor': 'middle' });
    plus.textContent = '+';
    grp.appendChild(plus);
  }
  // 悬浮提示：始终提供（大图省略「点击展开」行以减小体积）
  if (graph.nodes.size <= 200) {
    const title = g('title', {});
    title.textContent = `${label}\n${node.file || ''}${node.kind ? ' [' + (KIND_LABEL[node.kind] || node.kind) + ']' : ''}${node.expanded ? '' : '\n点击展开它的调用关系'}`;
    grp.appendChild(title);
  } else {
    const title = g('title', {});
    title.textContent = `${label}\n${node.file || ''}${node.kind ? ' [' + (KIND_LABEL[node.kind] || node.kind) + ']' : ''}`;
    grp.appendChild(title);
  }

  if (node.key === graph.centerKey) {
    grp.onclick = () => { /* 中心：源码已在右侧 */ clickKey = node.key; applyChainHighlight(clickKey); };
  } else {
    grp.onclick = (e) => { e.stopPropagation(); if (!didPan) { clickKey = node.key; applyChainHighlight(clickKey); expandNode(node.key); } };
    grp.ondblclick = (e) => { e.stopPropagation(); if (!didPan) { history.push({ symbol: node.name, file: node.file, key: node.key }); expandStack.length = 0; graph.centerKey = node.key; node.expanded = true; updateCrumbs(); relayout(); notice('已切换中心，展开历史已重置'); } };
  }
  return grp;
}

// ===== minimap 概览图：节点缩略 + 当前视口框，点击跳转 =====
let lastLayout = null; // { pos, vb, visibleKeys }，relayout 时更新
let minimapScheduled = false;
function drawMinimap() {
  if (minimapScheduled) return;
  minimapScheduled = true;
  requestAnimationFrame(() => {
    minimapScheduled = false;
    const cv = $('#minimap');
    if (!lastLayout || graph.nodes.size < 12) { cv.style.display = 'none'; return; }
    cv.style.display = 'block';
    const ctx = cv.getContext('2d');
    const { pos, vb, visibleKeys } = lastLayout;
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    const s = Math.min(W / vb.w, H / vb.h) * 0.92;
    const ox = (W - vb.w * s) / 2 - vb.x * s;
    const oy = (H - vb.h * s) / 2 - vb.y * s;
    // 节点点
    for (const key of visibleKeys) {
      const p = pos.get(key);
      if (!p) continue;
      if (key === graph.centerKey) ctx.fillStyle = '#fbbf24';
      else if (p.layer < 0) ctx.fillStyle = '#34d399';
      else ctx.fillStyle = '#60a5fa';
      ctx.fillRect(ox + p.x * s - 1.5, oy + p.y * s - 1.5, 3, 3);
    }
    // 当前视口框：屏幕可视区反算到图坐标（含 viewBox 居中 letterbox 偏移）
    const rect = svg.getBoundingClientRect();
    const svb = Math.min(rect.width / vb.w, rect.height / vb.h);
    const offX = (rect.width - vb.w * svb) / 2;
    const offY = (rect.height - vb.h * svb) / 2;
    const vx = (vb.x + (0 - offX) / svb - viewTransform.x) / viewTransform.k;
    const vy = (vb.y + (0 - offY) / svb - viewTransform.y) / viewTransform.k;
    const vw = rect.width / svb / viewTransform.k;
    const vh = rect.height / svb / viewTransform.k;
    ctx.strokeStyle = 'rgba(96,165,250,.9)';
    ctx.lineWidth = 1.2;
    ctx.strokeRect(ox + vx * s, oy + vy * s, vw * s, vh * s);
  });
}
// 点击 minimap：把对应位置居中到视口
$('#minimap').addEventListener('click', (e) => {
  if (!lastLayout) return;
  const { vb } = lastLayout;
  const cv = $('#minimap');
  const rc = cv.getBoundingClientRect();
  const W = cv.width, H = cv.height;
  const s = Math.min(W / vb.w, H / vb.h) * 0.92;
  const ox = (W - vb.w * s) / 2 - vb.x * s;
  const oy = (H - vb.h * s) / 2 - vb.y * s;
  const px = ((e.clientX - rc.left) - ox) / s; // 图坐标
  const py = ((e.clientY - rc.top) - oy) / s;
  const rect = svg.getBoundingClientRect();
  const svb = Math.min(rect.width / vb.w, rect.height / vb.h);
  const offX = (rect.width - vb.w * svb) / 2;
  const offY = (rect.height - vb.h * svb) / 2;
  // 目标：图点 (px,py) 经 group 变换后再经 viewBox 映射落在屏幕中心
  viewTransform.x = vb.x + (rect.width / 2 - offX) / svb - px * viewTransform.k;
  viewTransform.y = vb.y + (rect.height / 2 - offY) / svb - py * viewTransform.k;
  applyTransform();
});
// 视口变化时同步 minimap 视口框（包装 applyTransform，避免到处改调用点）
const _applyTransform = applyTransform;
applyTransform = function () { _applyTransform(); drawMinimap(); };

// ===== 节点右键菜单：以此为中心 / 展开下层 / 展开上层 / 复制路径 / 在编辑器打开 =====
const ctxMenu = $('#ctxMenu');
function hideCtx() { ctxMenu.style.display = 'none'; }
function showCtx(key, x, y) {
  const node = graph.nodes.get(key);
  if (!node) return;
  const isCenter = key === graph.centerKey;
  const items = [
    { label: '🎯 以此为中心', act: () => { history.push({ symbol: node.name, file: node.file, key }); expandStack.length = 0; graph.centerKey = key; node.expanded = true; updateCrumbs(); relayout(); } },
    !isCenter && !node.expanded && { label: '⤵ 展开下层（它调用的）', act: () => expandNode(key) },
    !isCenter && { label: '⤴ 展开上层（调用它的）', act: () => expandCallers(key) },
    { sep: true },
    node.file && { label: '⧉ 复制文件路径', act: () => copyText(node.file, '已复制路径') },
    node.file && { label: '↗ 在编辑器打开', act: () => { window.open(`vscode://file/${node.file.replace(/\\/g, '/')}:${node.line || 1}`); } },
  ].filter(Boolean);
  ctxMenu.innerHTML = items.map((it, i) => it.sep ? '<div class="ctx-sep"></div>' : `<div class="ctx-item" data-i="${i}">${it.label}</div>`).join('');
  ctxMenu.querySelectorAll('.ctx-item').forEach(el => { el.onclick = () => { hideCtx(); items[Number(el.dataset.i)].act(); }; });
  ctxMenu.style.display = 'block';
  const tw = ctxMenu.offsetWidth, th = ctxMenu.offsetHeight;
  ctxMenu.style.left = Math.min(x, innerWidth - tw - 8) + 'px';
  ctxMenu.style.top = Math.min(y, innerHeight - th - 8) + 'px';
}
// 事件委托：relayout 重建 DOM 后无需重新绑定；任意点击/Esc 关闭
viewport.addEventListener('contextmenu', (e) => {
  const n = e.target.closest && e.target.closest('.node');
  if (!n || !n.dataset.key) return hideCtx();
  e.preventDefault();
  showCtx(n.dataset.key, e.clientX, e.clientY);
});
window.addEventListener('click', hideCtx);
window.addEventListener('blur', hideCtx);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCtx(); });

// ===== 路径查找：依次点两个节点，BFS 有向最短路径并高亮（Esc/再点按钮退出） =====
const pathHL = { nodes: new Set(), edges: new Set() };
let pathMode = false;
let pathSrcKey = null;
function clearPath() {
  pathMode = false; pathSrcKey = null;
  pathHL.nodes.clear(); pathHL.edges.clear();
  $('#btnPath').classList.remove('active');
}
$('#btnPath').onclick = () => {
  if (pathMode) { clearPath(); relayout(); return; }
  if (!graph.centerKey) { notice('先画一张图，再使用路径查找'); return; }
  clearPath();
  pathMode = true;
  $('#btnPath').classList.add('active');
  notice('路径查找：点击起点节点');
};
// 路径模式下拦截节点点击（捕获阶段，先于 mkNode 的展开逻辑）
viewport.addEventListener('click', (e) => {
  if (!pathMode) return;
  const n = e.target.closest && e.target.closest('.node');
  if (!n || !n.dataset.key) return;
  e.stopPropagation();
  e.preventDefault();
  const key = n.dataset.key;
  if (!pathSrcKey) { pathSrcKey = key; notice('路径查找：点击终点节点'); return; }
  const found = findPath(pathSrcKey, key);
  if (!found) { notice('两个节点之间没有连通的调用路径'); pathSrcKey = key; return; }
  pathHL.nodes = new Set(found.nodes);
  pathHL.edges = new Set(found.edges);
  relayout();
  notice(`路径已高亮：${found.nodes.length} 个节点 · Esc 或再点「⇢ 路径」退出`);
  pathMode = false; pathSrcKey = null;
  $('#btnPath').classList.remove('active');
}, true);
// 有向 BFS 最短路径（沿调用方向 a→b）
function findPath(fromKey, toKey) {
  if (fromKey === toKey) return { nodes: [fromKey], edges: [] };
  const prev = new Map([[fromKey, null]]);
  const q = [fromKey];
  while (q.length) {
    const u = q.shift();
    for (const v of calleesOf(u)) {
      if (prev.has(v)) continue;
      prev.set(v, u);
      if (v === toKey) {
        const nodes = [], edges = [];
        let cur = toKey;
        while (cur !== null) { nodes.unshift(cur); const p = prev.get(cur); if (p) edges.unshift(p + SEP + cur); cur = p; }
        return { nodes, edges };
      }
      q.push(v);
    }
  }
  return null;
}

// ===== 上游链按钮：以当前中心为终点向上展开「谁调用了它」 =====
$('#btnTraceUp').onclick = () => {
  const c = graph.nodes.get(graph.centerKey);
  if (!c) { notice('先选中一个符号'); return; }
  startTrace(c.query || c.name, c.name, c.file, 'up');
};


async function loadFiles() {
  // 立即显示面板骨架与占位，避免 /api/files 响应慢时整个左侧空白
  showPanel('files');
  $('#fileList').innerHTML = '<div class="hit">⏳ 加载文件列表…</div>';
  try {
    allFiles = await api('/files');
    renderFiles();
    $('#fileFilter').addEventListener('input', renderFiles);
    // PHP/Laravel 项目：默认显示接口/路由列表（按文件分组）
    const hasRoutes = allFiles.some(f => /Routes?\//.test(f.path || ''));
    if (hasRoutes) showRouteList();
  } catch (e) { notice('加载文件列表失败：' + e.message); }
}

// 显示所有 Laravel 路由列表（接口发现面板）
async function showRouteList() {
  loading('正在加载接口列表…');
  try {
    const list = await api('/routes');
    if (!list || !list.length) { clearLoading(); return; }
    const escFn = esc, escAttrFn = escAttr;
    const byFile = {};
    for (const r of list) (byFile[r.file] = byFile[r.file] || []).push(r);
    const blocks = Object.entries(byFile).map(([file, routes], i) => {
      const fileId = 'fl-' + i; // 用索引做 id，避免文件路径转义后碰撞
      const items = routes.map(r => {
        const nm = r.handler.split('@').pop();
        return `<div class="hit" data-symbol="${escAttrFn(nm)}" data-name="${escAttrFn(nm)}" data-file="${escAttrFn(file)}">
          <div class="row1">${badge('route')}<span class="nm" title="${escAttrFn(r.method + ' ' + r.url + ' → ' + r.handler)}">${escFn(r.method)} ${escFn(r.url)} → ${escFn(r.handler)}</span><span class="trace-btn" title="点击=向下展开该路由方法的全部链路 · Shift+点击=向上">⧉ 链路</span></div>
          <div class="meta" title="${escAttrFn(file + ':' + r.line)}">${escFn(file)}:${r.line}</div>
        </div>`;
      }).join('');
      return `<div class="route-file" data-toggle="${i}" title="点击折叠/展开" style="padding:8px 12px 4px;font-size:11px;color:var(--text-3);border-top:1px solid var(--border);cursor:pointer;user-select:none;">📁 ${escFn(file)} · ${routes.length} <span class="arr">▼</span></div>
        <div id="${fileId}">${items}</div>`;
    }).join('');
    showPanel('results');
    $('#resultsTitle').textContent = '📋 接口列表';
    $('#resultsSub').textContent = `共 ${list.length} 条路由（按文件分组）`;
    $('#resultsBody').innerHTML = blocks || '<div class="hit">未解析到路由</div>';
    bindHits($('#resultsBody'));
    // 文件分组折叠/展开：委托在容器上，避免每次重建后重新绑定
    $('#resultsBody').onclick = (e) => {
      const h = e.target.closest('.route-file');
      if (!h) return;
      const body = document.getElementById('fl-' + h.dataset.toggle);
      if (!body) return;
      const collapsed = body.style.display === 'none';
      body.style.display = collapsed ? '' : 'none';
      h.querySelector('.arr').textContent = collapsed ? '▼' : '▶';
    };
    updateHeaderInfo(`接口列表：${list.length} 条路由`);
    clearLoading();
  } catch (e) { clearLoading(); }
}
function renderFiles() {
  const filter = $('#fileFilter').value.trim().toLowerCase();
  const list = allFiles
    .filter(f => f.nodeCount > 0 && (!filter || f.path.toLowerCase().includes(filter)))
    .sort((a, b) => b.nodeCount - a.nodeCount)
    .slice(0, 200);
  $('#fileList').innerHTML = list.length
    ? list.map(f =>
      `<div class="file" data-path="${escAttr(f.path)}" title="该文件含 ${f.nodeCount} 个符号，点击查看">
         <span class="cnt">${f.nodeCount}</span><span class="path">${esc(f.path)}</span>
       </div>`).join('')
    : '<div class="hit">没有匹配的文件</div>';
  $('#fileList').querySelectorAll('.file').forEach(el => el.onclick = () => showFileSymbols(el.dataset.path));
  updateHeaderInfo(`共 ${allFiles.length} 个文件 · 显示 ${list.length} 个`);
}
async function showFileSymbols(file) {
  // 点击后立即切换面板并显示占位，符号多时请求较慢，避免"点了没反应"
  showPanel('results');
  $('#resultsTitle').textContent = '📄 文件符号';
  $('#resultsSub').textContent = file;
  $('#resultsBody').innerHTML =
    '<div class="back" id="backToFiles">← 返回文件浏览</div>' +
    '<div class="hit">⏳ 正在加载符号…</div>';
  $('#backToFiles').onclick = () => { showPanel('files'); };
  try {
    const data = await api('/symbols', { file });
    $('#resultsBody').innerHTML =
      '<div class="back" id="backToFiles">← 返回文件浏览</div>' +
      (data.symbols.length
        ? data.symbols.map(s =>
            `<div class="hit" data-symbol="${escAttr(s.name)}" data-name="${escAttr(s.name)}" data-file="${escAttr(file)}">
               <div class="row1">${badge(s.kind)}<span class="nm" title="${escAttr(s.name)}">${esc(s.name)}</span><span class="trace-btn" title="点击=向下展开它调用的全部方法链 · Shift+点击=向上">⧉ 链路</span></div>
               <div class="meta">第 ${s.line} 行</div>
             </div>`).join('') +
            (data.truncated ? `<div class="hit" style="cursor:default;opacity:.75">⚠ 共 ${data.total} 个符号，仅显示前 ${data.symbols.length} 个（codegraph 上限），其余请用顶部搜索</div>` : '')
        : '<div class="hit">该文件没有可识别的符号</div>');
    bindHits($('#resultsBody'));
    $('#backToFiles').onclick = () => { showPanel('files'); };
  } catch (e) { notice('加载文件符号失败：' + e.message); }
}

// 搜索结果键盘导航：↑/↓ 移动高亮，Enter 打开当前项（无高亮则执行搜索）；结果列表重建后重置
let resIdx = -1;
function resItems() { return [...$('#resultsBody').querySelectorAll('.hit[data-symbol]')]; }
function resHighlight(items) {
  items.forEach((el, i) => el.classList.toggle('kbd-active', i === resIdx));
  const cur = items[resIdx];
  if (cur) cur.scrollIntoView({ block: 'nearest' });
}
function resMove(delta) {
  const items = resItems();
  if (!items.length) return;
  resIdx = (resIdx + delta + items.length) % items.length;
  resHighlight(items);
}
function resFocusReset() { resIdx = -1; resItems().forEach(el => el.classList.remove('kbd-active')); }

$('#btnSearch').onclick = doSearch;
$('#q').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { e.preventDefault(); resMove(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); resMove(-1); }
  else if (e.key === 'Enter') {
    const items = resItems();
    if (resIdx >= 0 && items[resIdx]) { e.preventDefault(); items[resIdx].click(); }
    else doSearch();
  }
  else if (e.key === 'Escape') { e.target.value = ''; e.target.blur(); }
});
// footer 右侧"使用说明"弹窗：按钮打开，✕ / 遮罩 / Esc 关闭
$('#btnHelp').onclick = () => $('#helpModal').classList.add('show');
const closeHelp = () => $('#helpModal').classList.remove('show');
$('#helpClose').onclick = closeHelp;
$('#helpModal').addEventListener('click', (e) => { if (e.target === $('#helpModal')) closeHelp(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#helpModal').classList.contains('show')) closeHelp(); });
// 弹窗内"试试示例"：关闭弹窗并自动执行演示搜索
$('#helpTry').onclick = () => { closeHelp(); $('#q').value = '/api/video/audit'; doSearch(); };
let savedSrcWidth = null; // 拖拽调整过的手动宽度，折叠时保存，展开时恢复
function setSrcCollapsed(collapsed) {
  const panel = $('#src');
  if (collapsed) {
    // 内联 style.width 优先级高于 .collapsed{width:40px}，折叠前必须清掉，否则折叠无效
    if (panel.style.width) { savedSrcWidth = panel.style.width; panel.style.width = ''; }
  } else if (savedSrcWidth) {
    panel.style.width = savedSrcWidth;
  }
  panel.classList.toggle('collapsed', collapsed);
  $('#srcToggle').textContent = collapsed ? '«' : '»';
  $('#srcToggle').title = collapsed ? '展开源码面板' : '折叠源码面板';
}
$('#srcToggle').onclick = () => setSrcCollapsed(!$('#src').classList.contains('collapsed'));
$('#srcStrip').onclick = () => setSrcCollapsed(false);
// 右侧源码面板：拖拽左边界调整宽度（260px ~ 900px，不超出窗口）
const srcResizer = $('#srcResizer');
let resizingSrc = false;
srcResizer.addEventListener('mousedown', (e) => {
  e.preventDefault();
  if ($('#src').classList.contains('collapsed')) setSrcCollapsed(false); // 折叠态先展开再拖
  srcResizer._startX = e.clientX;
  srcResizer._startW = $('#src').getBoundingClientRect().width;
  resizingSrc = true;
  document.body.style.userSelect = 'none'; // 拖拽期间禁用文本选中
});
window.addEventListener('mousemove', (e) => {
  if (!resizingSrc) return;
  // 拖拽手柄在面板左边界：向左拖=面板加宽（放大），向右拖=收窄（缩小）
  const w = srcResizer._startW - (e.clientX - srcResizer._startX);
  $('#src').style.width = Math.max(260, Math.min(900, window.innerWidth - 60, w)) + 'px';
});
window.addEventListener('mouseup', () => {
  if (!resizingSrc) return;
  resizingSrc = false;
  document.body.style.userSelect = '';
  // 面板宽度持久化：下次打开恢复手动调整的宽度
  try { localStorage.setItem('cgv-srcw', $('#src').style.width); } catch (e) { /* 隐私模式忽略 */ }
});
// 启动恢复上次调整的源码面板宽度
try {
  const savedW = localStorage.getItem('cgv-srcw');
  if (savedW) $('#src').style.width = savedW;
} catch (e) { /* 隐私模式忽略 */ }
$('#btnUndo').onclick = undoExpand;
// 噪音节点开关：关闭=过滤不显示，打开=全部显示（选择持久化到 localStorage）
$('#chkNoise').checked = showNoise;
$('#chkNoise').addEventListener('change', () => {
  showNoise = $('#chkNoise').checked;
  try { localStorage.setItem('cgv-noise', showNoise ? '1' : '0'); } catch (e) { /* 隐私模式忽略 */ }
  relayout();
});
// 大图角标：点击切换「显示全部 / 精简渲染」，并重置视图让新增节点可见
$('#moreBadge').onclick = () => { renderAllNodes = !renderAllNodes; relayout(); resetView(); };
// 导出菜单：SVG / PNG / JSON / Mermaid
$('#btnExport').onclick = (e) => {
  e.stopPropagation();
  const m = $('#exportMenu');
  if (m.classList.contains('show')) { m.classList.remove('show'); return; }
  const r = $('#btnExport').getBoundingClientRect();
  m.style.left = Math.max(8, r.left - 60) + 'px';
  m.style.top = (r.bottom + 6) + 'px';
  m.classList.add('show');
};
document.addEventListener('click', (e) => {
  if (!e.target.closest || !e.target.closest('#exportMenu')) $('#exportMenu').classList.remove('show');
});
$('#exportMenu').querySelectorAll('button').forEach(b => b.onclick = () => {
  $('#exportMenu').classList.remove('show');
  ({ svg: exportSVG, png: exportPNG, json: exportJSON, mermaid: exportMermaid })[b.dataset.fmt]();
});
function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function buildSVGString() {
  const svgEl = document.getElementById('svg');
  const styles = Array.from(document.querySelectorAll('style')).map(s => s.textContent).join('\n');
  const clone = svgEl.cloneNode(true);
  clone.setAttribute('width', svgEl.clientWidth);
  clone.setAttribute('height', svgEl.clientHeight);
  const styleEl = document.createElementNS(NS, 'style');
  styleEl.textContent = styles;
  clone.insertBefore(styleEl, clone.firstChild);
  return { str: '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone), w: svgEl.clientWidth, h: svgEl.clientHeight };
}
function exportSVG() {
  if (!graph.centerKey || graph.nodes.size === 0) { notice('当前没有可导出的图'); return; }
  const { str } = buildSVGString();
  download(new Blob([str], { type: 'image/svg+xml' }), 'codegraph.svg');
  notice('已导出 codegraph.svg');
}
// PNG：SVG 绘到 canvas 再转位图（2x 清晰度）
function exportPNG() {
  if (!graph.centerKey || graph.nodes.size === 0) { notice('当前没有可导出的图'); return; }
  const { str, w, h } = buildSVGString();
  const img = new Image();
  const url = URL.createObjectURL(new Blob([str], { type: 'image/svg+xml' }));
  img.onload = () => {
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = getComputedStyle(document.body).backgroundColor || '#0b0f17';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    canvas.toBlob((blob) => { if (blob) { download(blob, 'codegraph.png'); notice('已导出 codegraph.png'); } }, 'image/png');
  };
  img.onerror = () => { URL.revokeObjectURL(url); notice('PNG 导出失败'); };
  img.src = url;
}
function exportJSON() {
  if (!graph.centerKey || graph.nodes.size === 0) { notice('当前没有可导出的图'); return; }
  const nodes = [...graph.nodes.values()].map(n => ({ key: n.key, name: n.name, file: n.file, kind: n.kind }));
  const edges = [...graph.edges].map(e => { const i = e.indexOf(SEP); return { from: e.slice(0, i), to: e.slice(i + 1) }; });
  download(new Blob([JSON.stringify({ center: graph.centerKey, nodes, edges }, null, 2)], { type: 'application/json' }), 'codegraph.json');
  notice('已导出 codegraph.json');
}
// Mermaid flowchart：可直接嵌入 Markdown 文档（限 200 边防爆）
function exportMermaid() {
  if (!graph.centerKey || graph.nodes.size === 0) { notice('当前没有可导出的图'); return; }
  const idOf = new Map();
  let seq = 0;
  const nid = (key) => { if (!idOf.has(key)) idOf.set(key, 'n' + (seq++)); return idOf.get(key); };
  const lines = ['flowchart LR'];
  for (const n of graph.nodes.values()) {
    lines.push(`  ${nid(n.key)}["${n.name.replace(/"/g, "'")}"]`);
  }
  let cnt = 0;
  for (const e of graph.edges) {
    if (++cnt > 200) { lines.push('  %% 边过多已截断'); break; }
    const i = e.indexOf(SEP);
    lines.push(`  ${nid(e.slice(0, i))} --> ${nid(e.slice(i + 1))}`);
  }
  const center = graph.nodes.get(graph.centerKey);
  if (center) lines.push(`  style ${nid(graph.centerKey)} fill:#fbbf24,stroke:#b45309`);
  download(new Blob([lines.join('\n')], { type: 'text/plain' }), 'codegraph.mmd');
  notice('已导出 codegraph.mmd（Mermaid 语法，可嵌入 Markdown）');
}
// 重新索引：代码改动后刷新，搜索/链路反映最新代码
$('#btnReindex').onclick = async () => {
  loading('正在重新索引，大项目可能需要几十秒…');
  try {
    const data = await api('/reindex');
    $('#staleBar').style.display = 'none';
    notice(data.message || '索引已更新');
  } catch (e) {
    notice('重新索引失败：' + e.message);
  } finally {
    clearLoading();
  }
};
$('#btnStaleReindex').onclick = () => $('#btnReindex').click();
$('#btnStaleDismiss').onclick = () => { $('#staleBar').style.display = 'none'; staleDismissed = true; };
// 索引过期检测：后端 watch 项目目录，有代码变更时提示重新索引
let staleDismissed = false;
async function checkStale() {
  try {
    const s = await api('/status');
    if (s.stale && !s.reindexing && !staleDismissed) {
      $('#staleText').textContent = s.staleFile
        ? `⚠ 检测到代码变更（${s.staleFile}），索引可能已过期`
        : '⚠ 检测到代码变更，索引可能已过期';
      $('#staleBar').style.display = 'flex';
    }
    else $('#staleBar').style.display = 'none';
  } catch { /* 状态查询失败静默 */ }
}
setInterval(checkStale, 20000);
setTimeout(checkStale, 3000);
// 节点高亮搜索：匹配的节点保持清晰，其余降低透明度（关键词存起来，relayout 重建 DOM 后重放）
let highlightKW = '';
let hoverKey = null; // 当前 hover/点击的节点 key，非空时启用全链路高亮
let clickKey = null; // 点击固定的高亮（优先级低于 hover）
// 全链路可达集：上游沿 callers 方向、下游沿 callees 方向分别 BFS 后取并集。
// 注意必须是有向的——若用无向 BFS，中心是高扇出节点（如 getList 被 40 处调用）时，
// 从任一 caller 出发会经中心反向把全部兄弟 caller 拉进来，高亮退化成全图。
function reachableSet(key) {
  const seen = new Set([key]);
  // 上游：谁调用了它（callers 方向）
  const upQ = [key];
  while (upQ.length) {
    const u = upQ.shift();
    for (const v of callersOf(u)) if (!seen.has(v)) { seen.add(v); upQ.push(v); }
  }
  // 下游：它调用了谁（callees 方向）
  const downQ = [key];
  while (downQ.length) {
    const u = downQ.shift();
    for (const v of calleesOf(u)) if (!seen.has(v)) { seen.add(v); downQ.push(v); }
  }
  return seen;
}
// 应用全链路高亮：链路内节点与连线清晰（opacity 1），其余节点/连线降为 0.15
function applyChainHighlight(key) {
  if (!key) { clearChainHighlight(); return; }
  const set = reachableSet(key);
  document.querySelectorAll('#viewport .node').forEach(el => {
    el.style.opacity = set.has(el.dataset.key) ? '1' : '0.15';
  });
  document.querySelectorAll('#viewport .edge').forEach(el => {
    el.style.opacity = (set.has(el.dataset.a) && set.has(el.dataset.b)) ? '1' : '0.15';
  });
}
// 清除高亮：边恢复默认，节点按关键字高亮规则重放
function clearChainHighlight() {
  document.querySelectorAll('#viewport .edge').forEach(el => { el.style.opacity = ''; });
  applyHighlight();
}
function applyHighlight() {
  if (hoverKey || clickKey) return; // 全链路高亮期间暂停关键字高亮，清除后自动恢复
  const kw = highlightKW.trim().toLowerCase();
  document.querySelectorAll('#viewport .node').forEach(el => {
    // 用原始 label 匹配（data-key 取回），不受显示截断影响
    const node = graph.nodes.get(el.dataset.key);
    const label = ((node && node.label) || el.querySelector('text')?.textContent || '').toLowerCase();
    el.style.opacity = (!kw || label.includes(kw)) ? '1' : '0.2';
  });
}
// ===== 节点 Tooltip：悬停显示限定名、文件行号与高亮代码片段（/api/source，防抖 + 缓存） =====
const nodeTip = $('#nodeTip');
let tipTimer = null;
let tipCache = new Map(); // file:line -> /api/source 结果，避免快速扫过时打爆接口
function tipPosition(el) {
  const r = el.getBoundingClientRect();
  const tw = nodeTip.offsetWidth || 340, th = nodeTip.offsetHeight || 160;
  let x = r.right + 10, y = r.top - 10;
  if (x + tw > innerWidth - 8) x = r.left - tw - 10;
  if (y + th > innerHeight - 8) y = innerHeight - th - 10;
  nodeTip.style.left = Math.max(8, x) + 'px';
  nodeTip.style.top = Math.max(8, y) + 'px';
}
function showTip(key, el) {
  const node = graph.nodes.get(key);
  if (!node) return;
  clearTimeout(tipTimer);
  if (nodeTip._key !== key) { // 同一节点内移动只刷新位置，不重建内容
    nodeTip._key = key;
    const kind = node.kind && KIND_LABEL[node.kind] ? `<span class="tip-kind">${esc(KIND_LABEL[node.kind])}</span>` : '';
    const file = node.file ? `<div class="tip-file">📄 ${esc(node.file)}${node.line ? ' : ' + node.line : ''}</div>` : '';
    nodeTip.innerHTML = `${kind}<div class="tip-name">${esc(node.label)}</div>${file}<pre class="tip-code"><span class="tip-loading">⏳ 加载代码片段…</span></pre>`;
    nodeTip.style.display = 'block';
    const cacheKey = (node.file || '') + ':' + (node.line || 0);
    if (!node.file || !node.line) nodeTip.querySelector('.tip-code').innerHTML = '<span class="tip-empty">（无源码信息）</span>';
    else if (tipCache.has(cacheKey)) renderTipCode(node, tipCache.get(cacheKey));
    else tipTimer = setTimeout(async () => { // 防抖：短暂停留才拉取
      try {
        const data = await api('/source', { file: node.file, line: node.line });
        tipCache.set(cacheKey, data);
        if (hoverKey === key) { renderTipCode(node, data); tipPosition(el); }
      } catch { if (hoverKey === key) nodeTip.querySelector('.tip-code').innerHTML = '<span class="tip-empty">（加载失败）</span>'; }
    }, 180);
  }
  tipPosition(el);
}
function renderTipCode(node, data) {
  const pre = nodeTip.querySelector('.tip-code');
  if (!data || !data.snippet) { pre.innerHTML = '<span class="tip-empty">（无源码片段）</span>'; return; }
  const start = data.start || 1;
  pre.innerHTML = data.snippet.split('\n').map((ln, i) => {
    const n = start + i;
    const cls = n === node.line ? ' cur' : '';
    return `<div class="${cls}"><span class="ln">${n}</span><span class="tx">${highlightLine(ln)}</span></div>`;
  }).join('');
}
// 轻量语法高亮：逐段 token 提取后分别转义，防 XSS 且不破坏引号匹配
function highlightLine(line) {
  const re = /(\/\/.*$|#(?!\[).*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+\b)|(\b(?:function|class|const|let|var|return|if|else|for|while|new|public|private|protected|static|namespace|use|extends|implements|interface|type|import|export|async|await|try|catch|throw|this|readonly|int|string|bool|array|void|null|true|false|echo|require|include|switch|case|break|continue|instanceof|fn|struct|enum|match|func|def|self)\b)/g;
  let out = '', last = 0, m;
  while ((m = re.exec(line)) !== null) {
    out += esc(line.slice(last, m.index));
    if (m[1]) out += `<span class="tk-com">${esc(m[1])}</span>`;
    else if (m[2]) out += `<span class="tk-str">${esc(m[2])}</span>`;
    else if (m[3]) out += `<span class="tk-num">${esc(m[3])}</span>`;
    else out += `<span class="tk-kw">${esc(m[4])}</span>`;
    last = m.index + m[0].length;
  }
  out += esc(line.slice(last));
  return out;
}
function hideTip() {
  clearTimeout(tipTimer);
  nodeTip._key = null;
  nodeTip.style.display = 'none';
}

// 事件委托（mouseover/mouseout 冒泡，relayout 重建 DOM 后无需重新绑定）
// 优先 hover：鼠标在节点上时显示该节点全链路；移开后若有点击固定高亮则恢复之，否则清除。
// 注意：click 不走委托——mkNode 的 onclick 里 e.stopPropagation() 会拦截冒泡，故在 onclick 内直接设 clickKey。
viewport.addEventListener('mouseover', (e) => {
  const n = e.target.closest && e.target.closest('.node');
  if (n && n.dataset.key) {
    if (hoverKey !== n.dataset.key) { hoverKey = n.dataset.key; applyChainHighlight(n.dataset.key); }
    showTip(n.dataset.key, n);
  }
});
viewport.addEventListener('mouseout', (e) => {
  const from = e.target.closest && e.target.closest('.node');
  const to = e.relatedTarget && e.relatedTarget.closest ? e.relatedTarget.closest('.node') : null;
  if (from && from !== to) {
    hoverKey = null;
    hideTip();
    if (clickKey) applyChainHighlight(clickKey); // 恢复点击固定的高亮
    else clearChainHighlight();
  }
});
$('#nodeHighlight').addEventListener('input', () => { highlightKW = $('#nodeHighlight').value; applyHighlight(); });
$('#nodeHighlight').addEventListener('keydown', e => { if (e.key === 'Escape') { e.target.value = ''; highlightKW = ''; applyHighlight(); e.target.blur(); } });
// 左侧面板折叠（与右侧源码面板对称）
function setLeftCollapsed(c) {
  document.body.classList.toggle('left-collapsed', c);
  $('#btnLeftToggle').textContent = c ? '›' : '‹';
  $('#btnLeftToggle').title = c ? '展开左侧面板' : '折叠左侧面板';
}
$('#btnLeftToggle').onclick = () => setLeftCollapsed(!document.body.classList.contains('left-collapsed'));
$('#leftStrip').onclick = () => setLeftCollapsed(false);
// 左侧面板头部折叠按钮（与右侧源码面板对称）
document.querySelectorAll('.panel-fold').forEach(b => b.onclick = () => setLeftCollapsed(true));
// 快捷键：u 撤销展开 / r 重置 / / 聚焦搜索（输入框内不拦截）
document.addEventListener('keydown', e => {
  const tag = ((e.target && e.target.tagName) || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if (e.key === 'u' || e.key === 'U') undoExpand();
  else if (e.key === 'r' || e.key === 'R') $('#btnReset').click();
  else if (e.key === '/') { e.preventDefault(); $('#q').focus(); }
  else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomBy(1.25); }
  else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomBy(0.8); }
  else if (e.key === 'Escape') {
    // 路径查找模式：Esc 优先退出
    if (pathMode || pathHL.nodes.size) { clearPath(); relayout(); return; }
    // 结果面板打开时：Esc 先关面板
    if ($('#results').style.display === 'flex') { showPanel('none'); return; }
    // 关闭 notice（含 loading 态），并清空节点高亮；输入框内的 ESC 由各自元素处理
    clearTimeout(notice._t);
    const noticeEl = $('#notice');
    noticeEl.classList.remove('info');
    noticeEl.style.display = 'none';
    $('#nodeHighlight').value = '';
    highlightKW = '';
    hoverKey = null; clickKey = null;
    applyHighlight();
  }
});
$('#btnReset').onclick = () => {
  cancelTrace(true);
  history.length = 0;
  expandStack.length = 0;
  graph.nodes.clear(); clearGraphEdges(); graph.centerKey = null;
  hoverKey = null; clickKey = null; // 清空图时同步清掉全链路高亮状态
  clearPath();
  $('#crumbs').innerHTML = '';
  $('#src').style.display = 'none';
  $('#empty').style.display = 'flex';
  viewport.innerHTML = '';
  $('#minimap').style.display = 'none';
  $('#fileFilter').value = '';
  saveHash();
  renderFiles();
  showPanel('files');
};

// 主题切换：点击在浅色/深色间切换，记忆到 localStorage（head 内脚本负责初始加载）
$('#btnTheme').onclick = () => {
  const cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  const next = cur === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('cgv-theme', next); } catch (e) { /* 隐私模式等场景忽略 */ }
  $('#btnTheme').textContent = next === 'light' ? '🌙' : '☀️';
};
$('#btnTheme').textContent = document.documentElement.getAttribute('data-theme') === 'light' ? '🌙' : '☀️';

renderRecent();
loadFiles();
restoreFromHash();
