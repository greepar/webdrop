# WebDrop API v1 实现协议

对应 `openapi.yaml` 0.4.0。前端仅依赖这些接口行为；后端当前为单进程、本地文件持久化实现。

## 建立会话与写操作

1. `POST /api/v1/sessions`，JSON `{ "displayName": "我的手机" }`，带允许的 `Origin`。返回 Cookie 与 `data.csrfToken`。已有有效 Cookie 时恢复会话并返回 200，新会话为 201。
2. 后续请求携带 Cookie；`GET /api/v1/session` 可重新获取 CSRF token 与成员关系。
3. 所有写操作携带 `Origin`、`X-CSRF-Token`（建立会话除外）。创建房间/加入、发文字、创建上传、完成上传、创建分享还必须带 8–128 位可见 ASCII（0x21–0x7E，不含空格） `Idempotency-Key`。
4. Cookie 有效期 7 天，HttpOnly、SameSite=Strict，生产环境 Secure。CSRF token 只通过响应体获得，不从 Cookie 读取。跨域请求不开放 CORS，部署使用同源反代。

displayName 可省略或为 null（新会话默认 Device）；非空字符串最多80个 UTF-8 字节，恢复会话时保留原名称。文件名最多240个 UTF-8 字节。OpenAPI 的 `x-maxUtf8Bytes` 表达字节限制，普通 `maxLength` 不能替代该限制；契约验证器同时执行两者。

JSON 成功为 `{data: ...}`；列表附 `{page: {nextCursor}}`。健康接口不包装。错误统一 `{error:{code,message,requestId}}`，文件 Range 416 例外为空体并带 Content-Range。所有 JSON、下载和分享响应禁止缓存。

幂等记录保留 24 小时，键按会话+操作路径划分。请求指纹为去掉 `proof` 后的规范 JSON 哈希；同键不同参数 409。重试不再次消费 PoW。重试时仍校验会话、CSRF 和房间成员权限，已离开/被踢/关闭的房间不能通过缓存访问。

## PoW v1

挑战请求：

```json
{"action":"room.join","code":"0042","idempotencyKey":"unique-request-key"}
```

创建用 `room.create`，随机创建省略 code；指定号码创建提供 code。挑战签发不会探测号码是否存在。响应：

```json
{"data":{"challengeId":"uuid","version":1,"algorithm":"sha256-leading-zero-bits","difficulty":14,"input":"webdrop-pow-v1:<challengeId>:<randomSalt>:","expiresAt":"UTC ISO8601"}}
```

计算 `SHA256(UTF8(input + nonce))`，哈希最高位开始至少 `difficulty` 个连续零位。`nonce` 是十进制 ASCII 字符串，1–64 位，仅允许 `0` 或不带前导零的正整数。无额外分隔符；input 已包含最后的冒号。不要把 nonce 当成 JS Number，避免整数精度丢失。

提交原目标请求：`{code?: "0042", proof: {challengeId, nonce}}`，并使用挑战绑定的同一 `Idempotency-Key`。挑战绑定会话、来源、操作、code、幂等键，不可跨用途使用。校验与消费在同一状态事务内；无论业务失败、验证失败还是成功，属于该会话的已提交挑战只能用一次。幂等成功重试是例外，直接返回原结果。

挑战有效期 120 秒；初始 14 bits，每 3 次挑战申请增加 1 bit，最高 20 bits。来源与会话均统计，窗口 10 分钟，到期回落；已有低难度挑战不能绕过当前来源难度升级。会话上限 20 次/10 分钟、来源上限 30 次/10 分钟；房间创建/加入提交另外按来源限制 30 次/10 分钟。挑战签发本身限制全局在存数量，防止耗尽内存。

这些是首版配置常量，不承诺固定求解时间。14 bits 平均约 16,384 次哈希，20 bits 平均约 1,048,576 次；生产需要结合目标设备和网络压测调整。客户端不能要求降难度。限流返回 429 + Retry-After；验证失效返回 POW_INVALID，需要重新申请挑战。PoW 不代表人类身份。

共同算法测试向量见 `pow-vectors.json`。Swift 测试与 Python smoke 客户端分别计算，后续 Worker 应使用相同向量。

## 房间、成员与有效期

- 四位数字字符串，包含前导零；通过 ROOM_CODE_LENGTH 可配置 4–8 位。能力接口返回当前位数。
- 随机与指定号码创建均原子占用；创建者为 owner。房间默认开放；锁定后已有成员仍可重连，新成员无法加入。
- 上限 10 台设备（包括离线但未离开的成员）。同一会话重连不新增成员；被踢的会话不能再次加入该房间。匿名新会话不等于可永久封禁的真实设备。
- owner 不能直接离房，返回 OWNER_MUST_CLOSE，需先关闭房间。owner 暂时离线不关闭；清除 Cookie 后不提供匿名所有权恢复，其他成员不能自动接管。
- 请求房间资源/SSE 心跳会刷新成员在线租约；90 秒未活动为离线。全体离线持续 30 分钟后自动关闭；清理任务每 15 秒检查，访问时也检查到期。
- 成员列表为读取时的在线快照，SSE heartbeat 后可重新获取。自动离线目前不单独推送 member.updated；后续请求恢复在线时会推送。
- 房间内历史保留至删除或房间关闭；新成员可见全部未删除内容。创建者可以管理全部内容，成员只能删除自己的内容。
- 单房最多 1,000 条内容；文字每条 32 KiB、单房文字总额 1 MB、全局文字 16 MB。未处理未知字段会返回 400。

## 消息分页与 SSE

消息列表按服务端事件顺序从新到旧，cursor 为上一页最后一个 item ID；cursor 被删除时返回 CURSOR_INVALID，客户端重新加载。成员、链接按 ID 排序分页。默认 30 条，最多 100 条。

房间快照、成员列表、内容列表均附 eventCursor。无缝加载建议：先取房间快照并记游标 C，再读取成员/内容列表，最后从 C 订阅。列表与事件可能重叠，按 itemId/eventId 幂等合并。不能以最后读取的列表游标跳过此前发生但未包含在其它列表中的事件。

SSE：`GET /api/v1/rooms/{roomId}/events?cursor=C`。Last-Event-ID 优先于 query。未指定游标从当前序号开始，不重放历史。每房间保留最近 256 条事件；游标太旧或超前发 `resync.required` 并结束，需要重新快照。

业务事件使用 SSE `id: <eventId>`、`event: <type>`，data 为 Event 信封：

| type | data |
| --- | --- |
| member.joined / member.updated | Member |
| member.left | `{id: memberId}` |
| item.created | Item |
| item.deleted | `{id: itemId}` |
| upload.updated | 严格为 Asset schema（id、filename、sizeBytes、contentType、sha256、status、createdAt）；expiresAt/itemId 通过上传状态接口查询 |
| room.updated | Room |
| room.closed | `{id: roomId}` |

业务 Event 的 type/data 由 OpenAPI oneOf 严格关联；SSE 的 event 名必须等于信封 type。heartbeat 和 resync.required 不使用业务信封，均为严格的 `{eventCursor: string}`，映射见 `x-sse-events`。

每 2 秒（capabilities.heartbeatSeconds）发送 `heartbeat`，data 为 `{eventCursor}`；最多连接 120 秒后正常结束，由 EventSource 重连。每设备最多 3 条订阅，全局最多 200 条。被踢、会话过期会结束现有流，重连再次鉴权。房间关闭先发关闭事件再结束。发送背压由网络写入处理，事件不会无限缓存在每个订阅中。

## 临时内存与磁盘存储

默认不超过 1 MiB（1,048,576 字节）的文件优先放内存，超过阈值或内存池不足时从上传开始逐块落盘。按实际声明大小分流，同时强制校验真实字节数，不依赖 MP4/ZIP 扩展名判断大小。

`MEMORY_FILE_BYTES` 设置单文件阈值，`MEMORY_TOTAL_BYTES` 默认 64 MiB；设置单文件阈值为0可关闭内存文件。上传开始时在同一事务内预留完整大小，避免并发上传超额；失败/取消/删除/关房/到期释放预留及内存。预算约束的是活跃上传与保留文件，不是整个进程 RSS：网络缓冲、进行中的下载响应及元数据仍有额外开销。

内存字节不写入持久化快照。服务重启后，内存资源失效，其聊天附件条目移除、相关链接撤销，并产生删除事件；清理相应幂等记录，避免返回已丢失资源的旧成功响应。磁盘文件及纯文字消息继续恢复。纯文字目前仍属于小型元数据快照，不随内存附件一起丢失。

内存文件的分享有效期是最长可访问时间，不保证跨进程重启。需要稳定的跨重启链接时设置 `MEMORY_FILE_BYTES=0`。文件的存储位置是后端内部选择，下载 URL、鉴权、SHA256、GET/HEAD/Range 和缓存规则完全一致。

## 上传与下载

1. `POST /rooms/{id}/uploads` 声明 filename、sizeBytes、contentType；返回 uploadId、uploadUrl、expiresAt。
2. `PUT uploadUrl` 发送原始字节体（推荐 application/octet-stream）。可使用 Content-Length 或分块传输；实际长度必须精确匹配。服务端逐块写入，支持最大 100,000,000 字节，不收集完整文件到内存。
3. PUT 成功返回 status=uploaded、服务端计算的 SHA256 与检测类型。
4. `POST /uploads/{id}/complete` 原子转换为 ready 并创建房间 asset 消息；此前不能下载或分享。

`GET /api/v1/uploads/{uploadId}` 供上传者或房主查询当前状态、expiresAt、itemId（未完成时 null）。PUT/complete 响应丢失后先查询：uploaded 调用 complete；ready 使用 itemId；failed 完整重传；仍为 uploading 时等待，不并发重传。

未完成上传 1 小时过期。中断标记 failed，可完整重传；不支持分片断点续传。正在上传、已 uploaded 或 ready 的资源不能重复 PUT；完成请求可幂等重试。取消或踢出会阻止后续写入完成。最多 20 条同时上传；单房 200 个保留上传记录，存储配额单房 500 MB、全局 2 GB，失败待重传上传仍占配额，取消/过期后释放。

文件名不参与磁盘路径。前端声明的 MIME 仅记录，响应类型由签名识别决定：PNG、JPEG、GIF、WebP、常见 MP4 可 inline；其他格式作为 application/octet-stream attachment。SVG/HTML 不内联。所有格式可作为普通文件传输；媒体解码能力由浏览器决定。

下载支持 GET/HEAD 和单一 Range：起止、起始到末尾、后缀；合法范围返回206，非法/多段返回416及 `Content-Range: bytes */size`。链接撤销或房间关闭阻止新的读取；已经开始的流可完成，已下载数据无法收回。

## 分享与回收

默认链接有效 24 小时，指定有效期必须大于当前时间60秒且不超过24小时。短码格式为两段易记英文词 + 六位无歧义随机后缀；与房间号无关。首版每房最多100个未撤销链接。

分享入口 `/s/:slug` 由前端实现，通过 `/api/v1/shares/:slug` 获取必要资源元数据；原始字节由 `/d/:slug` 提供。私有下载必须是房间成员。公开链接持有人可访问，绝不返回房间成员或会话信息。

删除 asset 消息会撤销其链接；关闭房间撤销全部关联链接，释放文件。单个链接撤销不删除仍存在的房间资源。清理任务回收磁盘孤儿/终态文件，终态元数据及失效链接约保留24小时便于返回410，之后返回404。

## 部署边界与限额

生产设置 PUBLIC_ORIGIN、WEB_ORIGINS 为确切 HTTPS origin，不带路径和尾斜杠，反向代理同源转发 `/api/*`、`/d/*`。默认不信任 X-Forwarded-For：来源限流按连接 peer IP，代理部署需在可信边缘补充真实来源限流；后端绝不直接接受客户端伪造来源头。

默认上限：活跃房间500，每会话同时创建5个；来源创建10次/小时，会话建立20次/10分钟；普通 API 来源600次/分钟、全局3000次/分钟；公开读取120次/分钟/来源。生产需要在边缘加全局连接/带宽限额。单进程文件快照适合首版小规模自托管，不能多实例共用 DATA_DIR。

错误状态码、业务 code 和客户端恢复策略见 [errors.md](errors.md)。SSE 已返回200后发生撤权或过期时关闭流，不向流中插入 JSON 错误信封；重连响应重新执行 HTTP 鉴权。

## 可选房间密码

创建/加入请求增加可选 password，owner 通过 PATCH 设置、替换或用 null 取消。Room 增加 hasPassword。已有成员不受改密影响，锁定优先于密码，错误密码在 PoW 后返回403 ROOM_PASSWORD_INVALID。字节限制、重试、事件及兼容规则见 [room-password.md](room-password.md)。
