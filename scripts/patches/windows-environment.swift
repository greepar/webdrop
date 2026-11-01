// Windows-only Vapor compatibility. Keep the CRT and OS environment in sync.
import Foundation
import WinSDK
import ucrt

@discardableResult
internal func setenv(_ name: String, _ value: String, _ overwrite: Int32) -> Int32 {
    if overwrite == 0, ProcessInfo.processInfo.environment[name] != nil { return 0 }
    guard !name.isEmpty, !name.contains("="), !name.contains("\0"), !value.contains("\0") else { return EINVAL }
    return name.withCString(encodedAs: UTF16.self) { key in
        value.withCString(encodedAs: UTF16.self) { contents in
            let result = _wputenv_s(key, contents)
            guard result == 0 else { return result }
            return SetEnvironmentVariableW(key, contents) ? 0 : EINVAL
        }
    }
}

@discardableResult
internal func unsetenv(_ name: String) -> Int32 {
    guard !name.isEmpty, !name.contains("="), !name.contains("\0") else { return EINVAL }
    return name.withCString(encodedAs: UTF16.self) { key in
        let result = "".withCString(encodedAs: UTF16.self) { _wputenv_s(key, $0) }
        guard result == 0 else { return result }
        return SetEnvironmentVariableW(key, nil) ? 0 : EINVAL
    }
}
