# API契约

此目录是前后端HTTP协作边界，不是运行时代码包。`openapi.yaml`以JSON格式保存合法YAML1.2文档，描述当前已实现的接口；schema与协议发生差异时需修正，不能以mock或内部数据库结构替代契约。

- [OpenAPI](openapi.yaml)：请求、响应、鉴权、字段限制和逐接口错误。
- [协议](protocol.md)：会话、CSRF、PoW、幂等、分页、SSE、上传下载、限额与生命周期。
- [错误与恢复](errors.md)：客户端处理分支。
- [房间密码](room-password.md)、[房主审批](room-approval.md)、[生命周期](room-lifecycle.md)、[容量配置及查询](room-capacity.md)。
- [PoW共享向量](pow-vectors.json)：跨语言算法校验。

ID为不透明字符串，时间为UTC ISO8601，文件大小为字节。文件流、SSE与恢复行为同样属于契约。接口变更同步本目录并明确兼容性；两端内部重构无需另一端配合。

校验依赖`scripts/requirements-contract.txt`：

```bash
python3 scripts/test-contract.py
python3 scripts/api-smoke.py --url http://127.0.0.1:18080 --validate-contract
```

后者仅对可丢弃的隔离测试服务运行。验证器执行`x-maxUtf8Bytes`字节扩展、UUID/时间格式、JSON请求/响应及SSE payload；普通JSON Schema工具也需处理该扩展。

单文件发布时页面资源嵌入二进制，根路径提供HTML；未启用嵌入的开发/API构建仍提供原服务JSON。业务API、下载与健康探针保持原语义，不被SPA回退覆盖。
