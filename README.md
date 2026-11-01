# Webdrop

用于跨设备分享剪贴板、小文件、图片和视频的 Web 应用。前后端分离，使用同一个仓库管理。

**当前状态**：Swift 后端已实现匿名会话、DropRoom、PoW、聊天内容、流式上传、下载、临时短链和 SSE；前端仍为工程骨架，业务 UI 待独立实现。前后端按契约接入。

## 技术栈

- 前端：React 19、TypeScript、Vite、React Router、Tailwind CSS 4。
- UI：自绘组件和统一主题变量，不引入成套 UI 组件库。
- 后端：Swift 6.4、Vapor 4、Swift Testing / VaporTesting。
- 工程：npm workspaces 管理前端；Swift Package Manager 独立管理后端；两边都提交依赖锁文件。
- 后端当前使用单进程本地持久化快照与文件存储，实时通知使用 SSE；数据库/对象存储扩展和 WebRTC 尚未接入。

## 项目结构

```text
webdrop/
├── apps/
│   ├── web/                        # React 前端，独立构建
│   │   └── src/
│   │       ├── app/                # 应用入口、路由、模块注册
│   │       ├── layouts/            # 工作空间布局
│   │       ├── pages/              # 页面组装、分享页占位、404
│   │       ├── features/           # devices / clipboard / transfers / links / system
│   │       ├── shared/             # API 客户端、环境配置、自绘 UI 原语
│   │       └── styles/             # Tailwind 和主题变量
│   └── api/                        # Swift + Vapor，独立构建
│       ├── Package.swift
│       ├── Sources/
│       │   ├── WebdropServer/      # 可执行入口与生命周期
│       │   └── WebdropAPI/         # 可测试的应用模块
│       │       ├── Configuration/
│       │       ├── Features/       # Health + 四个业务模块边界
│       │       ├── Infrastructure/ # 后续存储、数据库和清理任务
│       │       └── routes.swift
│       └── Tests/WebdropAPITests/
├── packages/contracts/             # OpenAPI 与协议说明、PoW 测试向量
├── docs/                           # 架构、开发约定和实施阶段
├── package.json                    # 根目录统一命令
└── package-lock.json
```

## 本地启动

需要 Node.js 24（建议 `nvm use`）、npm，以及 Swift 6.4+。首次安装需联网。

```bash
npm install
```

两个终端分别运行：

```bash
# 终端一：Swift 后端，默认 127.0.0.1:8080
npm run dev:api
```

```bash
# 终端二：React 前端，默认 localhost:5173
npm run dev
```

访问 <http://localhost:5173>。页脚显示真实后端连接状态，未启动后端时显示“后端未连接”，不会使用假数据。

```bash
curl http://127.0.0.1:8080/api/v1/health
# {"status":"ok","service":"webdrop-api","apiVersion":"v1"}
```

默认配置无需 `.env`。需要修改时，分别复制 `apps/web/.env.example`、`apps/api/.env.example` 为同目录 `.env`；修改后重启服务。

## 构建和检查

```bash
npm run build       # 前端生产构建 + 后端 debug 构建
npm test            # TypeScript 检查 + Oxlint + 后端接口测试
```

也可以单独运行 `npm run build:web`、`npm run build:api`、`npm run check`、`npm run lint`、`npm run test:api`。

前端产物在 `apps/web/dist/`。后端发布构建：

```bash
cd apps/api
swift build -c release -j 4
.build/release/webdrop serve --hostname 127.0.0.1 --port 8080
```

Vapor 不托管前端产物；生产环境用反向代理把 `/api/*`、`/d/*` 转给后端，其余路径交给静态前端及 SPA fallback。`vite preview` 仅用于检查静态产物，生产 API 路由需另行配置。

手机局域网预览可访问 `http://电脑IP:5173`，开发代理仍由电脑上的 Vite 访问后端，无需把后端暴露给局域网。剪贴板 API 在非 localhost 环境需要 HTTPS，具体交互限制见架构文档。

## 下一步开发入口

- [目标导航](GOAL.md)
- [前端目标](apps/web/GOAL.md)
- [后端目标](apps/api/GOAL.md)
- [架构与业务边界](docs/architecture.md)
- [工程约定](docs/development.md)
- [分阶段计划](docs/roadmap.md)
- [接口契约](packages/contracts/README.md)
- [已实现的业务 API 协议](packages/contracts/protocol.md)
- [前端说明](apps/web/README.md)
- [后端说明](apps/api/README.md)
