import Foundation
import Vapor

struct Settings: Sendable {
    var directory: String
    var corsOrigins: Set<String> = []
    var secureCookies: Bool
    var codeLength = 4
    var maxDevices = 10
    var maxFileBytes = 100_000_000
    var memoryFileBytes = 1_048_576
    var memoryTotalBytes = 67_108_864
    var roomBytes = 500_000_000
    var totalBytes = 2_000_000_000
    var maxRooms = 500
    var maxOwnedRooms = 5
    var maxItems = 1000
    var idleSeconds: Double = 1800
    var leaseSeconds: Double = 90
    var uploadSeconds: Double = 3600
    var sessionSeconds: Double = 604800
    var challengeSeconds: Double = 120
    var baseBits = 14
    var maxBits = 20
    var now: @Sendable () -> Double = { Date().timeIntervalSince1970 }

    static func environment(_ application: Application) throws -> Settings {
        let production = application.environment == .production
        var result = Settings(
            directory: Environment.get("DATA_DIR") ?? application.directory.workingDirectory + ".data",
            secureCookies: production
        )
        try result.configureCORS(Environment.get("CORS_ALLOWED_ORIGINS"))
        if let raw = Environment.get("ROOM_CODE_LENGTH") {
            guard let limit = Int(raw), (4...8).contains(limit) else {
                throw APIError(500, "INVALID_CONFIG", "ROOM_CODE_LENGTH must be 4...8")
            }
            result.codeLength = limit
        }
        try result.configureRoomCapacity(
            maxRooms: Environment.get("MAX_ROOMS"),
            maxOwnedRooms: Environment.get("MAX_OWNED_ROOMS")
        )
        for (name, keyPath) in [
            ("MEMORY_FILE_BYTES", \Settings.memoryFileBytes), ("MEMORY_TOTAL_BYTES", \Settings.memoryTotalBytes),
        ] {
            if let raw = Environment.get(name) {
                guard let limit = Int(raw), (0...2_000_000_000).contains(limit) else {
                    throw APIError(500, "INVALID_CONFIG", "Invalid memory storage limit")
                }
                result[keyPath: keyPath] = limit
            }
        }
        guard result.memoryFileBytes <= result.maxFileBytes else {
            throw APIError(500, "INVALID_CONFIG", "Memory file threshold exceeds file limit")
        }
        return result
    }

    mutating func configureRoomCapacity(maxRooms rawRooms: String?, maxOwnedRooms rawOwned: String?) throws {
        if let rawRooms {
            guard let limit = Int(rawRooms), (1...1_000_000).contains(limit) else {
                throw APIError(500, "INVALID_CONFIG", "MAX_ROOMS must be 1...1000000")
            }
            maxRooms = limit
        }
        maxOwnedRooms = min(maxOwnedRooms, maxRooms)
        if let rawOwned {
            guard let limit = Int(rawOwned), (1...maxRooms).contains(limit) else {
                throw APIError(500, "INVALID_CONFIG", "MAX_OWNED_ROOMS must be 1...MAX_ROOMS")
            }
            maxOwnedRooms = limit
        }
    }
    mutating func configureCORS(_ raw: String?) throws {
        let values = (raw ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        var origins: Set<String> = []
        for value in values {
            guard let origin = Self.canonicalOrigin(value) else {
                throw APIError(
                    500,
                    "INVALID_CONFIG",
                    "CORS_ALLOWED_ORIGINS requires explicit HTTP(S) origins without paths or wildcards"
                )
            }
            origins.insert(origin)
        }
        corsOrigins = origins
    }

    static func canonicalOrigin(_ value: String) -> String? {
        guard var components = URLComponents(string: value),
            let scheme = components.scheme?.lowercased(), ["http", "https"].contains(scheme),
            let host = components.host, !host.isEmpty,
            components.user == nil, components.password == nil, components.path.isEmpty,
            components.query == nil, components.fragment == nil,
            (components.port.map { (1...65535).contains($0) } ?? true),
            !value.contains(where: { $0.isWhitespace || $0 == "," || $0 == "\\" })
        else {
            return nil
        }
        components.scheme = scheme
        components.host = host.lowercased()
        if components.port == (scheme == "https" ? 443 : 80) {
            components.port = nil
        }
        return components.string
    }
}
