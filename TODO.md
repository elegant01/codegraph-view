# codegraph-view 改进清单

> 规则：每完成一项，单独提交一次 git（commit 信息注明对应编号）。
> 勾选状态：`[ ]` 未开始 / `[x]` 已完成。

## 一、功能增强（图谱交互）

- [x] **F1 节点悬停代码预览**：hover 节点弹出代码片段 Tooltip。server.mjs 加 `/api/source?file=X&line=N`（safeFile 防逃逸，2MB 上限）；前端 `#nodeTip` 用 `getBoundingClientRect()` 定位（兼容 viewport translate/scale），防抖 180ms + Map 缓存；语法高亮逐段 token 提取后分别 esc 防 XSS。参考实现：`public/index.html.opt-20260825`。
- [ ] **F2 两点路径查找**：选中 A、B 两个节点，BFS 求 A→B 调用路径并高亮，纯前端（数据已在图模型中）。
- [ ] **F3 节点右键菜单**：以此为中心 / 展开上层 / 展开下层 / 复制文件路径 / 在编辑器打开（`vscode://file/...` 协议）。
- [ ] **F4 图快照/书签**：当前图状态（中心节点 + 展开层级）存 URL hash 或 localStorage，可分享、可回看。
- [ ] **F5 子图过滤**：按符号类型（function/method/class）或目录过滤节点，大图聚焦模块。

## 二、功能增强（分析能力）

- [ ] **F6 实现/接口跳转**：点击 interface 或接口方法时列出所有实现类/实现方法。
- [ ] **F7 影响面分析**：选中函数后向上递归展开 callers 并按层级染色（后端 `/api/trace?direction=up` 已支持，补前端入口与可视化）。
- [ ] **F8 热点视图**：节点大小映射入度（callers 数量），标出系统核心枢纽函数。
- [ ] **F9 跨仓库标注**：聚合仓库模式下节点标注所属子仓库，点击可切换中心。

## 三、功能增强（搜索与定位）

- [ ] **F10 搜索结果分组**：按 kind 或目录分组显示，替代平铺。
- [ ] **F11 侧栏文件树**：`/api/files` + `/api/symbols` 均已就绪，纯前端组装：文件树 → 点文件列符号 → 点符号入图。
- [ ] **F12 粘贴堆栈定位**：粘贴报错堆栈自动解析 `file:line` 并跳转对应符号。
- [ ] **F13 命令面板（Ctrl+K）**：聚合搜索、路由定位、重新索引、切主题等操作。

## 四、功能增强（协作/运维）

- [ ] **F14 只读分享模式**：`--read-only` 启动参数禁用 reindex 等写操作接口，可安全部署到公共地址。
- [ ] **F15 项目切换器**：管理多个 `cgv view` 实例（localStorage 存最近项目列表，一键切换端口）。

## 五、服务端架构与健壮性

- [ ] **S1 路由表重构**：server.mjs 的 if-chain 抽成 `[{ method, pattern, handler }]` 路由表，每个 API 独立函数，可测试可扩展。
- [ ] **S2 CLI 子进程默认超时**：`createRunner` 层加默认 timeout（如 30s），reindex 等单独放宽，防止 codegraph 卡死拖挂请求。
- [ ] **S3 缓存失效策略**：indexStale 时缩短 TTL 或在结果中标注「可能过期」，避免改码后返回旧搜索结果。
- [ ] **S4 删除轮询版 trace**：确认无旧客户端后，删除 `/api/trace`（JSON 轮询版）+ `/api/trace/progress` + traceTasks 注册表，只保留 SSE 流式版。
- [ ] **S5 静态文件缓存**：加 ETag（mtime）+ 304 响应。

## 六、前端工程质量

- [x] **Q1 index.html 拆分**：拆成 `style.css` + `app.js`（原生 `<link>` / `<script type="module">`，保持零构建）。
- [ ] **Q2 图邻接表优化**：`callersOf/calleesOf` 由 O(n) 全边扫描改为 `Map<key, {in, out}>` 邻接表。
- [ ] **Q3 localStorage 持久化**：搜索历史、主题、面板宽度、showNoise / renderAllNodes 开关状态。
- [ ] **Q4 键盘可达性**：搜索框 ↑/↓ 选结果、Enter 打开、Esc 关面板。

## 七、CLI / 分发

- [ ] **C1 `cgv view` 脚本化输出**：`--json` 或 `--no-browser` 选项，方便 CI/脚本使用。
- [ ] **C2 `/_health` 探活端点**：不触发 codegraph 调用的轻量健康检查，供 pm2/systemd/容器使用。
- [ ] **C3 清理 tgz 产物**：`tgz/` 目录与根目录 tgz 移出 git（加 .gitignore），发布产物交给 npm registry / GitHub Releases。

## 八、测试与 CI

- [x] **T1 服务端集成测试**：`node:test` 起 server 实测 `/api/search`、`/api/graph`、静态文件 403 路径绕过（钉死 safeFile/relative 防护逻辑）。
- [x] **T2 GitHub Actions**：3 行 workflow 跑 `node --test` + e2e。
- [ ] **T3 TEST_CASES.md 处理**：与实际测试对齐或标注「由 test/unit.test.mjs 驱动」，避免漂移。

---

## 推荐实施顺序

1. **F1** 悬停代码预览（方案现成，用户价值最高）
2. **Q1** index.html 拆分（为后续所有前端改动降低成本）
3. **T1 + T2** 集成测试 + CI（保住现有安全逻辑）
4. 其余按需挑取，F2 / F11 性价比高（纯前端、依赖已就绪）。
