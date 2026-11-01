# Infrastructure

首版持久化在 Core/Store.swift，文件流在 Core/Streams.swift，过期清理在 Core/Maintenance.swift。使用独占进程锁、原子 JSON 元数据快照和私有文件目录。未来替换数据库/对象存储时保持外部 API 契约。
