# WebDrop API

Swift + Vapor 后端已实现房间、会话与权限、原生 Swift PoW、聊天内容、流式文件、临时链接和 SSE。前端独立开发，接口入口为 [OpenAPI](../../packages/contracts/openapi.yaml) 与 [协议说明](../../packages/contracts/protocol.md)。

## 运行与测试

在仓库根目录：

```bash
npm run dev:api
npm run build:api
npm run test:api
```

也可不依赖 Node，直接在 `apps/api` 执行：

```bash
swift run webdrop
swift build -j 4
swift test -j 4
```

默认 `127.0.0.1:8080`。首次运行自动创建私有 `.data/`，元数据原子保存为 JSON 快照；小文件优先使用临时内存，大文件逐块落盘。重启保留会话、房间、文字和磁盘文件；内存附件失效并撤销相关分享。进程锁阻止多个实例同时打开同一目录。不要在服务运行时删除该目录。

真实 HTTP 验证（建议使用独立测试目录，脚本会创建并关闭测试房间）：

```bash
# 终端一，仓库根目录
DATA_DIR=/tmp/webdrop-smoke swift run --package-path apps/api webdrop serve --port 18080
# 终端二
python3 scripts/api-smoke.py --url http://127.0.0.1:18080
python3 scripts/api-smoke.py --url http://127.0.0.1:18080 --file-bytes 2000000
```

脚本覆盖会话、Origin/CSRF、PoW、幂等、聊天、上传完整性、Range/HEAD、公开链接、SSE、踢人与关房撤销。安装 `scripts/requirements-contract.txt` 后，追加 `--validate-contract` 可校验 JSON 请求、显式响应状态、JSON 响应（含 UUID/时间格式）与 SSE 业务事件/心跳。离线执行 `python3 scripts/test-contract.py` 验证字节边界、事件类型及错误分支。Swift 测试还覆盖并发容量、难度回落、过期、重放、持久化恢复和失败上传。

## 前端接入顺序

1. 创建/恢复 session，保存响应里的 CSRF token，浏览器保留 HttpOnly Cookie。
2. 读取 capabilities；申请 PoW challenge，Worker 按协议求解。
3. 带证明与 Idempotency-Key 创建/加入房间。
4. 获取房间快照、成员和聊天历史，按 eventCursor 订阅 SSE。
5. 文字直接 POST；文件先创建上传、PUT 字节，再 POST complete。
6. 上传者/owner 主动创建分享链接。普通成员不能分享其他人的文件。

示例建立会话：

```bash
curl -i -X POST http://127.0.0.1:8080/api/v1/sessions \
  -H 'Origin: http://localhost:5173' \
  -H 'Content-Type: application/json' \
  -d '{"displayName":"我的手机"}'
```

完整端点、请求字段和状态码见契约；可参考 `scripts/api-smoke.py` 的独立客户端。

## 配置与部署

复制 `.env.example` 到同目录 `.env`；默认开发配置无需复制。API_HOST、API_PORT、DATA_DIR、ROOM_CODE_LENGTH、PUBLIC_ORIGIN、WEB_ORIGINS 均在模板中说明。`MEMORY_FILE_BYTES` 默认1 MiB、`MEMORY_TOTAL_BYTES` 默认64 MiB；池满自动落盘，单文件阈值设为0则全部落盘。

生产环境配置实际 HTTPS origin，并运行：

```bash
swift build -c release -j 4
.build/release/webdrop serve --env production --hostname 127.0.0.1 --port 8080
```

反向代理转发 `/api/*`、`/d/*`，前端服务提供 `/s/*`。SSE 关闭代理缓冲，保留 Cookie 与 Origin；生产 Cookie 自动设置 Secure。默认不信任转发 IP 头，反代后的真实来源限流需配置在可信边缘；后端仍按连接来源执行自己的限额。

这是单进程、小规模自托管的持久化实现；全量元数据快照不适合大量并发或多实例。扩容时可替换存储层为事务数据库和对象存储，保持外部 API。PoW 初始难度为14、最高20 bits，已做协议与跨语言验证，移动端求解耗时需前端接入后实机校准。

## 代码组织

- `WebdropServer/entrypoint.swift`：进程生命周期。
- `WebdropAPI/Configuration`：环境配置、统一错误中间件、路由注册。
- `WebdropAPI/Core/Protocol.swift`：JSON 边界、错误信封、密码学协议工具。
- `Core/Models.swift`、`Store.swift`：类型化持久化状态、串行事务、会话、限流及 PoW。
- `Core/Operations.swift`：房间、内容、上传会话和分享状态变更。
- `Core/Streams.swift`：分块文件写入、下载授权和事件重放。
- `Core/HTTP.swift`：HTTP 适配、CSRF/Origin、SSE 与 Range 输出。
- `Core/Maintenance.swift`：过期关闭、链接撤销和文件回收。
- `Tests/WebdropAPITests`：独立后端测试，不依赖前端。

核心业务集中在一个 actor 中保证首版状态操作原子性；`Features/*` 文档保留业务模块边界，后续拆分不改变契约。[后端目标](GOAL.md) 独立跟踪完成情况。

房间支持可选加入密码，owner 可设置/更换/取消；前端字段、状态与重试规则见 [房间密码接入契约](../../packages/contracts/room-password.md)。

房间可开启加入审批，与密码同时生效；详见 [审批接入契约](../../packages/contracts/room-approval.md)。
