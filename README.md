# CodeGraph Visualizer (codegraph-view)

Turns the **call relationships between code symbols** in a CodeGraph index into an interactive graph, and bundles every codegraph command.

**English** · [中文](https://github.com/elegant01/codegraph-view/blob/main/README.zh-CN.md)

> The web UI itself is currently in Chinese; this document translates its labels so you can follow along.

## Preview

Pick a method and see what calls it and what it calls: green on the left are **callers**, blue on the right are **callees**, gold in the middle is the current symbol.
(The screenshots below come from the `examples/demo-app` project shipped in this repo — run it yourself to reproduce them.)

![Call graph](https://raw.githubusercontent.com/elegant01/codegraph-view/main/docs/preview-graph.png)

**Route URL lookup**: paste an API path (e.g. `/api/media/audit`) and it lands on the matching `route.ts`; hit 「⧉ 链路」 (Trace) to expand the whole call tree underneath it.

![Route URL lookup](https://raw.githubusercontent.com/elegant01/codegraph-view/main/docs/preview-route.png)

**Full chain expansion**: draws several levels of the call chain in one go (the status bar shows the chain depth); leaves marked `+` can be expanded further.

![Full chain expansion](https://raw.githubusercontent.com/elegant01/codegraph-view/main/docs/preview-trace.png)

**Dark theme**: follows the system by default; the 🌙/☀️ pill in the header switches manually and remembers your choice.

![Dark theme](https://raw.githubusercontent.com/elegant01/codegraph-view/main/docs/preview-dark.png)

## Install and usage

**Option 1: global npm package (recommended, shareable)**

```bash
npm pack                          # run from the repo root; produces codegraph-view-<version>.tgz
npm i -g ./codegraph-view-<version>.tgz
```

Then, from the root of any project **already indexed by codegraph**:

```bash
cgv view          # start the visualizer on port 39267; open http://localhost:39267
cgv view 3456     # pick a port
cgv view 3456 --host 0.0.0.0   # allow LAN access (default is 127.0.0.1 only — mind the security note)
cgv query xxx     # every other command is passed straight to codegraph (init / callers / callees / node ...)
cgv               # help
```

- Requires **Node ≥ 22.18**: `cgv view` loads `lib/textparse.ts` and relies on Node's native type stripping to execute it (the project has no build step — see "Why is the backend `.ts`?")
- Listens on **127.0.0.1** only by default (it is a local tool; this keeps your source off the LAN). Pass `--host` explicitly to share it
- codegraph itself is installed as a dependency — **you do not need to install codegraph separately**
- To share with someone: send them the `.tgz` and have them run `npm i -g codegraph-view-<version>.tgz`
- The command answers to two names: `cgv` and `codegraph-view`

**Option 2: run straight from the repo (development)**

```bash
node server.ts [port]   # defaults to 39267, falls back to codegraph on PATH (needs Node ≥22.18)
# Want a project to play with? The repo ships a fake one: examples/demo-app
#   cd examples/demo-app && codegraph init && cgv view 39267
```

---

## Layout

```
┌──────────────────────────────────────────────────────────┐
│ Top: search box · search · reset · breadcrumb · status   │
├──────────┬────────────────────────────────┬──────────────┤
│ Left     │       Center: call graph       │   Right:     │
│ panel    │  callers ← [center] → callees  │ source code  │
│ (files / │                                │              │
│  search) │                                │              │
└──────────┴────────────────────────────────┴──────────────┘
```

### Left panel (one of two modes)

**📁 File browser** (default)
- Sorted by the **number of indexed symbols** in each file, descending (functions, classes, methods, types all count)
- The number in front of each row is that file's symbol count
- The filter box at the top narrows by path substring
- 200 files per page; "show more" at the bottom loads incrementally instead of hard-cutting the list
- Noise files are hidden by default (`.min.js`, `node_modules`/`vendor`/`dist`, …), sharing the same rules as the 「噪」 toggle in the canvas toolbar
- **Click a file** → list its symbols; **click a symbol** → draw its call graph
- A single file's symbol list is capped by codegraph at 200; when it overflows, the bottom of the list says how many there are in total — reach the rest through search
- The left panel **collapses/expands** just like the source panel (the 「‹ / ›」 buttons at the top, or click the vertical strip once collapsed)

**🔍 Search results**
- Appears once you type a symbol name into the top search box
- Labels are Chinese kinds: 方法 / 类 / 接口 / 类型 / 属性 / 变量 / 函数 / 路由 (method / class / interface / type / property / variable / function / route)
- Click any result → draw its call graph
- **Paste a route URL** (e.g. `/api/activity/Sample/list`) → jumps to the matching `route.ts` file
  - Query strings are stripped (`/api/xxx?page=2` resolves too)
  - Next.js dynamic segments are supported (`/api/user/123` → matches `[id]/route.ts`)
  - **Falls back to fuzzy matching when an exact match finds nothing**: a fragment like `/api/room` lists every Laravel route / `route.ts` containing it
- The **「⧉ 链路」** (Trace) button on each result expands the **entire call chain** it invokes (downwards only, drawn as one tree); **Shift+click** expands upwards instead — i.e. **who calls it** (impact analysis)

### Search refinements

- **Kind filter**: dropdown next to the search box — match only methods / functions / classes / interfaces / properties, etc.
- **Regex mode**: tick 「正则」 to treat the query as a regex (e.g. `get.*List`)
- **Recent searches**: the input suggests your last 12 searches (localStorage)

### Lookups by project type

**Next.js / TypeScript**
- Symbol search: `getItemList`, `searchAudit`
- Route URL: `/api/media/audit` → `src/app/api/media/audit/route.ts`
- Page path: `/video` → `src/app/(admin)/video/page.tsx` (route groups like `(admin)` are ignored automatically)
- Dynamic segments: `/api/system/config/123` → matches `[id]/route.ts`; `/group/123` → matches a page `[id]`
- Fuzzy: a fragment such as `/api/media` or `/group/entry` lists the related routes/pages

**Go (beego / gin)**
- Search function/method names directly: `Add`, `TypeList`, `GetList`
- From an HTTP handler (a controller method), hit 「⧉ 链路」 to expand the whole call chain
- **beego route lookup**: `/v1/item/add` → `ItemController@Add` (handles `NewNamespace`/`NSNamespace` nesting, `NSRouter`/`Router` method mapping, `NSInclude` + `@router` annotations, and inline handlers)
- **gin route lookup**: `/api/v1/item/list` → `itemCtl.List` (handles `Group` prefixes, `ctl := &XxxController{}` variable type tracking, middleware chains taking the last handler, and anonymous handlers resolved to file:line)
- Dynamic segments: `/user/123` matches the `:id` wildcard; `/static/a/b.js` matches the multi-segment `*filepath`

**PHP / Laravel**
- Search method names: `batchItems`, `multiList`
- Route URLs: `/api/group/multiList.json` or `shop/batchItems.json` → resolves to `Controller@method`
- Fuzzy routes: a fragment like `/shop/items` lists all related routes
- Query strings are stripped (`?page=2` does not affect lookup); `{id}` segments are wildcard-matched

**Custom frameworks (e.g. php-admin's ctlXxx.php)**
- **Auto-detected, zero config**: the tool scans the project and recognises the `control/` + `ctlXxx.php` + `funcXxx` convention. Paste a real admin URL (e.g. `/php-admin/orderList.html`, `/php-admin/module/page.html`, `/php-admin/module/List-index.html`) and it locates the method and draws the graph / expands the chain
- What auto-detection covers:
  - Controller directory: `control/` (sub-directories group modules)
  - File naming: `ctl<Controller>.php`, or a module-prefixed `ctl<Module><Controller>.php` (e.g. `module/page.html` → `control/module/ctlModulePage.php`)
  - Method naming: `func<Method>` (`List-index` → `funcIndex`); a URL without a method segment defaults to `funcIndex`, and a missing method falls back to the first `func` method in the file
- **The config file is optional**: you only need `codegraph.route.json` for the odd URL that auto-detection cannot match, and only an `overrides` entry at that (near-zero maintenance):

```json
{
  "overrides": {
    "/php-admin/data/data.html": "control/data/ctlRank.php::funcMonth"
  }
}
```

- If auto-detection does not fit your framework (different directory/prefix), configure the full rule set (a `patterns` array replaces auto-detection):

```json
{
  "basePath": "/php-admin",
  "patterns": [
    "/{module}/{controller}-{method}.html",
    "/{module}/{controller}.html",
    "/{controller}-{method}.html",
    "/{controller}.html"
  ],
  "defaultMethod": "index",
  "controller": { "dir": "control", "prefix": "ctl", "ext": ".php", "trySubdir": true },
  "method": { "prefix": "func", "capitalize": true }
}
```

- Field reference:
  - `basePath`: common URL prefix (e.g. `/php-admin`), stripped before matching
  - `patterns`: URL patterns tried in order; `{module}` / `{controller}` / `{method}` are wildcard segments
  - `defaultMethod`: method used when the URL has no method segment (the prefix is added during mapping)
  - `controller`: controller file rules — `dir` directory, `prefix` class prefix (ctl), `ext` extension, `trySubdir` whether to try `<dir>/<module>/` before falling back to `<dir>/`
  - `method`: method naming — `prefix` (func), `capitalize` uppercase first letter
  - `overrides`: exception URLs that no rule matched, mapped directly to `file::method`

### Multiple git workspaces (aggregate repository mode)

A project root may **nest several independent git repositories** (git submodules / nested repos), for example `monorepo`:

```
monorepo/                      ← aggregate root (.git)
├── modules/                  ← business modules (each has its own .git)
│   ├── Api/    (.git)
│   ├── Admin/(.git)
│   ├── Mobile/ (.git)
│   └── Web/    (.git)
├── packages/                 ← shared packages (own .git)
│   ├── tools/  (.git)
│   └── logger/ (.git)
├── services/   (.git)
└── vendor/
```

**Start it once at the aggregate root** and the tool covers every nested repository:

```bash
cd /path/to/monorepo
# Key point: codegraph ignores nested git repos by default — list them explicitly in codegraph.json
# (monorepo does this via includeIgnored, pulling modules/ and services/ into the index)
echo '{ "includeIgnored": ["modules/", "services/"] }' > codegraph.json
codegraph init   # indexes all sub-repository code
cgv view 4001    # search / call graph / chains work across modules, packages and services
```

- Nested repos need neither their own index nor their own server — indexing and lookup work on the whole directory (monorepo's `batchItems` lives at `modules/Api/Http/Controllers/...` and is searchable from the aggregate root)
- A custom framework's `codegraph.route.json` (if you need overrides) also goes at the aggregate root and applies to every sub-repository
- Sibling projects that do not nest (e.g. php-admin, nextjs-app, go-service) do need one instance each, started in their own root:

```bash
cd /path/to/php-admin  && cgv view 4002   # custom PHP framework
cd /path/to/nextjs-app && cgv view 3999   # Next.js
cd /path/to/go-service && cgv view 4000   # Go
```

### Center: the call graph

Centered on one symbol, showing its direct call relationships:

| Position | Meaning | Color |
|------|------|------|
| Center | the currently selected symbol | gold |
| Left | **callers** — who calls it | green |
| Right | **callees** — what it calls | blue |

- **Arrows** on the edges show call direction
- A fixed **legend** sits in the lower-left corner
- Column headers spell it out: 「调用者（谁调用了它）」 callers and 「被调用者（它调用了谁）」 callees

### Right: source code
Shows the current symbol's source, its file, and the call trail. Clicking the center node re-targets this panel.

---

## Interaction

| Action | Effect |
|------|------|
| **Scroll wheel** | Zoom the graph |
| **Drag empty space** | Pan the graph |
| **Drag a card** | Place a node freely (reopening the graph or resetting restores auto-layout) |
| **＋ / － / ⟲** | Zoom in / out / reset the view (floating bar at the bottom center) |
| **Click a node on the right** | Expand "what it calls"; **click a node on the left** to expand "who calls it" — side paths never leak into the current flow |
| **Double-click a node** | Reopen a bidirectional call graph centered on it |
| **Right-click a node** | Center on it / force-expand downstream / force-expand upstream / copy path / open in editor |
| **Hover a node** | Pops up a code preview you can move into to scroll and copy; at the same time it highlights the node's **entire reachable chain** (upstream along callers, downstream along callees, each traversed as a directed BFS and unioned) — the chain stays crisp while everything else fades out |
| **Click a node** | Expands its call relationships and **pins** that chain highlight (moving the mouse away does not clear it) |
| **Click the center node** | The floating source panel jumps to its source |
| **↩ Undo expand** | Undo the most recent click-expansion and return to the previous state (multi-level) |
| **⇈ Upstream chain** | Recursively expand "who calls it" with the current center as the end point (impact analysis) |
| **⇢ Path** | Click two nodes in turn to highlight the call path between them (Esc to exit) |
| **🔥 Hotspot** | Toggle hotspot view: node cards scale with **in-degree** (how often they are called), so the core functions stand out at a glance; click again to turn it off |
| **⎘ Stack locate** | Paste a runtime stack trace and resolve `file:line[:column]` to the matching symbol, then open its call graph (handles the common TS/JS, Python, Go, Java, Rust, PHP and Vue stack formats; frames inside `node_modules`/`vendor`/`dist`/`build` are skipped, up to 50 frames) |
| **⌘K / Ctrl+K** | Open the command palette: type to filter, ↑↓ to move, Enter to run (focus search / expand upstream chain / start path finding / paste stack / copy share link / toggle theme / toggle noise nodes / reset canvas / reindex / open help) |
| **❓ Help** | Opens the usage dialog, whose 「试一试」 ("try it") button runs a one-click demo |
| **Cancel expansion** | A full-chain expansion can be cancelled at any time; the backend stops in sync |
| **Noise node toggle** | When off, filters out minified/obfuscated files (.min.js), dependency directories (node_modules/vendor), build output (dist/build/out) and vendored code (external/third_party); when on, everything shows |
| **✦ Node kind filter** | Shows only the selected kind (method / function / class / route) and hides the rest (the center node always stays visible) |
| **✦ Highlight nodes** | Type a keyword: matching nodes stay crisp and the rest dim; it survives redrawing the graph, and Esc clears it |
| **Keyboard shortcuts** | `u` undo expand · `r` reset · `/` focus the search box |
| **Breadcrumb** | Shows your navigation path at the top; click any step to jump back |
| **Reset** | Clears history and canvas, back to the initial state |
| **Share link** | The current graph state is written into the URL hash — copy the link to share, reload to restore |
| **Stale index notice** | A background watcher compares file content hashes to tell real edits from metadata churn; after you change code, a pill appears at the top of the canvas offering to reindex |

### Canvas helpers

- **Orange dashed edges** = back edges (call cycles / callbacks), handy for spotting circular dependencies
- **Minimap** (bottom right) = miniature node cards (shown from 4 nodes up) with the current viewport, click to jump
- **Export** = SVG / PNG / JSON / Mermaid (Mermaid embeds nicely in Markdown docs)
- **Source panel** = floats above the canvas (collapsible into a pill) with syntax highlighting (approximate coloring shared across TS/Go/PHP) and one-click copy of source or path
- **Theme** = follows the system light/dark by default; the 🌙/☀️ pill in the header switches manually and remembers

### Watching several projects at once (▣ Projects)

When you run one `cgv view` per project (on different ports), use 「▣ 项目」 (Projects) at the bottom to save their addresses (in localStorage, up to 12):
click 「打开」 (Open) to jump to one, the project you are currently on is marked 「· 当前」, and ✕ removes an entry.

## Status bar (right of the search box)
Shows the current context live: file counts / number of search results / how many callers and callees the current symbol has.

---

## Architecture

- `bin/cgv.ts`: command dispatcher — `view` starts the visualizer, everything else is forwarded verbatim to the codegraph dependency
- `server.ts`: a `node:http` static server plus the API layer (caching, gzip, SSE, concurrency limiting, reindex mutual exclusion, stale-index watching; hash baselines are built asynchronously in batches so they never block the event loop)
- `lib/*.ts`: testable pure-logic modules (**real TypeScript, zero build**, see below) — `validate` (input validation / shell safety) · `proc` (subprocess runner) · `textparse` (the CLI-output contract layer) · `routes` (Laravel route parsing) · `urlmap` (custom framework URL lookup) · `sourcecalls` (source-level dynamic call completion) · `trace` (full-chain BFS, cancellable in both directions)
- `public/index.html`: single-page frontend, plain SVG rendering, no framework or dependency

API:
- `GET /api/search?q=&kind=&regex=` → symbol search (kind filter / regex)
- `GET /api/graph?symbol=&file=` → a symbol's callers + callees + source (30s cache, key = symbol+file)
- `GET /api/trace/stream?symbol=&file=&depth=&maxNodes=&direction=` → SSE stream that expands a call chain recursively; emits `progress` events while working and a `result` event carrying `{ nodes, edges, direction }`; disconnecting the client cancels it. Repeating the same parameters within 60s replays the cached result (partial results from a cancellation are not cached)
- `GET /api/status` → stale-index state and runtime info (including the absolute project `root`, which the frontend uses to turn relative file paths into absolute ones for "open in editor")
- `GET /api/symbols?file=` → the symbol list of one file (60s cache plus in-flight coalescing for the same file; a single call runs codegraph and can take tens of seconds on a big file)
- `GET /api/files` → every file (with symbol counts)

Security:
- Listens on 127.0.0.1 by default; exposing it via `--host` prints a startup warning
- Arguments go through `safeArg` (rejects every control character) and `safeFile` (blocks path traversal)
- On Windows, shell paths ending in `.cmd` additionally block cmd metacharacters (`& | % ^` …)
- Static serving is resolved with `path.relative` to prevent prefix bypass
- Reindex is single-flight with a cooldown so concurrent writes cannot corrupt the index

Tests and type checking:
```bash
npm test          # unit tests (pure lib functions + CLI output contracts) + server integration tests + frontend tests (node:vm)
npm run typecheck # TypeScript checking (checkJs, zero build, checks only)
npm run e2e       # end-to-end smoke test (starts the server against any fixture projects that exist)
                  # the fixture list is read from scripts/fixtures.local.json (copy the .example.json and edit it);
                  # you can also pass directories directly:
                  #   node scripts/e2e.ts /path/to/your-project
```

> On type checking: the project **does not need a build**. The backend (`server.ts` / `bin/*.ts` / `lib/*.ts` / `scripts/*.ts`)
> is real TypeScript, while the frontend `public/app.js` and the `test/*.test.mjs` tests are covered by `checkJs`;
> the toolchain only performs static analysis and emits nothing.
> **`strict` is fully on**: no implicit any, no explicit any, with `strictNullChecks` and
> `useUnknownInCatchVariables` enabled as well. Untrusted boundaries like CLI output use the generic
> `parseJson<T>(raw, fallback)` plus contract types (`SymbolNode` / `NeighborsPayload` …) declared at the call site;
> catch variables all go through `errMsg(e)` (the backend's `lib/err.ts`, and a frontend-local copy). Nullability has been
> worked through spot by spot: guards where guards are possible, with the necessary assertions concentrated in a few
> places that say why.
> Migration progress and roadmap live in a local internal document that is not distributed with this repository.

### Why is the backend `.ts`?

`server.ts` / `lib/*.ts` / `bin/*.ts` are **real TypeScript with no build step** — Node (≥22.18)
strips the types natively and runs them directly, so `server.ts` imports `./lib/trace.ts` as usual. What you get is the
value of types themselves: the contract types live in `lib/textparse.ts` (the single conversion point from
"codegraph CLI output" to internal structures, i.e. `SymbolNode` / `TrailEntry` …), while interfaces such as
`Runner` / `RouteEntry` / `SymbolResolver` / `TraceResult` / `TraceContext` let the modules — and the handlers and caches
inside `server.ts` — be checked against real field names and shapes (`server.ts` also defines API response contracts like
`GraphPayload` / `SymbolsPayload`).

Test files stay `.test.mjs`: `node --test` only auto-discovers `*.test.?(c|m)js`, so renaming them to `.ts`
risks having tests **silently skipped**; they are still checked by `checkJs` and can `import` `.ts` modules directly.

That comes with two hard constraints:

- Syntax must be **erasable** (no `enum` / `namespace` / constructor parameter properties), enforced by tsconfig's
  `erasableSyntaxOnly`;
- Consequently **`cgv view` requires Node ≥ 22.18** (`cgv <other commands>` merely forwards to codegraph and is unaffected).
  `bin/cgv.ts` reports a clear message when the version is too low instead of throwing `ERR_UNKNOWN_FILE_EXTENSION`.

This route was chosen over compiling with `tsc` into `dist/` to keep what the project has had from day one:
edit the code and `node server.ts` just runs — real `.ts` and zero build are not in conflict.
