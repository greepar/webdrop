# 房间密码（OpenAPI 0.4.0）

房间密码是可选的加入凭证，与房间号、会话凭证、owner 权限和 PoW 分离；不是文件端到端加密密钥。以下接口已由后端实现，前端可直接接入。

## 创建与加入

`POST /api/v1/rooms` 的 JSON 增加可选 `password`：

```json
{"code":"0042","password":"my room password","proof":{"challengeId":"…","nonce":"…"}}
```

省略或 null 创建无密码房间。随机创建仍可省略 code。密码为1–72个 UTF-8 字节，不允许空字符串或 NUL；前后端不 trim、不做 Unicode 规范化，大小写与空格均有意义。浏览器可用 `new TextEncoder().encode(password).length` 检查字节长度。

`POST /api/v1/rooms/join` 同样增加可选 `password`：

```json
{"code":"0042","password":"my room password","proof":{"challengeId":"…","nonce":"…"}}
```

未设密码的房间不验证该值；已设密码的房间，新成员缺失或输入错误均返回 HTTP 403 `ROOM_PASSWORD_INVALID`。校验发生在有效 PoW 之后，失败也消费挑战。前端收到该错误后显示密码输入，并使用新幂等键重新申请挑战、求解和提交；不要复用旧证明。也可在首次加入表单提供可选密码输入，避免一次额外求解。

挑战申请接口不接收密码，仍使用 action/code/idempotencyKey。每个猜测均需有效 PoW，现有限流保持生效。不存在、被踢或锁定的房间继续统一返回 `ROOM_UNAVAILABLE`，不新增公开探测密码状态接口。

## 房主设置、修改、取消

`PATCH /api/v1/rooms/{roomId}`，沿用 Cookie、Origin、X-CSRF-Token，不要求 PoW 或 Idempotency-Key。仅 owner 可调用。

```json
{"password":"a new password"}
```

```json
{"password":null}
```

字符串设置或覆盖密码，null 取消密码；省略 password 保持现状。可与 `joinPolicy` 同时修改，至少提供一个字段，空对象返回400 `INVALID_INPUT`。修改是原子的，密码不合法时 joinPolicy 也不会变化。每房间密码修改（含取消）最多5次/10分钟，超限429 `RATE_LIMITED` + Retry-After。

`joinPolicy=locked` 仍阻止所有新成员加入，正确密码不能绕过锁定。密码修改或取消不会踢出已有成员；同一有效成员会话重连/重复加入不要求重输密码。离开后重新加入需当前密码，被踢会话仍不能重新加入。owner 丢失会话不通过密码恢复权限。

## 前端状态与响应

所有 Room/RoomSnapshot（包括 session.memberships、创建/加入/PATCH 响应、room.updated 的 data）增加布尔字段 `hasPassword`。只用于显示房间是否已设密，不能当作权限判断。`room.updated` 在设置、替换或清除密码后发出，即使两次 hasPassword 都为 true。

成功响应和事件不包含 password/passwordHash。前端不把密码写入 URL、localStorage 或日志；提交时通过 HTTPS JSON 请求体传输。服务端仅持久化加盐 bcrypt 哈希，幂等记录也单独以加盐哈希比较密码，不保存密码明文或快速密码摘要。

幂等键绑定包括密码在内的业务参数：同键改密码返回409 `IDEMPOTENCY_CONFLICT`。成功重试仍校验成员权限；密码相同且原请求成功时返回原响应。省略与 null 均表示无密码，按同一语义处理。已经成功的加入请求用原键重试不受后来改密码影响，因其已是有效成员。

旧磁盘快照恢复时，缺少 passwordHash 的房间视为无密码；旧房间事件与成功缓存补齐 hasPassword=false。内存文件重启失效等既有行为保持不变。公开文件分享链接独立授权，不要求房间密码；设置密码不会撤销已有公开分享。
