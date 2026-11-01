import Foundation
import Vapor

struct Settings: Sendable {
    var directory: String
    var origins: Set<String>
    var secureCookies: Bool
    var publicOrigin: String
    var codeLength = 4
    var maxDevices = 10
    var maxFileBytes = 100_000_000
    var memoryFileBytes = 1_048_576
    var memoryTotalBytes = 67_108_864
    var roomBytes = 500_000_000
    var totalBytes = 2_000_000_000
    var maxRooms = 500
    var maxItems = 1000
    var idleSeconds: Double = 1800
    var leaseSeconds: Double = 90
    var uploadSeconds: Double = 3600
    var sessionSeconds: Double = 604800
    var challengeSeconds: Double = 120
    var baseBits = 14
    var maxBits = 20
    var now: @Sendable () -> Double = { Date().timeIntervalSince1970 }

    static func environment(_ app: Application) throws -> Settings {
        let production = app.environment == .production
        let publicOrigin = Environment.get("PUBLIC_ORIGIN") ?? "http://localhost:5173"
        let origins = Set((Environment.get("WEB_ORIGINS") ?? "http://localhost:5173,http://127.0.0.1:5173,http://localhost:8080,http://127.0.0.1:8080").split(separator: ",").map(String.init))
        guard !origins.isEmpty, origins.allSatisfy({ validOrigin($0, secure: production) }), validOrigin(publicOrigin, secure: production) else {
            throw APIError(500, "INVALID_CONFIG", "Origins must be explicit HTTP(S) origins; production requires HTTPS")
        }
        var result = Settings(directory: Environment.get("DATA_DIR") ?? app.directory.workingDirectory + ".data", origins: origins, secureCookies: production, publicOrigin: publicOrigin)
        if let raw = Environment.get("ROOM_CODE_LENGTH") {
            guard let n = Int(raw), (4...8).contains(n) else { throw APIError(500, "INVALID_CONFIG", "ROOM_CODE_LENGTH must be 4...8") }
            result.codeLength = n
        }
        for (name, keyPath) in [("MEMORY_FILE_BYTES", \Settings.memoryFileBytes), ("MEMORY_TOTAL_BYTES", \Settings.memoryTotalBytes)] {
            if let raw = Environment.get(name) {
                guard let n = Int(raw), (0...2_000_000_000).contains(n) else { throw APIError(500, "INVALID_CONFIG", "Invalid memory storage limit") }
                result[keyPath: keyPath] = n
            }
        }
        guard result.memoryFileBytes <= result.maxFileBytes else { throw APIError(500, "INVALID_CONFIG", "Memory file threshold exceeds file limit") }
        return result
    }
    static func validOrigin(_ value: String, secure: Bool) -> Bool {
        guard let u = URLComponents(string: value), let scheme = u.scheme, u.host != nil,
              u.user == nil, u.password == nil, u.query == nil, u.fragment == nil, u.path.isEmpty else { return false }
        return secure ? scheme == "https" : ["http", "https"].contains(scheme)
    }
}
