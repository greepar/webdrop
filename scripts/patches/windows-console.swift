// libdispatch's Windows backend does not implement EVFILT_SIGNAL.
// Windows invokes this callback on its own thread. Drain handlers once so
// repeated interrupts cannot complete the shutdown promise twice.
import Foundation
import WinSDK

internal enum WebDropWindowsConsole {
    private final class Handlers: @unchecked Sendable {
        let lock = NSLock()
        var callbacks: [Foundation.UUID: @Sendable () -> Void] = [:]
    }

    private static let handlers = Handlers()
    private static let registered = SetConsoleCtrlHandler(
        { event in
            guard event == DWORD(CTRL_C_EVENT) || event == DWORD(CTRL_BREAK_EVENT) else { return false }
            let pending = handlers.lock.withLock {
                let pending = Array(handlers.callbacks.values)
                handlers.callbacks.removeAll()
                return pending
            }
            for callback in pending { callback() }
            return WindowsBool(!pending.isEmpty)
        },
        true
    )

    static func install(_ callback: @escaping @Sendable () -> Void) throws -> Foundation.UUID {
        guard registered else {
            throw NSError(domain: "WebDropWindowsConsole", code: Int(GetLastError()))
        }
        let id = Foundation.UUID()
        handlers.lock.withLock { handlers.callbacks[id] = callback }
        return id
    }

    static func remove(_ id: Foundation.UUID?) {
        if let id { _ = handlers.lock.withLock { handlers.callbacks.removeValue(forKey: id) } }
    }
}
