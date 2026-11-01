import Foundation

/// First-run setup happens before Vapor loads dotenv or opens the data directory.
public enum StartupConfiguration {
    /// Returns the newly created path; an existing readable .env is never changed.
    public static func createEnvironmentIfMissing(
        in directory: String = FileManager.default.currentDirectoryPath
    ) throws -> String? {
        let manager = FileManager.default
        let root = URL(fileURLWithPath: directory, isDirectory: true)
        let destination = root.appendingPathComponent(".env")
        func validateExisting() throws {
            var isDirectory: ObjCBool = false
            guard manager.fileExists(atPath: destination.path, isDirectory: &isDirectory),
                !isDirectory.boolValue, manager.isReadableFile(atPath: destination.path)
            else {
                throw NSError(
                    domain: "WebdropConfiguration",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "无法读取配置文件 \(destination.path)，请确认它是可读的 .env 文件。"]
                )
            }
        }
        if manager.fileExists(atPath: destination.path) {
            try validateExisting()
            return nil
        }
        // Publish a complete file with an atomic, non-overwriting hard link.
        // Concurrent first launches cannot truncate a user's config or read a partial template.
        let staging = root.appendingPathComponent(".webdrop-env-\(UUID().uuidString).tmp")
        defer {
            try? manager.removeItem(at: staging)
        }
        try Data(template(embeddedWeb: !EmbeddedWebBundle.files.isEmpty).utf8).write(
            to: staging,
            options: .withoutOverwriting
        )
        try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: staging.path)
        do {
            try manager.linkItem(at: staging, to: destination)
        } catch {
            // Another launcher may have published first. Never overwrite it.
            if manager.fileExists(atPath: destination.path) {
                try validateExisting()
                return nil
            }
            throw error
        }
        return destination.path
    }

    static func needsEnvironmentFile(arguments: [String]) -> Bool {
        !arguments.contains(where: { ["--help", "-h", "--version"].contains($0) })
    }

    /// Kept in the executable so single-file deployment needs no external template.
    static func template(embeddedWeb: Bool) -> String {
        return """
            # WebDrop 首次运行生成。请检查配置，保存后重新启动程序。
            # 系统环境变量优先于 .env；修改配置后需要重启。
            # --port/--hostname 命令行参数会覆盖监听配置；页面和API共用监听端口。
            API_HOST=127.0.0.1
            API_PORT=8080
            # 私有数据目录，相对于启动时的工作目录；不要放进公开静态目录。
            DATA_DIR=.data
            # 房间号长度：4–8，保留前导零。
            ROOM_CODE_LENGTH=4
            # 活跃房间上限：1–1000000；每会话拥有上限：1–MAX_ROOMS。
            MAX_ROOMS=500
            MAX_OWNED_ROOMS=5
            # \(embeddedWeb ? "已内嵌前端，页面和API由同一端口提供。" : "纯API开发构建：前端通过同源代理访问API，代理须保留Host。")
            # 分享链接自动使用实际访问地址，无需另配域名/端口。
            # 反向代理保留原始Host，并覆盖X-Forwarded-Proto为实际http/https。
            # 可选跨域来源（逗号分隔完整来源）；留空仅允许同源，不支持通配符。
            CORS_ALLOWED_ORIGINS=
            # HTTPS生产部署以 --env production 启动。
            # 小文件内存阈值/总内存预算（字节）；单文件阈值设0则全部落盘。
            MEMORY_FILE_BYTES=1048576
            MEMORY_TOTAL_BYTES=67108864

            """
    }

    /// Creates a missing configuration unless the command only requests help or version information.
    public static func prepareFirstLaunch(arguments: [String]) throws -> String? {
        guard needsEnvironmentFile(arguments: arguments) else {
            return nil
        }
        return try createEnvironmentIfMissing()
    }
}
