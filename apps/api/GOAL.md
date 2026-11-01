# WebDrop 后端目标与验收

范围：apps/api。Swift/Vapor负责状态、权限、持久化和稳定API；前端内部交互独立维护，通过[正式契约](../../packages/contracts/README.md)协作。

## 已满足

- [x] 匿名会话恢复、服务端成员角色、随机/指定房间号与PoW防重放；房间号保留前导零、位数可配置。
- [x] 密码、owner审批、锁定、踢人、更换号码、关闭；普通成员只能管理自己的内容，owner按契约管理全部内容。
- [x] 普通成员离房撤权；owner离房返回OWNER_MUST_CLOSE，不自动转让或匿名找回权限。GET session只返回当前有效成员关系。
- [x] 同一会话访问恢复身份，无需重复密码/审批；导航不隐含离房/关房。请求与SSE刷新有效成员租约，待审批访客不能用轮询延长房间寿命。
- [x] 全员离线回收、最后在线成员离开时的空闲起点、失败请求不回滚到期清理；关房使资源、分享及旧成功缓存失效，已有SSE优先收到room.closed。
- [x] 聊天、分页、幂等、流式文件、SHA256、混合内存/磁盘、上传恢复、Range/HEAD、分享及资源回收；限额见协议。
- [x] MAX_ROOMS/MAX_OWNED_ROOMS配置、公开聚合容量API，创建原子校验不因余量快照突破限制。
- [x] PowerShell统一打包，Linux x86-64/ARM64静态产物与SHA-256清单。默认构建并嵌入生产前端，单个二进制提供页面/API/Worker，SPA回退不覆盖API或下载错误。-ApiOnly保留纯API构建。
- [x] 源码中的5份模块占位MD及过时的架构/路线图/草案/重复审查、根目标导航已清理，共10份；Package.swift排除项与文档引用同步整理。

## 当前验证（2026-11-01）

- 后端41项测试、离线契约5项、前端类型检查/lint/生产构建通过。
- 内嵌Linux x86-64产物单独复制至临时目录、使用干净运行环境，无Node/外部dist服务：首页、全部资源、房间/分享页直接访问及API/下载404边界通过。
- 内存200 KB与磁盘2 MB真实HTTP schema smoke通过；Chrome对同一单文件服务的会话恢复、离房、关房流程通过。
- Linux ARM64可交叉构建并验证静态ELF/架构，运行仍需ARM机器验收；macOS入口未在对应runner验收，Windows原生后端尚未支持。
- Linux默认使用ICU语言子集，-FullICU恢复完整数据。子集研究、体积分析与功能差异分别见[ICU研究](../../docs/icu-data-research.md)和[体积分析](../../docs/backend-binary-size.md)，不把候选测试通过等同于所有locale兼容。

## 未验证与后续

- 真实手机PoW耗时、Safari/iOS与移动媒体实机行为由前端联合验收。
- 未进行生产压力、多实例存储、长时间运行、TCP故障注入或存储写入故障注入；响应丢失通过提交后重读/重复请求模拟。
- Actions实际matrix、ARM运行、macOS构建/运行与Windows移植需在对应环境验证。
- ICU子集未重建locale索引，未验证Foundation全部locale/编码/日历；被移除语言可能回退，完整行为使用-FullICU。

运行、构建和部署入口见[README](README.md)；业务可观察行为以OpenAPI及协议为准。

## 首次运行配置生成

- [x] 缺少.env时，在当前工作目录发布完整模板（0600），打印修改/重启提示并正常退出；不启动监听，不创建数据目录。模板内置于二进制，按内嵌前端/API开发模式选择8080/5173的origin。
- [x] 已有可读.env不覆盖，系统环境变量优先级保持；help/version不触发生成。不可读路径/同名目录或写入失败明确报错。临时文件+不覆盖硬链接发布，避免并发写坏已有配置。
- [x] 4项新增测试覆盖首次/重复、并发、文件权限、目录冲突、帮助检测及模板字段；后端合计41项与契约5项通过。
- [x] 实际Linux x86-64单文件首次退出、无.data、第二次加载用户改动的端口/容量并提供页面/API已验证；第二次启动通过内存/磁盘HTTP schema smoke。帮助不生成.env。隔离浏览器运行器提供显式临时配置，生命周期浏览器检查通过。
- [x] Linux x86-64与ARM64发布产物已更新；ARM64仅完成构建/架构检查，首次启动实机运行仍待ARM环境验证。

## Swift代码风格审查（2026-11-01）

- [x] 审查并整理全部23个手写Swift文件，包含后端、测试、两个Package.swift及ICU探针；依赖、缓存、生成的前端资源不参与。统一4空格、120列目标、逐条语句/属性、声明间留白和import顺序。
- [x] HTTP按会话/上传/下载/事件/JSON路由分组，业务分发拆为具名处理函数；整理局部变量与JSON/密码学工具命名，边界参数改用可选绑定，SSE帧集中编码。13个Codable模型的持久化字段已与整理前逐项核对一致。
- [x] 新增根.swift-format及PowerShell格式入口，npm run format:swift整理、npm run check:swift严格检查；npm test已纳入格式门禁，规则与swift-format604.x安装要求见开发约定。
- [x] npm test通过：前端类型/lint、23文件严格格式检查、后端41项测试；npm run build、离线契约5项、ICU探针构建/运行通过。独立数据目录下200 KB内存/2 MB磁盘HTTP schema smoke及Chrome生命周期检查通过。
- [x] Linux x86-64静态内嵌发布构建/ELF检查通过；本次是内部可读性整理，HTTP端点、JSON字段、状态码及持久化schema保持兼容，无正式契约变更。
- 未验证：本轮未重新构建/运行ARM64与macOS；静态构建仍有依赖未处理文件和SwiftPM native构建系统弃用提示，未修改第三方依赖。

- [x] 去除makeID/jsonString/jsonNumber/parseTimestamp及String哈希转发重载，调用处直接构造UUID/JSON并显式转换Data；业务接口保持兼容。后端41项测试、严格格式检查、后端构建与200 KB真实HTTP schema smoke通过。

## 发布脚本默认参数

- [x] 支持直接`pwsh ./scripts/build-api.ps1`，省略-File和-Target；Linux/macOS按本机平台及架构选择，Windows原生未支持时明确报错，Linux交叉目标需显式指定。脚本生成本地发布产物，不自动上传Release。
- [x] 移除-Osize，恢复release默认-O，保留前端嵌入、strip及静态ELF校验；历史体积实验数据保留并注明已改变默认值。
- [x] 本机上述无参数命令实际通过，编译计划100个Swift命令包含-O且不含-Osize；Linux x86-64产物79,530,872字节，静态校验及200 KB真实HTTP schema smoke通过。本轮未重新验证ARM64/macOS，既有跨平台运行限制保持。

## 默认ICU子集发布

- [x] 按部署要求，Linux打包默认以10语言子集替换完整ICU数据包，保留root及共享Unicode/编码/分词/转写/时区数据；-FullICU恢复完整SDK数据，macOS继续使用系统库。已同步开发约定、README及历史体积/ICU研究的当前默认说明。
- [x] 原研究逻辑提升为prepare-icu.ps1，按目标校验x86-64/ARM64 ELF并生成对应替换对象；自动读取当前Swift版本的SDK配置定位archive，允许-IcuArchive适配自定义布局。SDK本体不改写，无运行时外部.dat依赖。
- [x] 子集生成强制依赖校验及ToC前缀检查，不用ignore-deps；错误架构archive拒绝已验证，缺少裁剪工具明确失败。清单包含ICU模式、语言、源archive与完整/子集数据哈希、字节数及补回依赖。
- [x] 默认-O、前端嵌入、strip保持。Linux x86-64从79,530,872降至64,019,320字节（61.05 MiB），实际脚本构建及静态ELF检查通过；ARM64交叉构建为59,489,144字节并通过架构/静态检查。重复构建保持产物哈希且复用替换对象。
- [x] x86-64裁剪版53项ICU探针与完整基线对比，只有已知4项移除locale的日期/数字格式差异；200 KB内存和2 MB磁盘HTTP schema smoke、Chrome生命周期检查通过。
- 已知限制：移除locale可能回退；locale索引未重建，未承诺全部Foundation locale/编码/日历等价。ARM64未运行验收，macOS本轮未构建/运行，工具及SDK升级需重新验证。

- [x] 发布版首次运行模板明确页面/API同服务，无需独立前端；PUBLIC_ORIGIN/WEB_ORIGINS改为实际访问来源说明，API开发模板单独说明前端来源。4项配置测试及Linux x86-64静态构建通过，实际首次生成不含Vite/5173、不创建.data；已有.env仍不覆盖。

## 自动来源识别与可选CORS（2026-11-01）

- [x] 移除PUBLIC_ORIGIN/WEB_ORIGINS的读取和模板字段。页面/API共用监听端口，实际请求Host与协议决定来源和绝对分享URL；旧.env不覆盖，遗留两项可删除。新增可选CORS_ALLOWED_ORIGINS，空值默认仅同源，显式来源按完整HTTP(S) origin校验，拒绝通配符/路径/null。
- [x] 写请求按同源或明确CORS来源授权；保留会话/CSRF/角色校验。支持OPTIONS预检、凭据、允许来源错误响应的CORS头及Vary，HTTPS跨域会话使用None/Secure Cookie；同源默认Strict。浏览器第三方Cookie策略仍可能限制真正跨站部署。
- [x] 分享链接在HTTP边界按当前请求来源解析；包含旧绝对URL的幂等缓存亦按当前地址重建，权限与持久化模型字段不变。反代必须保留Host并覆盖X-Forwarded-Proto，忽略X-Forwarded-Host/For的授权作用，来源限流继续使用连接peer。
- [x] Vite代理保留Host；前端fetch携带credentials，跨域上传地址按API来源解析。隔离浏览器运行器支持--cross-origin，并添加CORS文件链路专项。
- [x] 后端45项测试、离线契约5项、24文件严格格式、前端类型/lint/生产构建通过；内存200 KB/磁盘2 MB真实HTTP schema smoke，同源及跨域Chrome生命周期、跨域上传/私有下载/Range专项通过。另以真实HTTP模拟HTTPS生产反代及明确CORS来源，验证会话201、预检204、非法来源403、CSRF403及错误响应CORS头，确认遗留环境变量不再生效。
- [x] x86-64/ARM64静态内嵌产物已更新，架构/静态校验通过；x86-64实际首次生成模板无旧origin项，包含空CORS项且未创建.data。正式协议/OpenAPI与部署说明同步，0.6.1业务端点/字段保持兼容；原跨域配置迁移至CORS_ALLOWED_ORIGINS。
- 未验证/限制：ARM64本轮未实机运行，macOS未构建/运行；未部署到用户远端服务器，需替换产物重启。旧file-list-smoke在跨域模式完成5文件上传后，删除确认步骤因预期文案不匹配未通过；未修改该无关UI文案，上传/下载由新增独立专项验收。

## 审批事件、撤回、改名与正常SSE停机

- [x] SSE使用可取消的actor等待队列；事件主动唤醒，空闲心跳2秒，持续时间按单调时钟120秒限制。停机生命周期先唤醒所有等待者，再结束HTTP服务；不发room.closed、不关闭房间、不撤销成员。取消/唤醒清理超时任务和等待者。
- [x] 创建申请发join-request.created，审批/拒绝/到期/撤回发join-request.updated，完整JoinRequest信封，只向真实成员流发送。真实状态转换只发一次，重复与并发请求无重复事件；到期在可控时钟的清理事务内持久化，失败晚审批不回滚到期事件，关房后不再发申请事件。
- [x] DELETE本人有效pending申请返回204及withdrawn事件；owner代撤403、无关会话404、终态重复撤409；撤回不占100条额度，可重新PoW申请。并发撤回/审批只允许一个成功，未批准仍无房间权限。
- [x] PATCH session严格接收displayName，非空且≤80 UTF-8字节，Cookie/CSRF/Origin校验不变。200返回完整会话，身份/CSRF/有效memberships不变；只改会话名，已有成员与申请快照保留，新房/新入房用新名，已验证持久化。
- [x] protocol/openapi/room-approval/errors同步；新增状态withdrawn，旧严格枚举客户端需升级。事件Event枚举、oneOf及x-sse-events同步，业务信封保持occurredAt。新增接口保留现有业务权限、状态模型字段及路由兼容。
- [x] npm test通过（类型/lint、26文件严格格式、后端52项），离线契约6项通过。真实HTTP内存200 KB/磁盘2 MB schema smoke通过。静态x86-64对新PATCH/DELETE响应与真实SSE进行schema检查，4条活跃SSE下SIGINT/SIGTERM约0.001–0.002秒退出，无停机超时，重启恢复owner/成员/房间。
- [x] 新增approval-sse浏览器专项，房主面板关闭时新申请红点/提醒在3秒内出现，撤回立即清掉，不依赖30秒兜底。x86-64与ARM64静态内嵌产物已更新并通过架构/静态检查。
- 未验证/限制：未部署远端服务器；ARM64未实机运行、macOS未构建运行。正常消费SSE停机已验收，慢读背压、悬停上传、存储故障下所有请求立即停机未验收。原approval-password浏览器脚本在旧创建面板选择器等待失败（页面已进入房间）；未修改并行开发的前端流程，SSE创建/撤回提醒由新专项独立验收。

## 撤回提醒与局域网预览修复

- [x] RoomActions移除管理面板pendingCount覆盖SSE watchedCount的双状态优先级，面板与事件重读写入同一个计数；已打开过面板后撤回不会残留红点/提醒。approval-sse专项增加打开/关闭面板再撤回场景，红点及提醒均消失，未依赖30秒轮询。
- [x] 本地5174代理实际连接的18080仍为15:51旧后端（旧Origin白名单及无申请SSE）；保留/tmp/webdrop-data重启为当前构建。局域网192.168.1.201:5174 POST sessions实际201，外站Origin仍403；无需放开来源检查。
- [x] 前端类型检查通过；lint无错误，现有DeviceNameEditor的set-state-in-effect警告未在本轮处理。隔离真实SSE浏览器回归通过。

## GitHub标签发布入口

- [x] release.yml在v*标签推送时构建Linux x86-64/ARM64及macOS ARM64/x86-64，固定Swift6.4.2和Action SHA，执行类型/lint、后端测试、契约检查及原生目标真实HTTP/SSE停机验收；全部构建成功后发布Release文件。手动触发只生成Artifacts。
- [x] actionlint及diff空白检查通过。实际GitHub runner及发布结果待首次运行验收，ARM64 Linux运行仍需目标机器验证。

## Actions跨平台与GHCR（进行中）

- [x] Actions升级Node24版checkout/setup-node/upload/download，Swift通过官方Swiftly安装并校验Linux签名。修复原安装Action缺少版本清单/签名key以及macOS重复安装PowerShell失败。
- [x] ICU工具固定到79.1源提交与SHA256，避免Ubuntu系统旧icupkg读取SDK数据时的字符串容量错误。Linux x86-64及ARM64已在run41301861787通过测试、静态内嵌构建与ELF检查，x86-64真实HTTP/SSE停机恢复通过。
- [x] 新增scratch OCI镜像，非root65532、只读根、/data卷、自带空配置绕过首次生成退出。双架构清单amd64/arm64已在GHCR发布sha-930467093a49；匿名拉取及本机Podman再次通过页面、200KB/2MB HTTP schema、卷恢复与SIGTERM验收。镜像不依赖Swift/Node运行时。
- [x] Linux OCI任务独立等待Linux产物，手动构建发布sha标签，版本tag验证后才发版本/latest；正式Release仍等全部平台任务通过，本轮没有新增tag。
- [ ] macOS使用可核对依赖补丁绕过旧系统Foundation缺少Data span API；ARM64的52项测试及发布编译已通过，裸二进制启动暴露较新SerialExecutor默认符号，已加等价nil见证补丁重跑；兼容补丁重复应用检查通过。Windows提供原生Win32存储锁、zlib平台条件和HTTP cookie日期兼容，进一步适配NIOSSL（基于上游PR567，保留证书校验及系统调用错误），x86-64/ARM64原生构建运行待验收。Windows当前打包目标仍为exe+DLL的ZIP，不能视为单可执行文件已实现。

- [x] 平台定向手动构建可独立重跑；显式checkout固定触发SHA。Windows目标要求匹配架构的原生runner，避免静默产生错误架构。
