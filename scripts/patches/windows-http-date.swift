// Use Foundation for UTC conversion instead of POSIX gmtime_r on Windows.
internal final class RFC1123DateCache: Sendable {
    private static let shared = RFC1123DateCache()
    private let cached = NIOLockedValueBox<(Int64, String)>((.min, ""))

    static func eventLoop(_ eventLoop: EventLoop) -> RFC1123DateCache {
        self.shared
    }

    func currentTimestamp() -> String {
        let now = Date()
        let second = Int64(now.timeIntervalSince1970)
        return self.cached.withLockedValue { entry in
            if entry.0 != second { entry = (second, now.rfc1123) }
            return entry.1
        }
    }
}
