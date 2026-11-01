# WebDrop

跨设备分享文字、文件、图片和视频。
## 本地开发

```bash
npm ci
npm run dev:api
# 另一终端：连接真实后端，默认API为127.0.0.1:8080
VITE_API_MODE=live npm run dev
```

后端首次运行同样先生成.env并退出，检查后重新运行dev:api。开发期继续使用Vite热更新；生产打包不包含mock模块。普通`swift build`不启用前端嵌入。

## 目录与文档

- `apps/web/`：React页面、交互与浏览器测试。
- `apps/api/Sources/WebdropAPI/Core/`：业务状态、HTTP、持久化、流与配置；`Features/Health/`提供健康探针。
- `packages/contracts/`：正式OpenAPI与协议，不因当前联调通过而删除。
- [开发约定](docs/development.md)、[前端说明](apps/web/README.md)、[后端说明](apps/api/README.md)。
- 
## 许可证

项目使用[MIT许可证](LICENSE)。第三方依赖保留各自许可证。
