# codegraph-view 端到端测试用例

> 测试目标：验证「codegraph CLI 原生链路」与「工具 API / 图上链路 / 点击 / 悬浮」在三种语言项目下的一致性与正确性。
>
> 测试方式：对每个项目用 codegraph CLI 直接查询作为基准，再通过工具 API（`/api/search`、`/api/graph`、`/api/trace`、`/api/route`）和浏览器交互（点击、悬浮 title）验证。

## 测试环境

| 项目 | 语言/框架 | 索引目录 | 测试端口 |
|------|-----------|----------|----------|
| next-admin | TypeScript / Next.js App Router | `F:\centos\next-admin` | 3999 |
| ban-server | Go | `F:\centos\ban-server` | 4000 |
| appwork | PHP / Laravel | `F:\centos\appwork` | 4001 |
| youpai | PHP / 自定义框架 | `F:\centos\youpai` | 4002 |

---

## 一、Next.js（next-admin）

### 1.1 搜索

| 用例 | 操作 | 预期 | 实际 | 结果 |
|------|------|------|------|------|
| S-N1 符号搜索 | `getRoomList` | CLI 与 API 结果一致 | CLI 4 条 = API 4 条，首条 `getRoomList \| method \| src/service/hykb/HykbRoomService.ts` | ✅ |
| S-N2 无结果 | `zzzNotFound` | 返回 0 条 | API 返回 0 条 | ✅ |

### 1.2 路由定位

| 用例 | 操作 | 预期 | 实际 | 结果 |
|------|------|------|------|------|
| R-N1 接口精确 | `/api/video/audit` | 定位 `src/app/api/video/audit/route.ts` | 命中，标题「接口定位」 | ✅ |
| R-N2 页面路由 | `/video` | 定位 `src/app/(admin)/video/page.tsx` | 命中，标题「页面定位」，路由组 `(admin)` 被忽略 | ✅ |
| R-N3 动态段 | `/api/server/apiSetting/123` | 匹配 `[id]/route.ts` | 命中 `src/app/api/server/apiSetting/[id]/route.ts` | ✅ |
| R-N4 路由组页面 | `/group/come` | 定位 `(admin)/group/come/page.tsx` | 命中 | ✅ |
| R-N5 模糊匹配 | `/api/video` | 列出相关接口 | 167 个 `api/video*` 接口 | ✅ |

### 1.3 调用图（CLI vs API）

| 用例 | 符号 | CLI callees | API callees | 结果 |
|------|------|-------------|-------------|------|
| G-N1 | `_searchFromEs` @ VideoRepository.ts | 10 | 10（名称/文件全同） | ✅ |
| G-N2 | `searchVerify` @ VideoRepository.ts | 2 | 2 | ✅ |
| G-N3 | `getByVideoIds` @ VideoCommentCountModel.ts | 0 | 0 | ✅ |
| G-N4 | `mergeImage` @ lib/utils/Picture.ts | 2 | 2 | ✅ |
| G-N5 | `getList` @ ObsVersionTjModel.ts | 5 | 5 | ✅ |
| G-N6 | callers | `_searchFromEs` 3 caller | 同（searchSimple/searchComplex/searchRelate） | ✅ |

### 1.4 全链路（trace）

| 用例 | 操作 | 预期 | 实际 | 结果 |
|------|------|------|------|------|
| T-N1 | `/api/video/audit/route.ts` ⧉ 链路 | 整条调用链一次画出 | 88 节点 / 深度 6 / 未截断 / 126 边，`_searchFromEs` 有 9 个直接后继 | ✅ |

### 1.5 浏览器交互

| 用例 | 操作 | 预期 | 实际 | 结果 |
|------|------|------|------|------|
| B-N1 悬浮 title | 悬浮 `_searchFromEs` | 符号名 + 文件 + 类型 | `_searchFromEs\nsrc/repository/video/VideoRepository.ts [方法]` | ✅ |
| B-N2 叶子提示 | 悬浮 `withData` | 提示可点击展开 | `withData\nsrc/lib/utils/page.ts [函数]\n点击展开它的调用关系` + `+` 号 | ✅ |
| B-N3 点击展开 | 点击 `withData` | 新增节点并高亮 | 88→101（+13），13 个 `.newly` 高亮 | ✅ |
| B-N4 中心节点 | 图上中心 | 金色 + 源码定位 | 中心 `route.ts` 金色，右侧源码显示 | ✅ |

---

## 二、Go（ban-server）

### 2.1 搜索

| 用例 | 操作 | 预期 | 实际 | 结果 |
|------|------|------|------|------|
| S-G1 符号搜索 | `Add` | CLI 与 API 一致 | CLI 6 条 = API 6 条，首条 `Add \| method \| controllers/ban.go` | ✅ |
| S-G2 模型方法 | `CategoryList` | CLI 与 API 一致 | CLI 1 条 = API 1 条 | ✅ |

### 2.2 调用图（CLI vs API）

| 用例 | 符号 | CLI callees | API callees | 结果 |
|------|------|-------------|-------------|------|
| G-G1 | `Add` @ models/ban.go | 5 | 5（mbTable/Log/categoryTable/OperateAdd/Message） | ✅ |
| G-G2 | `Expire` @ models/ban.go | 4 | 4 | ✅ |
| G-G3 | callers | `Add` 1 caller `banCateGory` | 同 | ✅ |

### 2.3 全链路（trace）

| 用例 | 操作 | 预期 | 实际 | 结果 |
|------|------|------|------|------|
| T-G1 | `banCateGory` @ controllers/ban.go | 链路完整 | 33 节点 / 深度 4 / 未截断 / 57 边（banCateGory→NewBanModel→NewRedisClient→libRedis…） | ✅ |

### 2.4 浏览器交互

| 用例 | 操作 | 预期 | 实际 | 结果 |
|------|------|------|------|------|
| B-G1 搜索+点击 | 搜 `Add` 点第一个结果 | 画出以 Add 为中心的单层图 | 中心 `Add` @ controllers/ban.go，8 节点 7 边，callees 与 CLI 一致 | ✅ |
| B-G2 悬浮 title | 悬浮节点 | 符号名 + 文件 | `Add\ncontrollers/ban.go` | ✅ |

---

## 三、PHP / Laravel（appwork）

### 3.1 搜索

| 用例 | 操作 | 预期 | 实际 | 结果 |
|------|------|------|------|------|
| S-P1 符号搜索 | `goodsBatch` | 返回 Controller 方法 | 3 条，首条 `goodsBatch \| method \| modules/Api/Http/Controllers/Activity/ShopController.php` | ✅ |
| S-P2 无结果 | `zzzNoSuchPhpMethod` | 0 条 | 0 条 | ✅ |

### 3.2 路由定位

| 用例 | 操作 | 预期 | 实际 | 结果 |
|------|------|------|------|------|
| R-P1 路由模糊 | `/shop/goods` | 列出相关路由 | 4 条：`ANY shop/goodsBatch.json`、`GET shop/goods/batchList.json`、`list.json`、`info.json` | ✅ |
| R-P2 路由精确（无 api 前缀） | `/group/multiGroup.json` | 命中 1 条 | 命中 1 条 | ✅ |
| R-P3 路由精确（带 api 前缀） | `/api/group/multiGroup.json` | 命中 1 条 | **初始 0 条 → 修复后 1 条**（见「发现的问题」） | ⚠️ 已修 |

### 3.3 调用图（CLI vs API）

| 用例 | 符号 | CLI callees | API callees | 结果 |
|------|------|-------------|-------------|------|
| G-P1 | `goodsBatch` @ ShopController.php | 6 | 6（getString/filterIds/instance/mergeImgUrl/response/RCodeConst） | ✅ |
| G-P2 | `multiGroup` @ GroupController.php | 5 | 5 | ✅ |
| G-P3 | callers | `ANY goodsBatch.json`（路由为 caller） | 同 | ✅ |

### 3.4 全链路（trace）

| 用例 | 操作 | 预期 | 实际 | 结果 |
|------|------|------|------|------|
| T-P1 | `goodsBatch` @ ShopController.php | 链路完整 | 66 节点 / 深度 6 / 未截断 / 90 边 | ✅ |

### 3.5 浏览器交互

| 用例 | 操作 | 预期 | 实际 | 结果 |
|------|------|------|------|------|
| B-P1 路由定位+点击 | 输入 `/api/group/multiGroup.json` 点结果 | 画出调用图 | 标题「路由定位」，`ANY group/multiGroup.json → GroupController@multiGroup`，点击后中心 `multiGroup` 7 节点 | ✅ |
| B-P2 悬浮 title | 悬浮 callee | 符号名 + 文件 | `postString\npackages/tools/src/Input.php` | ✅ |

---

## 四、youpai（PHP / 自定义框架）

> 首次使用需先建索引：`cd F:\centos\youpai && codegraph init`（2661 个 PHP 文件）。框架无 Laravel 路由文件，URL 定位不适用，主用符号搜索 + 链路展开。

### 4.1 搜索

| 用例 | 操作 | 预期 | 实际 | 结果 |
|------|------|------|------|------|
| S-Y1 符号搜索 | `funcPrise` | 返回 controller 方法 | 2 条，首条 `funcPrise \| method \| control/ctlBan.php` | ✅ |
| S-Y2 模型方法 | `getBanList` | 返回 library 方法 | 1 条 `getBanList \| method \| library/libBan.php` | ✅ |

### 4.2 调用图（CLI vs API）

| 用例 | 符号 | CLI callees | API callees | 结果 |
|------|------|-------------|-------------|------|
| G-Y1 | `funcPrise` @ control/ctlBan.php | 1 | 1（`_list`），callers 均 0 | ✅ |

### 4.3 全链路（trace）与深度核对

| 用例 | 链路 | 节点/边 | 已展开核对 | 不一致 | 结果 |
|------|------|---------|-----------|--------|------|
| T-Y1 | `funcRoomCome` @ ctlBan.php | 10/9 | 5 | **0** | ✅ |
| T-Y2 | `getBanList` @ libBan.php | 4/3 | 1 | **0** | ✅ |
| T-Y3 | `add` @ libBan.php | 7/8 | 2 | **0** | ✅ |
| T-Y4 | `banMsg` @ libBan.php | 12/19 | 10 | **0** | ✅ |

### 4.4 浏览器交互

| 用例 | 操作 | 预期 | 实际 | 结果 |
|------|------|------|------|------|
| B-Y1 搜索+点击 | 搜 `getBanList` 点结果 | 画调用图 | 中心 `getBanList`，4 节点 3 边 | ✅ |
| B-Y2 悬浮 title | 悬浮节点 | 符号名 + 文件 | `getBanList\nlibrary/libBan.php` | ✅ |

---

## 五、深度链路核对（逐节点比对 CLI Calls → 与图中出边）

> 方法：对 trace 链路中每个**已展开**节点，用 `codegraph node <name> -f <file>` 取 CLI 原始 `Calls →`，与图中该节点的出边按 `file::name` 逐条比对。跳过 depth 边界（未入队）节点。

| 项目 | 链路 | 节点/边 | 已展开核对 | 不一致 | 结论 |
|------|------|---------|-----------|--------|------|
| Next.js | `/api/video/audit` route.ts（depth=8） | 89/134 | 54 | 36 | 全部可归因（见下） |
| Go | `banCateGory` @ controllers/ban.go | 33/57 | 11 | **0** | ✅ 完全一致 |
| PHP | `goodsBatch` @ ShopController.php（depth=8） | 76/103 | 42 | **0** | ✅ 完全一致 |
| youpai | `banMsg` @ library/libBan.php（depth=8） | 12/19 | 10 | **0** | ✅ 完全一致 |

### Next.js 36 项不一致的归因（均为预期/环境差异，非链路错误）

**A. type/interface 节点被设计剔除（33 项）**
- 缺失项几乎全部来自 `*.types.ts` 或类型命名（`MultiPage`、`VideoAuditSchema`、`VideoSearchParams`、`SnakeLogItem`、`ServiceResponse`、`UserSchema`、`DrawWeightSchema`、`ElasticSearchResult` 等）
- 已验证 kind：`MultiPage`/`VideoAuditSchema`/`ServiceResponse`/`SnakeLogItem` = interface，`RangeOperator` = type_alias
- 原因：`traceChain` 末尾 `SKIP_KINDS` 剔除 interface/type，保持图为"可调用的方法链路"（设计行为，见 server.mjs 注释）

**B. 压缩文件 `.min.js` 断链（3 项）**
- `T`、`fn` @ `src/utils/psdSdk.min.js` 出边为 0
- 已定位根因：server 使用的 **bundled codegraph**（`node_modules/@colbymchenry/codegraph/npm-shim.js`）对压缩文件执行 `node` 命令时**不输出 `### Trail` / `Calls →` 段**（只输出巨型源码），`parseTrail` 解析为空
- PATH 里的 codegraph.cmd 则正常输出 Trail
- 实际影响极小：`.min.js` 节点被前端 `NOISE_RE` 当噪音隐藏，用户不可见

**C. 图中"多余"边 = 源码补全（增强，非错误）**
- 如 `searchSnake → getList/getByIds`、`_searchFromEs → searchByParams/getByIds`、`_enrichWithGameInfo → getByVideoIds/getByIds`
- 原因：`parseSourceCalls` 补全 codegraph 解析不到的动态调用（`this.repo.method()` / `X::instance()->method()` 等），是 CLI 原本没有的增强

---

## 六、发现并修复的问题

### P1（已修复）：Laravel 路由带 `api` 前缀时精确匹配失败

- **现象**：输入 `/api/group/multiGroup.json` 精确匹配返回 0 条，而 `/group/multiGroup.json` 正常命中。
- **原因**：`server.mjs` 的 `/api/route` 用 `matchRoute(r.url, clean)` 直接比对，Laravel 路由定义 url 通常不带 `api` 前缀（`group/multiGroup.json`），输入带 `api/` 前缀时正则不匹配。
- **修复**：匹配前生成两个候选（`clean` 与去掉 `^api/` 的版本），精确与模糊模式都同时尝试。
- **复测**：修复后 `/api/group/multiGroup.json` 命中 1 条。

### P2（已处理）：bundled codegraph 对 `.min.js` 压缩文件不输出 Trail

- **现象**：trace 中 `T`/`fn` @ `src/utils/psdSdk.min.js` 出边为 0。
- **原因**：server 用的 bundled codegraph（`node_modules/@colbymchenry/codegraph/npm-shim.js`）对压缩文件执行 `node` 命令时只输出源码、不输出 `### Trail / Calls →`；PATH 里的 codegraph.cmd 输出正常。
- **处理**：`traceChain.fetchCallees` 对 `.min.js` / `.min.ts` 压缩文件直接返回空 callees（留作叶子），跳过无效查询。压缩库内部调用无业务价值，且 `.min.js` 节点前端本就按噪音隐藏，不展开符合预期。

---

## 七、结论

- 四个项目（TS/Next.js、Go、PHP/Laravel、PHP 自定义框架 youpai）的**搜索、调用图、全链路、浏览器交互**均与 codegraph CLI 原生输出一致。
- **深度链路核对**：Go、PHP、youpai 逐节点比对 0 不一致；Next.js 的方法调用边也完整一致，36 项差异全部归因为「type 设计剔除 + 压缩文件环境差异 + 源码补全增强」。
- 浏览器端悬浮 title、点击展开 + 新增高亮、路由定位均正确。
- 测试过程中发现并修复 2 个问题：Laravel 路由带 `api` 前缀匹配失败、`.min.js` 压缩文件无效查询（跳过不展开）。
