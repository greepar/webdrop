# WebDrop API

Swift + Vapor 后端已实现房间、会话与权限、原生 Swift PoW、聊天内容、流式文件、临时链接和 SSE。默认发布产物内嵌前端，开发期仍可用Vite；接口入口为 [OpenAPI](../../packages/contracts/openapi.yaml) 与 [协议说明](../../packages/contracts/protocol.md)。

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

默认 `127.0.0.1:8080`。启动目录没有`.env`时，首次运行先生成配置并提示修改后重新启动，本次不启动服务/不创建数据目录；已有配置不覆盖。第二次启动读取配置，创建私有`.data/`，元数据原子保存为 JSON 快照；小文件优先使用临时内存，大文件逐块落盘。重启保留会话、房间、文字和磁盘文件；内存附件失效并撤销相关分享。进程锁阻止多个实例同时打开同一目录。不要在服务运行时删除该目录。

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
  -H 'Origin: http://127.0.0.1:8080' \
  -H 'Content-Type: application/json' \
  -d '{"displayName":"我的手机"}'
```

完整端点、请求字段和状态码见契约；可参考 `scripts/api-smoke.py` 的独立客户端。

## 配置与部署

首次运行自动生成`.env`并退出，检查修改后再次启动；`.env.example`仅作配置参考，无需随单文件分发。API_HOST、API_PORT、DATA_DIR、ROOM_CODE_LENGTH及可选CORS_ALLOWED_ORIGINS均在模板中说明。`MEMORY_FILE_BYTES` 默认1 MiB、`MEMORY_TOTAL_BYTES` 默认64 MiB；池满自动落盘，单文件阈值设为0则全部落盘。

生产环境通过HTTPS入口访问，并运行：

```bash
swift build -c release -j 4
.build/release/webdrop serve --env production --hostname 127.0.0.1 --port 8080
```

默认PowerShell发布产物内嵌前端，同一服务提供页面、`/api/*`、`/d/*`及`/s/*`；反向代理可统一转发全部路径。纯API构建仍需独立前端服务。SSE 关闭代理缓冲，保留 Cookie 与 Origin；生产 Cookie 自动设置 Secure。默认不信任转发 IP 头，反代后的真实来源限流需配置在可信边缘；后端仍按连接来源执行自己的限额。

这是单进程、小规模自托管的持久化实现；全量元数据快照不适合大量并发或多实例。扩容时可替换存储层为事务数据库和对象存储，保持外部 API。PoW 初始难度为14、最高20 bits，已做协议与跨语言验证，移动端求解耗时需前端接入后实机校准。

## 代码组织

- `WebdropServer/entrypoint.swift`：进程生命周期。
- `WebdropAPI/Configuration`：首次运行配置与应用初始化。
- `WebdropAPI/Core/Protocol.swift`：JSON 边界、错误信封、密码学协议工具。
- `Core/Models.swift`、`Store.swift`：类型化持久化状态、串行事务、会话、限流及 PoW。
- `Core/Operations.swift`：房间、内容、上传会话和分享状态变更。
- `Core/Streams.swift`：分块文件写入、下载授权和事件重放。
- `Core/HTTP.swift`：HTTP 适配、CSRF/Origin、SSE 与 Range 输出。
- `Core/Maintenance.swift`：过期关闭、链接撤销和文件回收。
- `Tests/WebdropAPITests`：独立后端测试，不依赖前端。

手写Swift采用4空格缩进及120列目标宽度，使用官方swift-format604.x；根目录执行`npm run format:swift`整理、`npm run check:swift`检查，详见[开发约定](../../docs/development.md)。

核心业务集中在一个 actor 中保证首版状态操作原子性；源码中的占位模块文档已清理。[后端目标](GOAL.md) 独立跟踪完成情况。

房间支持可选加入密码，owner 可设置/更换/取消；前端字段、状态与重试规则见 [房间密码接入契约](../../packages/contracts/room-password.md)。

房间可开启加入审批，与密码同时生效；详见 [审批接入契约](../../packages/contracts/room-approval.md)。

房间容量：MAX_ROOMS（默认500）与MAX_OWNED_ROOMS（默认5）配置上限；GET /api/v1/room-capacity提供当前余量。详见 [容量契约](../../packages/contracts/room-capacity.md)。

## PowerShell跨平台打包

仓库根目录执行（`-File`可省略）：

```powershell
pwsh ./scripts/build-api.ps1
# 显式选择目标并保留未strip副本
pwsh ./scripts/build-api.ps1 -Target linux-x86_64 -Jobs 4 -KeepSymbols
```

默认先运行前端生产构建，再把dist资源编译进同一个可执行文件；无Node/外部dist也能提供页面。`-ApiOnly`关闭嵌入，`-SkipWebBuild`使用已有dist。Linux默认裁剪ICU语言数据，`-FullICU`保留完整SDK数据；macOS使用系统库。

参数：`-Target auto|linux-x86_64|linux-arm64|macos-x86_64|macos-arm64|windows-x86_64|windows-arm64`、`-Jobs`、`-OutputDirectory`、`-KeepSymbols`、`-SkipStrip`（诊断用）。省略Target时默认为auto，在Linux/macOS/Windows选择本机平台及架构；Windows目标要求匹配架构的原生Windows runner。Windows移植仍在Actions验收中，当前打包形式为exe及随附运行库的ZIP。PowerShell最低7.2，Swift当前为6.4.2。

| 目标 | 构建方式 | 验证状态 |
| --- | --- | --- |
| linux-x86_64 | 匹配Swift版本的musl Static Linux SDK | 本机已构建并校验ELF |
| linux-arm64 | 同一Static Linux SDK的aarch64目标 | 已交叉构建并通过架构/静态校验；未在ARM机器运行验收 |
| macos-x86_64 / macos-arm64 | macOS runner和Apple SDK，最低macOS26（当前构建的系统运行时要求） | 双架构单文件均已通过52项测试及真实HTTP/SSE停机恢复 |
| windows-x86_64 / windows-arm64 | 对应架构Windows runner与Swift SDK | 移植验收中，exe+DLL ZIP，尚未实现单exe |

脚本可以由pwsh运行于各主机，但交叉目标仍受工具链与SDK支持限制。macOS目标必须在macOS构建，使用系统动态库，不提供完全静态的Darwin产物。Linux目标会用纯PowerShell读取ELF，检查架构及无PT_INTERP/DT_NEEDED，不依赖readelf、grep或install。打包使用release默认优化（-O），不额外指定-Osize；Linux优先使用跨架构llvm-strip，macOS用系统strip；工具退出非零会终止任务。

Linux SDK需与Swift版本一致。当前版本的一次性安装：

```powershell
swift sdk install 'https://download.swift.org/swift-6.4.2-release/static-sdk/swift-6.4.2-RELEASE/swift-6.4.2-RELEASE_static-linux-0.1.0.artifactbundle.tar.gz' --checksum '3786b179936d9cc9e266dd506bd1654176358d7b25288e243359f4d17cc4dc5a'
```

官方说明：https://www.swift.org/documentation/articles/static-linux-getting-started.html

脚本只构建并输出本地文件，不自动创建或上传GitHub Release。输出为`dist/api/webdrop-<Target>`与同名`.json`清单（目标、字节数、SHA-256、Swift版本、静态/strip状态）。`-KeepSymbols`另保留`dist/api/symbols/`。每个目标使用独立scratch目录；linux-x86_64沿用`.build/static-linux`缓存。构建过程中不重启开发后端、不覆盖运行数据。脚本已取代原bash入口。

GitHub Actions见.github/workflows/release.yml：v*标签触发Linux x86-64/ARM64和macOS x86-64/ARM64构建，全部成功后创建Release并上传二进制与JSON清单。支持手动构建但不发布；ARM交叉产物仅做静态/架构校验，其余目标执行真实HTTP/SSE停机验收。首次Actions结果以实际runner为准。

Linux x86-64完全静态产物可复制到目标机器，仍需可写DATA_DIR与环境配置；默认内嵌前端，反向代理可统一转发全部路径。Swift运行库及C/C++库已包含在文件内。默认使用ICU语言子集；实际字节数见产物JSON清单，[体积分析](../../docs/backend-binary-size.md)记录不同优化选项的历史基线、Bloaty与验证限制。

Linux默认保留root及en、zh、es、de、fr、ru、ja、pt、it、ko的已有locale变体，保留Unicode、编码转换、分词词典、转写与时区数据。被删除的locale可能回退；locale枚举索引尚未重建，不能据枚举结果推断所有数据仍在。HTTP日期仍按原有ISO8601格式输出。

默认裁剪需要`llvm-ar`、`llvm-objcopy`、`llvm-nm`、`clang`和`icupkg`在PATH中，例如Homebrew安装`llvm`和`icu4c`（keg-only工具需加入PATH）；缺工具会报错，可用`-FullICU`构建完整版本。脚本按当前Swift版本读取已安装Static Linux SDK配置，自动定位ICU archive；自定义SDK布局可通过`-IcuArchive`指定与构建目标匹配的`lib_FoundationICU.a`。生成数据位于`apps/api/.build/icu/<Target>`，不修改安装的SDK，不外置运行时数据文件。

```powershell
pwsh ./scripts/build-api.ps1             # Linux默认裁剪
pwsh ./scripts/build-api.ps1 -FullICU    # 完整ICU
```

JSON清单记录icuMode、语言清单、SDK archive/data哈希、裁剪字节数及依赖补回项。历史实验及已知功能差异见 [ICU裁剪研究](../../docs/icu-data-research.md)。

生成的前端源码位于Sources/WebdropAPI/Generated，已忽略不提交；普通swift build仍是API开发构建。页面/API共用监听端口，分享链接自动使用实际访问来源；开发Vite代理保留Host。PUBLIC_ORIGIN和WEB_ORIGINS不再读取，旧.env中的这两行可删除。

## 首次运行配置

配置文件位于**启动时的工作目录**，与Vapor读取dotenv的位置一致，不按可执行文件所在目录猜测。第一次运行生成带说明的`.env`（权限0600）并正常退出，检查/修改监听地址、端口和容量后，重新执行同一命令才启动服务。无需额外携带`.env.example`，模板已包含在程序里。

已有可读`.env`不改写，包括空文件；空文件表示明确选择用环境变量/默认配置。系统环境变量仍优先于dotenv，CLI监听参数保持既有优先级。`--help`/`-h`/`--version`不触发生成。HTTPS生产运行--env production；修改API_PORT或CLI端口后，无需再同步其它来源配置。

自动化部署/隔离测试应提前提供自己的`.env`（配置全由系统环境变量传入时，可提供只含注释的文件），避免将首次生成后退出误判为启动失败。不可读配置、`.env`同名目录或写入失败会报错，不会覆盖它们。

## 自动同源与可选CORS

默认页面和API共用API_PORT，来源校验及分享链接根据实际Host/协议计算。反向代理须保留原始Host，覆盖X-Forwarded-Proto为实际http/https；不使用X-Forwarded-Host或X-Forwarded-For推断授权来源。内部监听端口可与公网HTTPS端口不同。

`.env`可选配置：

```dotenv
# 留空仅同源；多个额外来源以逗号分隔，无路径/尾斜杠，不支持 *。
CORS_ALLOWED_ORIGINS=https://drop.qwq.lu,https://web.example.com
```

同源访问无需填写域名。显式来源支持带凭据的预检及实际请求，仍校验CSRF与会话权限。HTTPS跨域会话使用SameSite=None/Secure，客户端须携带凭据，浏览器仍可能限制第三方Cookie。HTTP本地同站不同端口可测试CORS；跨站部署使用HTTPS。已有.env不会自动覆盖，需自行添加该可选项并重启。生产HTTPS用--env production。

## 审批事件与停机检查

创建申请发送join-request.created，同意/拒绝/到期发送join-request.updated，完整JoinRequest信封见协议。只向当前成员的SSE流发送；owner收到事件重读列表，保留30秒兜底，申请者继续轮询本人状态。重复请求不重复发状态变更事件。

Ctrl+C/SIGTERM主动唤醒并结束空闲SSE，再让HTTP服务排空；不关闭房间或撤销成员。测试采用临时配置/数据，验证真实事件及多条活跃SSE下的停机与重启恢复：

```bash
python3 scripts/api-shutdown-smoke.py --binary dist/api/webdrop-linux-x86_64 --validate-contract
```

带校验参数需安装scripts/requirements-contract.txt。该检查覆盖正常读取的长连接，不代表慢读背压、悬停上传或存储故障下所有请求均能立即退出。

会话显示名可用PATCH /api/v1/session修改（Cookie、Origin、CSRF，displayName非空且≤80 UTF-8字节）；只改会话及后续入房的名字，已有成员快照不变。申请者可DELETE自己的pending申请转为withdrawn，owner应使用reject；撤回不占申请额度。浏览器快速通知验收：`python3 apps/web/tests/isolated.py approval-sse.mjs`。

## OCI容器与GHCR

`Containerfile`使用scratch及Linux静态内嵌程序，默认非root（65532）、8080端口、DATA_DIR=/data。镜像自带只含说明的.env，容器首次启动直接运行，不进入交互配置生成流程；配置通过环境变量传入，/data挂载持久卷。可只读运行根文件系统。

本机验证：

```sh
pwsh ./scripts/build-api.ps1
podman build --format oci -t localhost/webdrop:check .
python3 scripts/container-smoke.py --image localhost/webdrop:check --validate-contract
podman run -d --name webdrop --read-only --cap-drop=all --security-opt=no-new-privileges -p 8080:8080 -v webdrop-data:/data localhost/webdrop:check
```

首次访问http://localhost:8080；局域网通过主机实际IP访问。反代HTTPS沿用Host/X-Forwarded-Proto约定，生产加`-e VAPOR_ENV=production`不能代替程序CLI；请在镜像名后指定`serve --env production`。持久卷保存状态/磁盘文件；内存文件仍会随进程退出失效。宿主目录绑定挂载需确保UID65532可写，命名卷由Podman初始化目录权限。

Actions的OCI任务只依赖两个Linux构建，下载本次二进制Artifacts，构建linux/amd64+linux/arm64清单并运行容器HTTP/卷恢复验收。手动构建成功后推送`ghcr.io/greepar/webdrop:sha-<12位提交>`；版本标签触发时另推版本号及latest。已实测发布与匿名拉取`ghcr.io/greepar/webdrop:sha-bf52cc33d2ae`，amd64/arm64清单存在，amd64容器验收通过；ARM64运行仍需相应机器。尚未发布版本标签或latest，实际任务状态见GitHub Actions。Windows/macOS仍由各自任务验收，不影响Linux镜像路径。
