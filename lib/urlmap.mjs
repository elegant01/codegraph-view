// 自定义 route-map 规则 + 无配置自动探测（任意框架 URL → controller/method）
// 配置文件：项目根 codegraph.route.json（可选）；自动探测约定：control/ + ctlXxx.php + funcXxx
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const capFirst = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 在文件中定位方法；找不到指定方法时回退文件里第一个 func 方法；返回 { method, line }
export function findMethodLine(root, file, method) {
  try {
    const src = readFileSync(join(root, file), 'utf8');
    const m = src.match(new RegExp('function\\s+' + escRe(method) + '\\s*\\('));
    if (m) return { method, line: src.slice(0, m.index).split('\n').length };
    const f = src.match(/function\s+func\w+\s*\(/);
    if (f) return { method: f[0].match(/function\s+(\w+)/)[1], line: src.slice(0, f.index).split('\n').length };
    return { method, line: null };
  } catch { return { method, line: null }; }
}

// 按 controller 配置生成候选文件路径：模块目录优先，逐级回退
function controllerFiles(cc, module, controller) {
  const base = (cc.dir ? cc.dir.replace(/\/+$/, '') : '') + '/';
  const ext = cc.ext || '.php';
  const pref = cc.prefix || '';
  const mod = module ? capFirst(module) : '';
  const out = [];
  if (module && cc.trySubdir !== false) {
    out.push(base + module + '/' + pref + mod + controller + ext);
    out.push(base + module + '/' + pref + controller + ext);
  }
  out.push(base + pref + controller + ext);
  return out;
}

// 匹配单个 pattern 段：纯变量 {x}、带前后缀（{controller}.html）、多变量混合段（{a}-{b}.html）
export function parseSegTokens(patSeg) {
  const toks = [];
  let lit = '';
  for (let i = 0; i < patSeg.length; i++) {
    if (patSeg[i] === '{') {
      if (lit) { toks.push({ t: 'lit', v: lit }); lit = ''; }
      const end = patSeg.indexOf('}', i);
      if (end < 0) break;
      toks.push({ t: 'var', v: patSeg.slice(i + 1, end) });
      i = end;
    } else lit += patSeg[i];
  }
  if (lit) toks.push({ t: 'lit', v: lit });
  return toks;
}

export function matchSeg(patSeg, urlSeg, out) {
  const toks = parseSegTokens(patSeg);
  if (!toks.some(t => t.t === 'var')) return patSeg === urlSeg;
  if (toks.length === 1 && toks[0].t === 'var') { out[toks[0].v] = urlSeg; return true; }
  let re = '^';
  for (const t of toks) re += t.t === 'lit' ? escRe(t.v) : '(.+?)';
  re += '$';
  const m = urlSeg.match(new RegExp(re));
  if (!m) return false;
  let gi = 1;
  for (const t of toks) if (t.t === 'var') out[t.v] = m[gi++];
  return true;
}

// 匹配 URL（去掉 basePath 后）到 pattern，返回命名段；不匹配返回 null
export function matchUrlPattern(pattern, url) {
  const pSegs = pattern.split('/').filter(Boolean);
  const uSegs = url.split('/').filter(Boolean);
  if (pSegs.length !== uSegs.length) return null;
  const out = {};
  for (let i = 0; i < pSegs.length; i++) {
    if (!matchSeg(pSegs[i], uSegs[i], out)) return null;
  }
  return out;
}

export function createUrlMapper({ root, ttlMs = 60000, controlDir = 'control' }) {
  let cfgCache = { key: null, cfg: null, at: 0 };
  let autoCache = { key: null, entries: null, at: 0 };

  function loadUrlMap() {
    const now = Date.now();
    if (cfgCache.key === root && cfgCache.cfg && now - cfgCache.at < ttlMs) return cfgCache.cfg;
    let cfg = null;
    try {
      cfg = JSON.parse(readFileSync(join(root, 'codegraph.route.json'), 'utf8').replace(/^[\uFEFF]/, '')); // 容错 UTF-8 BOM
    } catch { /* 无配置则返回 null */ }
    cfgCache = { key: root, cfg, at: now };
    return cfg;
  }

  // 自动探测：扫描 control/ 下 ctl<Name>.php（含模块子目录），提取 funcXxx 方法
  function buildAutoUrlMap() {
    const now = Date.now();
    if (autoCache.key === root && autoCache.entries && now - autoCache.at < ttlMs) return autoCache.entries;
    const entries = [];
    if (!existsSync(join(root, controlDir))) { autoCache = { key: root, entries: [], at: now }; return entries; }
    const walk = (relDir) => {
      let files = [];
      try { files = readdirSync(join(root, relDir)); } catch { return; }
      for (const f of files) {
        const full = join(root, relDir, f);
        let st = null;
        try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) { if (!/^\./.test(f)) walk(relDir + '/' + f); }
        else if (/^ctl[\w]+\.php$/.test(f)) {
          const name = f.slice(3, -4);
          const module = relDir === controlDir ? '' : relDir.split('/').slice(1).join('/');
          const methods = [];
          try {
            const src = readFileSync(full, 'utf8');
            for (const m of src.matchAll(/function\s+(func\w+)\s*\(/g)) methods.push(m[1]);
          } catch { /* 文件不可读则方法为空 */ }
          entries.push({ module, name, methods, file: relDir + '/' + f });
        }
      }
    };
    walk(controlDir);
    autoCache = { key: root, entries, at: now };
    return entries;
  }

  // URL 段 → controller 变体（如 TvRoom → ['TvRoom','Room']，去掉模块前缀）
  function ctrlVariants(name, module) {
    const out = [name];
    if (module && name.startsWith(capFirst(module))) out.push(name.slice(module.length));
    return out;
  }

  function matchUrlMapAuto(urlPath) {
    const entries = buildAutoUrlMap();
    if (!entries.length) return null;
    const url = urlPath.replace(/[?#].*$/, '').replace(/^\/+/, '').replace(/\/+$/, '');
    const segs = url.split('/').filter(Boolean);
    if (!segs.length) return null;
    const last = segs[segs.length - 1].replace(/\.\w+$/, '');
    let controllerPart = last, methodPart = null;
    if (last.includes('-')) {
      const parts = last.split('-');
      controllerPart = parts[0];
      methodPart = parts.slice(1).join('-');
    }
    const modulePart = segs.length >= 2 ? segs[segs.length - 2] : '';
    for (const e of entries) {
      if (modulePart && e.module && e.module.toLowerCase() !== modulePart.toLowerCase()) continue;
      if (!ctrlVariants(e.name, e.module).some(v => v.toLowerCase() === controllerPart.toLowerCase())) continue;
      let method = null;
      if (methodPart) method = 'func' + capFirst(methodPart);
      else method = e.methods.includes('funcIndex') ? 'funcIndex' : (e.methods[0] || null);
      if (!method) continue;
      const fm = findMethodLine(root, e.file, method);
      return { filePath: e.file, name: fm.method, line: fm.line };
    }
    return null;
  }

  // 核心：URL → { filePath, name, line }
  // 优先级：配置文件 overrides → 配置 patterns（存在才用）→ 自动探测（无配置/无 patterns 时）
  function matchUrlMap(urlPath) {
    const cfg = loadUrlMap();
    let url = urlPath.replace(/[?#].*$/, '').replace(/^\/+/, '');
    url = '/' + url;
    if (cfg) {
      const base = cfg.basePath || '';
      if (base && url.startsWith(base)) url = url.slice(base.length) || '/';
      if (cfg.overrides && cfg.overrides[urlPath] && typeof cfg.overrides[urlPath] === 'string') {
        const [file, method] = cfg.overrides[urlPath].split('::');
        const fm = findMethodLine(root, file, method);
        return { filePath: file, name: fm.method, line: fm.line };
      }
      if (Array.isArray(cfg.patterns) && cfg.patterns.length) {
        for (const pat of cfg.patterns) {
          const segs = matchUrlPattern(pat, url);
          if (!segs) continue;
          const methodName = segs.method || cfg.defaultMethod || 'index';
          const fullMethod = (cfg.method && cfg.method.prefix || '') + (cfg.method && cfg.method.capitalize !== false ? capFirst(methodName) : methodName);
          const ctrl = capFirst(segs.controller);
          for (const file of controllerFiles(cfg.controller || {}, segs.module, ctrl)) {
            if (!existsSync(join(root, file))) continue;
            const fm = findMethodLine(root, file, fullMethod);
            return { filePath: file, name: fm.method, line: fm.line };
          }
        }
      }
    }
    return matchUrlMapAuto(urlPath);
  }

  return {
    matchUrlMap,
    invalidate() {
      cfgCache = { key: null, cfg: null, at: 0 };
      autoCache = { key: null, entries: null, at: 0 };
    },
  };
}
