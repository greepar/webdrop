# WebDrop

跨设备分享文字、文件、图片和视频。React前端与Swift/Vapor后端按[API契约](packages/contracts/README.md)协作，支持房间密码、加入审批、PoW、实时消息和临时分享链接。

## 单文件发布

需要Node.js、PowerShell7.2+、Swift6.4.2及匹配的Linux Static SDK。首次安装依赖与SDK见[后端说明](apps/api/README.md)。仓库根目录执行：

```powershell
npm ci
pwsh ./scripts/build-api.ps1
```

默认按本机Linux/macOS及CPU架构选择目标（也可显式传`-Target`）；先构建生产前端，再将页面、JS、CSS、Worker和图标嵌入二进制。例如Linux x86-64输出`dist/api/webdrop-linux-x86_64`及SHA-256清单。复制单个可执行文件即可同时提供页面和API，无需额外复制前端dist或安装Node；运行数据仍保存在可写DATA_DIR。

```bash
./webdrop-linux-x86_64 serve --hostname 127.0.0.1 --port 8080
```

首次运行会在当前工作目录生成`.env`并退出。检查并修改配置后，再执行同一启动命令。已有`.env`不会覆盖。

本地访问 http://localhost:8080 。页面/API共用API_PORT，分享链接自动匹配访问地址；生产域名配置HTTPS及反向代理，见后端说明。`/rooms/...`、`/s/...`直接访问支持SPA回退；`/api/*`、`/d/*`和健康检查不回退为页面。

Linux默认裁剪ICU语言数据，保留中英等10种语言；`-FullICU`使用完整数据。首次需安装LLVM工具、clang及ICU的icupkg，见后端说明。

`-ApiOnly`构建纯API版本；`-SkipWebBuild`嵌入已有`apps/web/dist`，用于重复构建其它架构。Linux ARM64和macOS目标参数、验证范围见后端说明。

## 本地开发

```bash
npm ci
npm run dev:api
# 另一终端：连接真实后端，默认API为127.0.0.1:8080
VITE_API_MODE=live npm run dev
```

后端首次运行同样先生成.env并退出，检查后重新运行dev:api。开发期继续使用Vite热更新；生产打包不包含mock模块。普通`swift build`不启用前端嵌入。

## 检查

```bash
npm run check
npm run lint
npm run check:swift
npm run build:web
npm run test:api
```

Swift格式规则与`npm run format:swift`用法见[开发约定](docs/development.md)。

HTTP契约检查见[scripts及后端运行说明](apps/api/README.md)，浏览器测试见[前端测试说明](apps/web/tests/README.md)。

## 目录与文档

- `apps/web/`：React页面、交互与浏览器测试。
- `apps/api/Sources/WebdropAPI/Core/`：业务状态、HTTP、持久化、流与配置；`Features/Health/`提供健康探针。
- `packages/contracts/`：正式OpenAPI与协议，不因当前联调通过而删除。
- [开发约定](docs/development.md)、[前端说明](apps/web/README.md)、[后端说明](apps/api/README.md)。
- [前端目标与验收](apps/web/GOAL.md)、[后端目标与验收](apps/api/GOAL.md)。
- [体积分析](docs/backend-binary-size.md)、[ICU裁剪研究](docs/icu-data-research.md)。

## 许可证

项目使用[MIT许可证](LICENSE)。第三方依赖保留各自许可证。
