# 接口契约

此目录是 Swift 与 TypeScript 之间的 HTTP 接口约定，不是运行时代码包。

- `openapi.yaml` 0.5.0 描述已实现的后端接口（JSON 格式的合法 YAML 1.2 文档），包括请求与响应 schema。
- 未来业务接口先在这里评审字段、状态码与权限，再分别实现 Swift DTO 和前端类型。
- 当接口数量增多时，再引入 OpenAPI 类型生成；当前无需代码生成工具链。
- UUID / 资源 ID 对前端均为不透明字符串。时间统一为 UTC ISO 8601，文件大小用字节，过期时间使用 `expiresAt`。
- 文件流和实时事件也需要契约，不能以“不是 JSON”为由省略。

尚未实现的路由规划列于 `docs/architecture.md`，不加入当前可用 API 清单。

已实现协议见 [protocol.md](protocol.md)，包括鉴权、PoW 字节编码、分页、SSE 与生命周期。共享 PoW 向量在 [pow-vectors.json](pow-vectors.json)。[原始设计草案](api-design.md) 保留设计背景，出现差异以正式契约及协议说明为准。

## 唯一跨端协作边界

两端各自维护 [前端目标](../../apps/web/GOAL.md) 和 [后端目标](../../apps/api/GOAL.md)。这里仅定义双方可观察的 API 行为，不规定 UI、数据库结构或内部组件组织。

- 范围包括 JSON 请求/响应、鉴权与 CSRF、错误、幂等、分页、上传/下载字节流、PoW 编码与测试向量、实时事件及重连语义。
- `api-design.md` 保存待实现设计与已确认业务规则；`openapi.yaml` 描述已实现接口。实现一个模块前明确该模块的 schema 和协议，再同步到正式契约；不得把草案路径当作已上线接口。
- 任何跨端行为变更先更新契约，明确兼容性和影响；本端内部重构无需另一端配合。
- 前端以相同契约构造 mock 和错误/失效场景；后端以契约验证响应、权限及状态机。mock 不能成为另一份接口标准。
- 未定义字段和端点先补契约，不通过读取对方源码或共享数据库获得隐式行为。
- 联调只检查双方对契约的遵守；一端完成不代表另一端目标完成。

最近接口与存储审查见 [coverage.md](coverage.md)，包含覆盖范围及明确未实现的增强项。

错误矩阵与恢复策略见 [errors.md](errors.md)。SSE payload 已按类型严格定义。字节约束通过 `x-maxUtf8Bytes` 表示并由 `scripts/contract_validator.py` 执行；使用普通 JSON Schema 工具时也必须实现该扩展。

离线检查：`python3 scripts/test-contract.py`；真实 HTTP 检查：`python3 scripts/api-smoke.py --validate-contract`。两者依赖 `scripts/requirements-contract.txt`，校验请求、显式状态码、JSON 响应格式与 SSE payload。

[房间密码接入契约](room-password.md)（0.4.0）：可选 password、owner 设置/修改/取消、hasPassword 和错误/重试语义。

[房主审批接入契约](room-approval.md)（0.5.0）：approvalRequired 设置、202待审批响应、房主决定与访客轮询。当前正式 OpenAPI 版本为0.5.0。
