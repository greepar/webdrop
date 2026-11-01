# 文件传输

文件、图片、视频的上传会话、传输状态、资源元数据。后续上传走流式接口，不复用 JSON body 收集。

本业务已通过 Core 中的状态事务、Operations 和 HTTP 适配实现，契约见 packages/contracts/openapi.yaml 与 protocol.md。此目录保留后续按领域拆分的边界，不再创建重复接口。
