// libdispatch's Windows backend does not implement EVFILT_SIGNAL.
// Console interrupts run on a Windows callback thread, so the promise callback
// can safely use NIO's lock. Drain callbacks once to avoid double completion.
import Foundation
import NIOConcurrencyHelpers
import WinSDK

internal enum WebDropWindowsConsole {
    private static let callbacks = NIOLockedValueBox<[Foundation.UUID: @Sendable () -> Void]>([:])
    private static let registered = SetConsoleCtrlHandler(
        { event in
            guard event == DWORD(CTRL_C_EVENT) || event == DWORD(CTRL_BREAK_EVENT) else { return false }
            let pending = callbacks.withLockedValue { callbacks in
                let pending = Array(callbacks.values)
                callbacks.removeAll()
                return pending
            }
            for callback in pending { callback() }
            return !pending.isEmpty
        },
        true
    )

    static func install(_ callback: @escaping @Sendable () -> Void) throws -> Foundation.UUID {
        guard registered else {
            throw NSError(domain: "WebDropWindowsConsole", code: Int(GetLastError()))
        }
        let id = Foundation.UUID()
        callbacks.withLockedValue { $0[id] = callback }
        return id
    }

    static func remove(_ id: Foundation.UUID?) {
        if let id { _ = callbacks.withLockedValue { $0.removeValue(forKey: id) } }
    }
}
