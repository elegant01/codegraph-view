# demo-app（示例项目，非真实业务代码）

这是给 codegraph-view 的截图 / 演示用的**假项目**——所有符号名、路由、类名都是通用的占位名，
不包含任何真实项目信息。文件刻意组织成「route → service → repository」的调用链，
用来展示搜索、接口定位、调用图、全链路展开等功能。

想自己跑一遍：

```bash
cd examples/demo-app
codegraph init      # 建索引（.codegraph/ 已被上级 .gitignore 忽略）
cd ../.. && node server.ts 39267   # 或在任意目录 cgv view 39267
```

目录结构：

```
src/
├── app/
│   ├── (admin)/media/page.tsx          # 页面路由（(admin) 路由组会被忽略）
│   └── api/
│       ├── media/audit/route.ts        # /api/media/audit
│       ├── media/list/route.ts         # /api/media/list
│       └── system/config/[id]/route.ts # 动态段 [id]
├── service/ItemService.ts              # 业务层
├── repository/ItemRepository.ts        # 数据层
└── lib/                                # 工具层
    ├── format.ts
    └── logger.ts
```
