# @webdrop/web

React + TypeScript + Vite + Tailwind CSS 前端，使用自绘低饱和手绘 UI。进度与验收见 [GOAL.md](GOAL.md)，HTTP、PoW、SSE 与文件流以 [API 契约](../../packages/contracts/README.md) 为准。

页面：`/` 创建/加入房间，`/rooms/:roomId` 聊天与文件，`/s/:slug` 公开分享，未知路径显示错误页。

## 开发

使用仓库指定 Node 版本，在根目录安装依赖和执行命令：

```sh
npm ci
npm run dev:web
npm run check
npm run lint
npm run build:web
```

开发默认是明确标识的内存 mock，仅在当前页面存活，不能证明真实服务功能。连接真实 API：

```sh
VITE_API_MODE=live API_PROXY_TARGET=http://127.0.0.1:8080 npm run dev:web
```

后端另行启动，见 API README。浏览器访问 `/api/v1`；Vite 将 `/api/*`、`/d/*` 转发到 API_PROXY_TARGET。代理保留浏览器Host，默认同源无需额外来源配置；直连跨域API时在后端CORS_ALLOWED_ORIGINS列出前端来源。VITE_API_BASE_URL 默认 `/api/v1`，VITE_* 会进入浏览器产物，不能存放秘密。

## 构建与预览

生产产物在 `apps/web/dist`，不包含开发 mock 模块。默认发布使用根目录的`pwsh -File scripts/build-api.ps1`构建并嵌入后端二进制，无需另行部署dist；下列preview仅用于独立前端检查。构建后可以本地验收：

```sh
API_PROXY_TARGET=http://127.0.0.1:8080 npm run preview --workspace @webdrop/web -- --host 127.0.0.1 --port 4173
```

Vite preview 使用同一代理配置，仅用于本地检查。正式部署由 Web 服务器提供静态产物：先将 `/api/*`、`/d/*` 转发后端，其余页面路径回退到 index.html；`/s/:slug` 和 `/rooms/:roomId` 必须允许直接刷新。API 错误不可重写为 SPA 页面，SSE 禁用代理缓冲。默认同源 Cookie/CSRF；跨域部署需另行配置服务端凭证和 CORS 策略。

## 结构

- `app`、`pages`：入口、路由和页面组合。
- `features`：房间、会话、入口和主题的业务组件与 hooks。
- `shared`：API 校验、浏览器能力、PoW Worker、主题和 UI 原语。
- `styles/globals.css`：语义主题 token、Tailwind 入口和动效。

`@/` 指向 src。状态使用局部 hooks，页面不散落 fetch；仅通过 HTTP 契约消费后端，不导入其内部类型和实现。

## 检查与限制

浏览器检查步骤见 [tests/README.md](tests/README.md)，包括独立会话、媒体、故障注入、键盘、分页和性能 trace。真实测试只对可丢弃的隔离 API 数据运行，避免消耗人工预览会话及房间额度。客户端替身检查会单独注明，不作为真实 API 通过证据。

iOS Safari 的真实键盘、安全区、剪贴板和下载保存尚未完成实机验收；当前 Chrome 手机视口检查不能代替它。剩余工作以 GOAL 为准。
