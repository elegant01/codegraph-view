// 路由解析：
//  - Laravel/PHP：扫描 routes/*.php 与 modules/*/Routes/*.php
//    支持嵌套 group（大括号深度计数）、链式 prefix、resource/apiResource 展开、{key} 通配
//  - Go：扫描全部 .go 文件
//    beego：NewNamespace/NSNamespace 前缀嵌套（括号深度计数）、NSRouter/Router、
//           NSInclude + 控制器 @router 注解、beego.Get/Post 内联处理器
//    gin：r.GET/POST/...、Group 前缀（变量声明追踪）、ctl.Method / 包级函数 / 匿名处理器
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseJson } from './textparse.mjs';

const RESTFUL = [
  ['GET', '', 'index'],
  ['POST', '', 'store'],
  ['GET', '/{id}', 'show'],
  ['PUT', '/{id}', 'update'],
  ['PATCH', '/{id}', 'update'],
  ['DELETE', '/{id}', 'destroy'],
];

const countOf = (s, ch) => s.split(ch).length - 1;

// 逐行扫描，返回 [{ url, method, handler, file, line }]
export function parseRouteFile(src, filePath) {
  const routes = [];
  const lines = src.split('\n');
  const stack = []; // { prefix, closeAt } — closeAt 为 group 起始行之前的大括号深度
  let depth = 0;
  const prefixes = () => stack.map(s => s.prefix).filter(Boolean).join('/');

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    const opens = countOf(lines[i], '{');
    const closes = countOf(lines[i], '}');

    // group 开启（仅闭包形式累积前缀；->group(dirname(...)) 文件引用不累积）
    if (/->group\s*\(\s*function/.test(t)) {
      const pfx = t.match(/prefix\s*\(\s*(['"])(.*?)\1\s*\)/);
      stack.push({ prefix: pfx ? pfx[2] : '', closeAt: depth });
    }

    const base = prefixes();
    const joinUrl = (u) => ((base ? base + '/' : '') + u).replace(/\/+/g, '/');

    // Route::get/post/put/patch/delete/any('url', 'Controller@method')
    const rm = t.match(/Route::(get|post|put|patch|delete|any)\((['"])(.*?)\2\s*,\s*(['"])(.*?)\4\s*\)/);
    if (rm) routes.push({ url: joinUrl(rm[3]), method: rm[1].toUpperCase(), handler: rm[5], file: filePath, line: i + 1 });

    // Route::resource / apiResource('url', 'Controller') → 展开为标准 RESTful 动作
    const rr = t.match(/Route::(apiResource|resource)\((['"])(.*?)\2\s*,\s*(['"])(.*?)\4\s*\)/);
    if (rr) {
      for (const [method, suffix, action] of RESTFUL) {
        routes.push({ url: joinUrl(rr[3] + suffix), method, handler: rr[5] + '@' + action, file: filePath, line: i + 1 });
      }
    }

    depth += opens - closes;
    while (stack.length && depth <= stack[stack.length - 1].closeAt) stack.pop();
  }
  return routes;
}

export function createRouteParser({ root, run, ttlMs = 300000 }) {
  let cache = { key: null, list: null, at: 0 };
  let goCache = { key: null, list: null, at: 0 };

  async function parseLaravelRoutes() {
    const now = Date.now();
    if (cache.key === root && cache.list && now - cache.at < ttlMs) return cache.list;
    const out = await run(['files', '--json']);
    const files = parseJson(out, []);
    const routeFiles = files.filter(f => /(?:^|\/)(?:routes|Routes)\/[^/]+\.php$/.test(f.path || ''));
    const routes = [];
    for (const f of routeFiles) {
      const filePath = join(root, f.path);
      try {
        if (statSync(filePath).size > 2 * 1024 * 1024) continue; // 超大路由文件跳过，防 OOM
        routes.push(...parseRouteFile(readFileSync(filePath, 'utf8'), f.path));
      } catch { /* 文件不可读则跳过 */ }
    }
    cache = { key: root, list: routes, at: now };
    return routes;
  }

  async function parseGoRoutes() {
    const now = Date.now();
    if (goCache.key === root && goCache.list && now - goCache.at < ttlMs) return goCache.list;
    const out = await run(['files', '--json']);
    const files = parseJson(out, []);
    const goFiles = files.filter(f => /\.go$/.test(f.path || ''));
    // 第一遍：读候选文件，收集 @router 注解控制器（struct 名 → 注解路由）
    const readable = [];
    for (const f of goFiles) {
      const filePath = join(root, f.path);
      try {
        if (statSync(filePath).size > 1024 * 1024) continue;
        const src = readFileSync(filePath, 'utf8');
        if (GO_ROUTE_HINT.test(src) || src.includes('@router')) readable.push({ path: f.path, src });
      } catch { /* 文件不可读则跳过 */ }
    }
    const controllerFiles = new Map(); // structName → { file, routes }
    for (const f of readable) {
      if (!f.src.includes('@router')) continue;
      const ann = parseBeegoAnnotations(f.src);
      if (!ann.length) continue;
      for (const m of f.src.matchAll(/type\s+(\w+)\s+struct\s*\{/g)) {
        controllerFiles.set(m[1], { file: f.path, routes: ann });
      }
    }
    // 第二遍：解析路由注册
    const routes = [];
    for (const f of readable) {
      if (!GO_ROUTE_HINT.test(f.src)) continue;
      routes.push(...parseGoRouteFile(f.src, f.path, controllerFiles));
    }
    goCache = { key: root, list: routes, at: now };
    return routes;
  }

  return {
    parseLaravelRoutes,
    parseGoRoutes,
    invalidate() { cache = { key: null, list: null, at: 0 }; goCache = { key: null, list: null, at: 0 }; },
  };
}

const REGEX_META = /[.*+?^${}()|[\]\\]/g;

// 路由 URL 匹配：`{key}`（Laravel）/ `:key`（beego/gin）段视为单段通配，`*x`（gin）为多段通配，
// 其余字符正则转义（如 goodsBatch.json 的 . 不吞任意字符）
export function matchRoute(routeUrl, inputUrl) {
  try {
    const pattern = String(routeUrl).split(/(\{[^}]+\}|\/:[^/]+|\/\*[^/]*)/)
      .map(seg => {
        if (seg.startsWith('{') && seg.endsWith('}')) return '[^/]+';
        if (seg.startsWith('/:')) return '/[^/]+';
        if (seg.startsWith('/*')) return '(?:/.*)?';
        return seg.replace(REGEX_META, '\\$&');
      })
      .join('');
    return new RegExp('^' + pattern + '$').test(inputUrl);
  } catch { return false; }
}

// ===== Go：beego / gin =====

const GO_HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'Any'];
const GO_ROUTE_HINT = /beego\.(Router|NSRouter|NewNamespace|NSNamespace|NSInclude|Get|Post|Put|Delete|Head|Options|Patch|Any)|\.(Group|GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|Any)\s*\(/;
const GO_CTRL_DECL = /(\w+)\s*:?=\s*(?:&(?:\w+\.)?(\w+)\{\}|new\((?:\w+\.)?(\w+)\))/;

// beego 方法映射串 "get:GetOne;post:Update" → [[GET, GetOne], ...]；裸 "get" 表示同名方法
function parseBeegoMethodMap(mapStr) {
  const out = [];
  for (const part of String(mapStr).split(';')) {
    const p = part.trim();
    if (!p) continue;
    const ci = p.indexOf(':');
    if (ci < 0) {
      const fn = p === '*' ? 'Any' : p[0].toUpperCase() + p.slice(1);
      out.push([p === '*' ? 'ANY' : p.toUpperCase(), fn]);
    } else {
      const m = p.slice(0, ci).trim(), fn = p.slice(ci + 1).trim();
      if (fn) out.push([m === '*' ? 'ANY' : m.toUpperCase(), fn]);
    }
  }
  return out;
}

// 解析 beego / gin 路由文件，返回 [{ url, method, handler, file, line, name?, filePath?, startLine? }]
// handler 形如 "BanController@Add"（可经 resolveSymbol 定位）；匿名处理器直接带 file/line
export function parseGoRouteFile(src, filePath, controllerFiles = new Map()) {
  const routes = [];
  const lines = src.split('\n');
  // beego 命名空间前缀栈：{ prefix, closeAt } — closeAt 为该调用开括号前的圆括号深度
  const nsStack = [];
  // gin 变量前缀：root := gin.Default() → ''；v1 := r.Group("/v1") → '/v1'
  const varPrefix = new Map();
  // 控制器变量声明：ctl := &controllers.BanController{} → BanController
  const varType = new Map();
  let depth = 0;
  const nsPrefix = () => nsStack.map(s => s.prefix).filter(Boolean).join('');
  // 与 Laravel 路由一致：不带前导斜杠（/api/route 匹配前会剥输入的 /）
  const joinUrl = (base, u) => ((base || '') + '/' + String(u || '')).replace(/\/+/g, '/').replace(/^\//, '');
  const ctrlOf = (expr) => {
    // &controllers.BanController{} / &BanController{} / new(controllers.BanController)
    const m = String(expr).match(/&(?:\w+\.)?(\w+)\s*\{\s*\}/) || String(expr).match(/new\(\s*(?:\w+\.)?(\w+)\s*\)/);
    return m ? m[1] : null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    const curDepth = depth;

    // --- beego：命名空间前缀入栈 ---
    for (const m of line.matchAll(/(?:beego\.)?(?:NewNamespace|NSNamespace)\s*\(\s*"([^"]*)"/g)) {
      nsStack.push({ prefix: m[1], closeAt: curDepth + depthBeforeOpen(line, m.index) });
    }
    // --- gin：根路由与 Group 变量 ---
    const rootM = t.match(/(\w+)\s*:?=\s*gin\.(?:Default|New)\s*\(/);
    if (rootM) varPrefix.set(rootM[1], '');
    const grpM = t.match(/(\w+)\s*:?=\s*(\w+)\.Group\s*\(\s*"([^"]*)"/);
    if (grpM && varPrefix.has(grpM[2])) varPrefix.set(grpM[1], joinUrl(varPrefix.get(grpM[2]), grpM[3]));
    // --- 控制器变量声明 ---
    const declM = t.match(GO_CTRL_DECL);
    if (declM && (declM[2] || declM[3])) varType.set(declM[1], declM[2] || declM[3]);

    // --- beego：Router / NSRouter ---
    for (const m of line.matchAll(/beego\.(?:NS)?Router\s*\(\s*"([^"]+)"\s*,\s*([^,]+?)\s*(?:,\s*"([^"]*)")?\s*\)/g)) {
      const [, u, ctrlExpr, mapStr] = m;
      const cls = ctrlOf(ctrlExpr);
      if (!cls) continue;
      const maps = mapStr ? parseBeegoMethodMap(mapStr) : [['ANY', 'Index']];
      for (const [method, fn] of maps) {
        routes.push({ url: joinUrl(nsPrefix(), u), method, handler: cls + '@' + fn, file: filePath, line: i + 1 });
      }
    }
    // --- beego：NSInclude（配合控制器 @router 注解） ---
    for (const m of line.matchAll(/beego\.NSInclude\s*\(\s*([^)]+?)\s*\)/g)) {
      const cls = ctrlOf(m[1]);
      if (!cls) continue;
      const ann = controllerFiles.get(cls); // { file, routes: [{url, methods, fn, line}] }
      if (!ann) continue;
      for (const a of ann.routes) {
        for (const method of a.methods) {
          routes.push({ url: joinUrl(nsPrefix(), a.url), method, handler: cls + '@' + a.fn, file: ann.file, line: a.line });
        }
      }
    }
    // --- beego：内联处理器 beego.Get("/x", func...) ---
    for (const m of line.matchAll(/beego\.(Get|Post|Put|Delete|Head|Options|Patch|Any)\s*\(\s*"([^"]+)"/g)) {
      routes.push({ url: joinUrl(nsPrefix(), m[2]), method: m[1].toUpperCase(), handler: '(匿名处理器)', file: filePath, line: i + 1, name: '(匿名处理器)', filePath, startLine: i + 1 });
    }
    // --- gin：r.GET("/x", ctl.Add [, ...])；处理器参数可能含括号（如 mw.Auth()），取到行尾再剥一个收尾括号 ---
    for (const m of line.matchAll(/(\w+)\.(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|Any)\s*\(\s*"([^"]+)"\s*,\s*(.+)$/g)) {
      const [, recv, method, u, rawArgs] = m;
      if (!varPrefix.has(recv) && !/^(r|router|e|engine|s|srv|g|api|v\d+)$/.test(recv)) continue;
      const url = joinUrl(varPrefix.get(recv) || '', u);
      const args = rawArgs.replace(/\)\s*(?:\/\/.*)?$/, '');
      const lastArg = topLevelSplit(args).pop().trim(); // 中间件链取最后一个
      const dotM = lastArg.match(/(\w+)\.(\w+)$/);
      if (/^func\b/.test(lastArg)) {
        routes.push({ url, method: method.toUpperCase(), handler: '(匿名处理器)', file: filePath, line: i + 1, name: '(匿名处理器)', filePath, startLine: i + 1 });
      } else if (dotM && varType.has(dotM[1])) {
        routes.push({ url, method: method.toUpperCase(), handler: varType.get(dotM[1]) + '@' + dotM[2], file: filePath, line: i + 1 });
      } else if (dotM) {
        // 包级函数 controllers.Add / 未追踪到类型的变量方法：先按方法名解析
        routes.push({ url, method: method.toUpperCase(), handler: dotM[2], file: filePath, line: i + 1 });
      } else if (/^\w+$/.test(lastArg)) {
        routes.push({ url, method: method.toUpperCase(), handler: lastArg, file: filePath, line: i + 1 });
      }
    }

    depth += countOf(line, '(') - countOf(line, ')');
    while (nsStack.length && depth <= nsStack[nsStack.length - 1].closeAt) nsStack.pop();
  }
  return routes;
}

// 该字符之前、同一行内的净开括号数（用于嵌套调用求 closeAt）
function depthBeforeOpen(line, idx) {
  let d = 0;
  for (let i = 0; i < idx; i++) {
    if (line[i] === '(') d++;
    else if (line[i] === ')') d--;
  }
  return d;
}

// 按顶层逗号切分（忽略括号/字符串内的逗号），用于取中间件链最后一个参数
function topLevelSplit(s) {
  const parts = [];
  let d = 0, cur = '', inStr = null;
  for (const ch of s) {
    if (inStr) { cur += ch; if (ch === inStr) inStr = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; cur += ch; continue; }
    if (ch === '(' || ch === '{' || ch === '[') d++;
    else if (ch === ')' || ch === '}' || ch === ']') d--;
    if (ch === ',' && d === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

// 从控制器源码提取 @router 注解：// @router /path [get,post] 紧随其后的是 func (x *Ctl) Method()
export function parseBeegoAnnotations(src) {
  const out = [];
  const re = /@router\s+(\/\S*)\s*\[([^\]]+)\][\s\S]{0,200}?func\s*\(\s*\w+\s+\*?\w+\s*\)\s*(\w+)\s*\(/g;
  for (const m of src.matchAll(re)) {
    out.push({ url: m[1], methods: m[2].split(',').map(s => s.trim().toUpperCase()).filter(Boolean), fn: m[3], line: src.slice(0, m.index).split('\n').length });
  }
  return out;
}
