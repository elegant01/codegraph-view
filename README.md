# CodeGraph 可视化（codegraph-view）

把 CodeGraph 索引的**代码符号调用关系**画成可交互的图，并集成了 codegraph 的全部命令。

## 安装与使用

**方式一：全局 npm 包（推荐，可分享）**

```bash
cd scripts/codegraph-viz
npm pack                          # 生成 codegraph-view-1.0.0.tgz
npm i -g ./codegraph-view-1.0.0.tgz
```

之后在任何**已用 codegraph 建好索引**的项目根目录：

```bash
cgv view          # 启动可视化，默认 39267 端口，浏览器打开 http://localhost:39267
cgv view 3456     # 指定端口
cgv view 3456 --host 0.0.0.0   # 允许局域网访问（默认仅 127.0.0.1，注意安全提示）
cgv query xxx     # 其余命令全部等同 codegraph（init / callers / callees / node ...）
cgv               # 查看帮助
```

- 默认只监听 **127.0.0.1**（本机工具，防局域网访问你的源码）；需要分享时显式 `--host`
- codegraph 本体作为依赖自动安装，**不需要单独装 codegraph**
- 分享给别人：把 `codegraph-view-1.0.0.tgz` 发给对方，`npm i -g codegraph-view-1.0.0.tgz` 即可
- 命令有两个名字：`cgv` 和 `codegraph-view`，效果一样

**方式二：仓库内直接跑（开发用）**

```bash
node scripts/codegraph-viz/server.mjs [端口]   # 默认 39267，退回用 PATH 里的 codegraph
```

---

## 界面分区

```
┌──────────────────────────────────────────────────────────┐
│ 顶部：搜索框 · 搜索 · 重置 · 面包屑 · 状态栏              │
├──────────┬────────────────────────────────┬──────────────┤
│ 左侧面板 │        中间：调用关系图         │  右侧：源码   │
│ (文件/   │   调用者 ← [中心符号] → 被调用者 │              │
│  搜索)   │                                │              │
└──────────┴────────────────────────────────┴──────────────┘
```

### 左侧面板（两种模式二选一）

**📁 文件浏览**（默认）
- 按每个文件里被索引到的**符号总数**倒序排列（函数/类/方法/类型都算）
- 每行前面的数字 = 该文件的符号数量
- 顶部过滤框可按路径关键词筛选
- **点文件** → 列出该文件里的所有符号；**点符号** → 画出调用关系图
- 单文件符号列表受 codegraph 上限影响最多显示前 200 个，超出时列表底部提示「共 N 个」，其余用顶部搜索直达
- 左侧面板可像右侧源码一样**折叠/展开**（顶部「‹ / ›」按钮，或折叠后点击左侧竖条）

**🔍 搜索结果**
- 在顶部搜索框输入符号名后出现
- 标签是中文类型：方法 / 类 / 接口 / 类型 / 属性 / 变量 / 函数 / 路由
- 点任意一条 → 画出它的调用关系图
- **输入接口 URL**（如 `/api/activity/DanceImage/list`）→ 自动定位到对应 `route.ts` 接口文件
  - 支持 query 参数剥离（`/api/xxx?page=2` 同样能定位）
  - 支持 Next.js 动态路由段通配（`/api/user/123` → 匹配 `[id]/route.ts`）
  - **精确匹配无结果时自动模糊匹配**：输入部分片段（如 `/api/room`）会列出所有包含该片段的 Laravel 路由 / `route.ts` 文件
- 每条结果右侧的 **「⧉ 链路」** 按钮 → 递归展开它调用的**全部方法链**（只向下，一次画成整棵调用树）；**Shift+点击** → 向上展开**谁调用了它**（影响面分析）

### 搜索增强

- **类型过滤**：搜索框右侧下拉，只匹配方法/函数/类/接口/属性等
- **正则模式**：勾选「正则」后搜索词按正则匹配（如 `get.*List`）
- **最近搜索**：输入框下拉自动提示最近 12 条搜索（localStorage）

### 按项目类型查询

**Next.js / TypeScript**
- 符号名搜索：`getRoomList`、`searchVerify`
- 接口 URL：`/api/video/audit` → 定位 `src/app/api/video/audit/route.ts`
- 页面路径：`/video` → 定位 `src/app/(admin)/video/page.tsx`（自动忽略 `(admin)` 等路由组）
- 动态段：`/api/server/apiSetting/123` → 匹配 `[id]/route.ts`；`/group/123` → 匹配页面 `[id]`
- 模糊：输入部分片段（如 `/api/video`、`/group/come`）自动列出相关接口/页面

**Go（beego / gin）**
- 直接搜索函数/方法名：`Add`、`CategoryList`、`GetList`
- 从 HTTP handler（controller 方法）点「⧉ 链路」展开整条调用链
- **beego 路由定位**：`/v1/ban/add` → `BanController@Add`（支持 `NewNamespace`/`NSNamespace` 嵌套前缀、`NSRouter`/`Router` 方法映射、`NSInclude` + `@router` 注解、内联处理器）
- **gin 路由定位**：`/api/v1/ban/list` → `banCtl.List`（支持 `Group` 前缀、`ctl := &XxxController{}` 变量类型追踪、中间件链取末位处理器、匿名处理器定位到文件行号）
- 动态段：`/user/123` 匹配 `:id` 通配；`/static/a/b.js` 匹配 `*filepath` 多段通配

**PHP / Laravel**
- 搜索方法名：`goodsBatch`、`multiGroup`
- 路由 URL：`/api/group/multiGroup.json` 或 `shop/goodsBatch.json` → 定位到 `Controller@method`
- 路由模糊：输入部分片段（如 `/shop/goods`）列出所有相关路由
- 支持 query 参数剥离（`?page=2` 不影响定位）；`{id}` 路由段自动通配

**自定义框架（如 youpai 的 ctlXxx.php）**
- **自动探测，无需配置**：工具会扫描项目目录，自动识别 `control/` + `ctlXxx.php` + `funcXxx` 方法约定。输入真实后台 URL（如 `/youpai/groupMoney.html`、`/youpai/tv/room.html`、`/youpai/tv/Video-index.html`）自动定位到对应方法并画图/展开链路
- 自动探测覆盖的约定：
  - 控制器目录：`control/`（含子目录做模块分组）
  - 文件命名：`ctl<Controller>.php` 或模块前缀 `ctl<Module><Controller>.php`（如 `tv/room.html` → `control/tv/ctlTvRoom.php`）
  - 方法命名：`func<Method>`（`Video-index` → `funcIndex`），URL 无方法段默认 `funcIndex`，方法不存在时回退文件第一个 `func` 方法
- **配置文件可选**：只有当个别 URL 命名不规则、自动探测匹配不到时，才需要 `codegraph.route.json`，且只需写 `overrides` 特例（几乎零维护）：

```json
{
  "overrides": {
    "/youpai/data/data.html": "control/data/ctlDataAnchor.php::funcMonthRank"
  }
}
```

- 若自动探测不适用于你的框架（目录/前缀不同），可配完整规则（`patterns` 存在时会替代自动探测）：

```json
{
  "basePath": "/youpai",
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

- 字段说明：
  - `basePath`：URL 公共前缀（如 `/youpai`），匹配前剥除
  - `patterns`：URL 模式列表，按顺序尝试；`{module}`/`{controller}`/`{method}` 为通配段
  - `defaultMethod`：URL 无方法段时的默认方法（映射时自动加前缀）
  - `controller`：控制器文件规则 —— `dir` 目录、`prefix` 类前缀（ctl）、`ext` 扩展名、`trySubdir` 是否优先试 `<dir>/<module>/` 再回退 `<dir>/`
  - `method`：方法命名规则 —— `prefix`（func）、`capitalize` 首字母大写
  - `overrides`：规则匹配不到的例外 URL，直接映射到 `文件::方法`

### 多 git workspace（聚合仓库模式）

一个项目根目录下可能**嵌套多个独立 git 仓库**（git submodule / 嵌套仓库），例如 appwork：

```
appwork/                      ← 聚合根目录（.git）
├── modules/                  ← 业务模块（每个模块都是独立 .git）
│   ├── Api/    (.git)
│   ├── Manager/(.git)
│   ├── Phone/  (.git)
│   └── Web/    (.git)
├── packages/                 ← 工具包（独立 .git）
│   ├── tools/  (.git)
│   └── logger/ (.git)
├── services/   (.git)
└── vendor/
```

**在聚合根目录启动一次即可**，工具自动覆盖所有嵌套 git 仓库的代码：

```bash
cd /path/to/appwork
# 关键：codegraph 默认忽略嵌套 git 仓库，需用 codegraph.json 显式包含
# （appwork 即通过 includeIgnored 把 modules/、services/ 纳入索引）
echo '{ "includeIgnored": ["modules/", "services/"] }' > codegraph.json
codegraph init   # 索引包含全部子仓库代码
cgv view 4001    # 搜索/调用图/链路对 modules、packages、services 里的代码都生效
```

- 嵌套仓库无需各自建索引或各自启动服务——索引和定位都按整个目录工作（appwork 的 `goodsBatch` 位于 `modules/Api/Http/Controllers/...`，在聚合根目录可直接搜到）
- 自定义框架的 `codegraph.route.json`（如需 overrides）同样放在聚合根目录，对所有子仓库统一生效
- 平级且互不嵌套的独立项目（如 youpai、next-admin、ban-server）才需要分别在各自根目录启动：

```bash
cd /path/to/youpai     && cgv view 4002   # PHP 自定义框架
cd /path/to/next-admin && cgv view 3999   # Next.js
cd /path/to/ban-server && cgv view 4000   # Go
```

### 中间：调用关系图

以某个符号为中心，画出它的直接调用关系：

| 位置 | 含义 | 颜色 |
|------|------|------|
| 中心 | 当前选中的符号 | 金色 |
| 左边 | **调用者** —— 谁调用了它 | 绿色 |
| 右边 | **被调用者** —— 它调用了谁 | 蓝色 |

- 连线上的**箭头**表示调用方向
- 左下角有固定**图例**
- 列标题直接写明「调用者（谁调用了它）」「被调用者（它调用了谁）」

### 右侧：源码
显示当前符号的源码、所在文件、调用关系 Trail。点中心节点可重新定位到这里。

---

## 交互操作

| 操作 | 效果 |
|------|------|
| **滚轮** | 缩放图 |
| **拖拽空白处** | 平移图 |
| **＋ / － / ⟲** | 放大 / 缩小 / 重置视图 |
| **点击普通节点** | 以它为中心，重新展开一张调用图 |
| **点击中心节点** | 右侧定位到它的源码 |
| **↩ 撤销展开** | 撤销最近一次点击节点展开，回到展开前状态（可多级撤销） |
| **⇈ 上游链** | 以当前中心为终点，向上递归展开「谁调用了它」（影响面分析） |
| **⇢ 路径** | 依次点击两个节点，高亮它们之间的调用路径（Esc 退出） |
| **取消展开** | 全链路展开中可随时点「取消」，后端同步终止 |
| **噪音节点开关** | 关闭时过滤压缩混淆文件（.min.js）、依赖目录（node_modules/vendor）、编译产物（dist/build/out）、外部引入（external/third_party）等噪音节点，打开则全部显示 |
| **快捷键** | `u` 撤销展开 · `r` 重置 · `/` 聚焦搜索框 |
| **面包屑** | 顶部显示浏览路径，可点回任意一步 |
| **重置** | 清空历史与画布，回到初始状态 |
| **链接分享** | 当前图状态自动写入地址栏 hash，复制链接即可分享，刷新自动恢复 |
| **索引过期提示** | 后台 watch 项目目录，代码变更后顶部提示重新索引 |

### 图面辅助

- **橙色虚线边** = 回边（调用环/回调），快速发现循环依赖
- **右上角 minimap** = 大图概览，显示当前视口位置，点击跳转
- **导出** = SVG / PNG / JSON / Mermaid 四种格式（Mermaid 可嵌入 Markdown 文档）
- **源码面板** = 语法高亮（TS/Go/PHP 通用近似着色）+ 一键复制源码/路径

## 状态栏（搜索框右侧）
实时显示当前上下文：文件统计 / 搜索结果数 / 当前符号的调用者·被调用者数量。

---

## 架构

- `bin/cgv.mjs`：命令分发器 —— `view` 启动可视化服务，其余参数原样转发给包内依赖的 codegraph
- `server.mjs`：node:http 静态服务 + API 层（缓存、gzip、SSE、并发限流、reindex 互斥、索引过期 watch）
- `lib/`：可测试的纯逻辑模块 —— `validate`（输入校验/shell 安全）· `proc`（子进程执行器）· `textparse`（CLI 输出契约层）· `routes`（Laravel 路由解析）· `urlmap`（自定义框架 URL 定位）· `sourcecalls`（源码级动态调用补全）· `trace`（全链路 BFS，双向可取消）
- `public/index.html`：单页前端，纯 SVG 画图，无任何框架/依赖

API：
- `GET /api/search?q=&kind=&regex=` → 符号搜索（类型过滤 / 正则）
- `GET /api/graph?symbol=&file=` → 某符号的 callers + callees + 源码
- `GET /api/trace/stream?symbol=&file=&depth=&maxNodes=&direction=` → 递归展开调用链的 SSE 流式接口；发送 `progress` 事件报告进度，发送 `result` 事件返回 `{ nodes, edges, direction }`，客户端断开即自动取消
- `GET /api/status` → 索引过期提示 / 运行信息
- `GET /api/symbols?file=` → 某文件内的符号列表
- `GET /api/files` → 全部文件（含符号数）

安全：
- 默认仅监听 127.0.0.1；`--host` 暴露时启动有警告
- 参数经 `safeArg`（拒绝全部控制字符）/`safeFile`（防路径穿越）校验
- Windows `.cmd` shell 路径额外拦截 cmd 元字符（& | % ^ 等）
- 静态目录用 `path.relative` 判定，防前缀绕过
- reindex single-flight + 冷却，防并发写坏索引

测试：
```bash
npm test         # 单元测试（lib 纯函数 + CLI 输出契约）
npm run e2e      # 端到端冒烟（对存在的 fixture 项目起服务验证 API）
```
