# WebDrop API 设计背景（实现前草案归档）

后端已实现，准确请求字段、已落实的决策与边界以 [OpenAPI](openapi.yaml) 和 [protocol.md](protocol.md) 为准。本文件保留最初设计讨论，不作为当前运行接口的规范。

状态：首版产品范围与六项默认规则已确认，未实现；协议细节仍为实现前草案。此文件统一后续接口边界与关键字段；正式 OpenAPI 中目前仍只有基础接口。首版以“房间共享内容流”组织剪贴板和文件，文字按聊天消息逐条展示，设备为房间成员，不额外实现私聊式点对点传输。

## 通用约定

- 业务 JSON 路径 `/api/v1`，字段 camelCase；ID 为不透明字符串，房间号为可变长度数字字符串，保留前导零。时间使用 UTC ISO 8601，大小以字节计。
- 成功 JSON 统一 `{data: ...}`，列表为 `{data: [...], page: {nextCursor: string|null}}`，cursor 分页，默认 30、上限 100（建议）。删除成功 204 无响应体。现有健康探针作为明确例外保持当前格式。
- 业务错误统一 `{error: {code, message, requestId, details?}}`，客户端按 code 分支，不解析文字。details 不含内部异常、凭证或存储路径。实现时统一转换 Vapor 错误与业务错误。
- 状态码：200 查询/修改、201 创建、204 删除、400 格式错误、401 会话无效、403 无权限、404 资源不可见、409 状态冲突、410 已公开分享链接失效、413 过大、415 类型不支持、429 限流；429 附 Retry-After。不存在/关闭/不允许加入的房间统一 ROOM_UNAVAILABLE，不对未加入者暴露成员和内容。
- 服务端控制资源上限及状态机，前端验证只辅助交互。文件字节不进入 JSON/base64。公开错误不暴露房间存在性，私有资源不可见与不存在统一处理。
- 首版建议匿名设备会话：安全随机服务端会话，生产使用 HttpOnly、Secure、SameSite Cookie。会话建立本身限流；写操作需 CSRF 防护与 Origin 校验。同源部署，不开放通配凭证 CORS。
- 创建、加入、创建上传、完成上传、创建链接和发文字使用 Idempotency-Key。键按会话+操作作用域保存，记录请求摘要；相同键不同内容返回409。完成的重试返回既有结果，不再次消费 PoW 或重复创建资源，缓存期限实施前确定。

## 身份、PoW 与加入流程

1. 建立/恢复匿名会话，获取输入位数与公开能力配置。
2. 获取服务端挑战，绑定会话、操作、请求摘要（包含目标房间号/创建参数及幂等键）。响应包含 challengeId、协议版本、算法、difficulty、expiresAt 和计算输入。
3. 浏览器 Worker 求解；调用目标创建/加入接口时同时提交 `{proof: {challengeId, nonce}}`。
4. 服务端校验当前策略、限流、挑战和操作权限，原子消费证明并处理请求。没有单独的“验证通过即永久放行”接口。

| 方法与路径 | 输入 / 输出重点 | 权限 |
| --- | --- | --- |
| GET `/capabilities` | roomCodeLength、允许的位数、已配置上传上限 | 公开，不含内部风控阈值 |
| POST `/sessions` | 建立匿名会话，返回 deviceId / displayName，设置 Cookie | 来源限流 |
| GET `/session` | 当前设备及有效房间成员关系 | 有效会话 |
| POST `/pow/challenges` | action、目标请求参数摘要与幂等键 → 挑战 | 会话+来源限流，签发不探测目标房间是否存在 |
| POST `/rooms` | proof、可选待创建 code → room / owner membership | 会话+PoW；code 最终由服务端校验和原子占用 |
| POST `/rooms/join` | code、proof → room / membership | 会话+PoW，默认开放加入 |

具体 PoW 算法、编码与阈值在实现前补全协议及共享测试向量。新增会话不能重置来源级成本。随机按钮不需要先增加“查询号码是否空闲”接口，以免形成枚举入口。

## 房间与成员

Room 建议字段：id、code、joinPolicy（open/locked）、createdAt、expiresAt、ownerMemberId。Member：id、deviceId、displayName、role（owner/member）、joinedAt、presence。成员角色和归属以服务端记录为准。

| 方法与路径 | 功能 | 权限 |
| --- | --- | --- |
| GET `/rooms/:roomId` | 房间信息 | 当前成员 |
| GET `/rooms/:roomId/members` | 成员及在线状态 | 当前成员 |
| PATCH `/rooms/:roomId` | 锁定/恢复加入等明确允许的设置 | owner |
| POST `/rooms/:roomId/code/rotate` | 更换房间号，原号失效 | owner，受限流保护 |
| DELETE `/rooms/:roomId/members/me` | 离开房间 | 当前成员；owner 离开策略待定 |
| DELETE `/rooms/:roomId/members/:memberId` | 踢出并撤销该成员房间权限 | owner；不能通过此接口删除自己 |
| DELETE `/rooms/:roomId` | 关闭房间、撤销成员访问及通知连接 | owner |

无公开房间列表。踢出不能仅断开界面：后续 HTTP 和实时订阅都必须拒绝。匿名用户能否再次加入、owner 离线/清除 Cookie 后如何恢复，作为待决产品规则，不承诺可靠的匿名设备永久封禁。

## 内容与上传

建议以 RoomItem 统一显示 text / asset：id、roomId、senderMemberId、kind、text 或 asset、createdAt。服务端校验 kind 与载荷一致。

| 方法与路径 | 功能与关键字段 | 权限 |
| --- | --- | --- |
| GET `/rooms/:roomId/items` | cursor 分页内容流 | 当前成员；可见全部尚未过期的历史内容 |
| POST `/rooms/:roomId/items` | 创建文字条目，text | 当前成员 |
| DELETE `/rooms/:roomId/items/:itemId` | 删除内容及处理关联资源引用 | 本人或 owner |
| POST `/rooms/:roomId/uploads` | filename、sizeBytes、contentType → uploadId、上传路径、expiresAt | 当前成员，验证配额 |
| PUT `/uploads/:uploadId/content` | 流式原始文件体，验证实际字节数；首版重传整个文件 | 上传者且仍为成员 |
| POST `/uploads/:uploadId/complete` | 校验完成，创建 ready asset 及对应内容条目，幂等 | 上传者且仍为成员 |
| DELETE `/uploads/:uploadId` | 取消并回收未完成上传 | 上传者或 owner |
| GET/HEAD `/assets/:assetId/content` | 受保护的原始内容，支持 Range/206、416 | 当前授权成员 |

上传状态：pending → uploading → ready；异常为 failed/cancelled/expired。未完成资源不可下载或分享；传输进度与服务端就绪状态分开显示。客户端文件名和 MIME 不可信，媒体类型校验及大小上限在后端执行。对象路径不对客户端公开。

## 临时分享与直链

ShareLink：id、assetId、slug、expiresAt、revokedAt、shareUrl、contentUrl。短码与房间号独立；默认房间文件不公开，主动创建链接才开放持链访问。

| 方法与路径 | 功能 | 权限 |
| --- | --- | --- |
| POST `/assets/:assetId/links` | expiresAt → 分享页和原始内容链接 | 资源上传者或 owner |
| GET `/rooms/:roomId/links` | 管理可见分享链接 | 自己创建的链接；owner 可查看房间全部 |
| DELETE `/links/:linkId` | 撤销链接 | 链接创建者或 owner |
| GET `/shares/:slug` | 分享页必要元数据，不返回房间成员信息 | 持有效链接者 |
| GET/HEAD `/d/:slug`（无 `/api/v1` 前缀） | 原始字节/媒体 Range 响应 | 校验链接有效性和来源限流 |

`/s/:slug` 是前端页面，调用 `/api/v1/shares/:slug`。撤销只能阻止后续访问，不能收回已下载数据。手动或自动关闭房间时同时撤销关联公开链接；链接默认有效期 24 小时，以撤销或到期中较早者为准。

## 实时同步（建议首版 SSE）

建议 GET `/api/v1/rooms/:roomId/events`：Cookie 鉴权的 SSE，下行通知；写操作统一走 HTTP。前端 EventSource 连接失败允许重连，服务端限制并发订阅并在会话撤销/踢出时断开。

事件信封 `{eventId, type, roomId, occurredAt, data}`。事件类型建议 member.joined / member.left / member.updated / item.created / item.deleted / upload.updated / room.updated / room.closed。

事件带单调可续读游标；同一房间事件顺序和保留窗口须定义。断线重连可重复交付，客户端按 eventId 去重；游标过期发 resync.required 并重新请求快照，避免漏消息。快照返回对应游标以消除首次加载与订阅之间的竞态。在线状态使用有时限的租约/心跳；浏览器后台断线不可立即认定用户主动离房。

## 前后端职责与待决项

前端负责输入/交互、主题与响应式、Worker 求解、上传进度、复制能力和可恢复错误展示；后端负责身份权限、码分配、PoW 策略、资源限额、数据状态、过期清理和实际访问控制。

已确认：随机按钮直接创建随机码房间，加号按输入号码创建；新成员可见未过期历史；成员管理自身内容/分享，owner 管理全部；owner 暂时离线不关房，无人在线持续 30 分钟后关闭；最多 10 台设备；单文件 100 MB（100,000,000 字节）；分享默认 24 小时，关闭房间同时撤销。服务端原子处理号码冲突、入房人数和重复设备重连。

尚待明确的实现细节：owner 主动离房或丢失凭证后的处理、内容独立保留期、媒体类型白名单、SSE 游标保留窗口及 PoW 参数。这些未决细节不改变上述已确认规则。本轮只完善规范，尚未开始业务实现。
