#Requires -Version 7.2
[CmdletBinding()]
param([Parameter(Mandatory)][string]$ScratchPath)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Apply-CheckedPatch([string]$Path, [string]$Before, [string]$After) {
    $text = [IO.File]::ReadAllText($Path).Replace("`r`n", "`n")
    if (-not $text.Contains($Before)) {
        if ($text.Contains($After)) { return }
        throw "Dependency patch no longer matches: $Path. Recheck the locked dependency version."
    }
    (Get-Item -LiteralPath $Path).IsReadOnly = $false
    [IO.File]::WriteAllText($Path, $text.Replace($Before, $After), [Text.UTF8Encoding]::new($false))
}
# swift-nio-extras 1.35.2 ships a configure-generated Unix zlib header.
if ($IsWindows) {
    $path = Join-Path $ScratchPath 'checkouts/swift-nio-extras/Sources/CNIOExtrasZlib/include/nioextras-zconf.h'
    Apply-CheckedPatch $path "#if 1     /* was set to #if 1 by ./configure */`n#  define CNIOEXTRAS_Z_HAVE_UNISTD_H" "#if !defined(_WIN32) /* Windows has no unistd.h */`n#  define CNIOEXTRAS_Z_HAVE_UNISTD_H"
}

if ($IsWindows) {
    $cshim = Join-Path $ScratchPath 'checkouts/async-http-client/Sources/CAsyncHTTPClient/CAsyncHTTPClient.c'
    $text = [IO.File]::ReadAllText($cshim)
    if (-not $text.StartsWith("#if !defined(_WIN32)")) {
        (Get-Item $cshim).IsReadOnly = $false
        [IO.File]::WriteAllText($cshim, "#if !defined(_WIN32)`n$text`n#endif`n")
    }
    $cookies = Join-Path $ScratchPath 'checkouts/async-http-client/Sources/AsyncHTTPClient/HTTPClient+HTTPCookie.swift'
    $text = [IO.File]::ReadAllText($cookies).Replace("`r`n", "`n")
    $marker = 'nonisolated(unsafe) private let posixLocale:'
    if (-not $text.Contains('// WebDrop Windows HTTP-date compatibility')) {
        $position = $text.IndexOf($marker, [StringComparison]::Ordinal)
        if ($position -lt 0) { throw 'The upstream cookie helper layout changed; recheck the Windows patch.' }
        $windows = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'patches/windows-cookie-date.swift'))
        $text = "import Foundation`n" + $text.Substring(0, $position) + "// WebDrop Windows HTTP-date compatibility`n#if os(Windows)`n$windows`n#else`n" + $text.Substring($position) + "`n#endif`n"
        (Get-Item $cookies).IsReadOnly = $false
        [IO.File]::WriteAllText($cookies, $text)
    }
}

# NIOSSL 2.37.5 Windows port, adapted from apple/swift-nio-ssl#567
# (22c1c18c48472807e11373a09aa11876314ccb86), retaining upstream Apache-2.0 headers.
# Scoped to locked dependency source; no certificate-verification bypass.
if ($IsWindows) {
    $checkout = Join-Path $ScratchPath 'checkouts/swift-nio-ssl'
    $patch = Join-Path $PSScriptRoot 'patches/niossl-windows.patch'
    & git -C $checkout apply --reverse --check $patch 2>$null
    if ($LASTEXITCODE -ne 0) {
        & git -C $checkout apply --check $patch
        if ($LASTEXITCODE -ne 0) { throw 'NIOSSL Windows patch no longer matches the locked dependency.' }
        Get-ChildItem $checkout -Recurse -File | ForEach-Object { $_.IsReadOnly = $false }
        & git -C $checkout apply $patch
        if ($LASTEXITCODE -ne 0) { throw 'Could not apply NIOSSL Windows patch.' }
    }
}

if ($IsWindows) {
    $compression = Join-Path $ScratchPath 'checkouts/swift-nio-extras/Sources/NIOHTTPCompression/HTTPCompression.swift'
    Apply-CheckedPatch $compression 'cnioextras_z_deflateBound(stream, UInt(inputBuffer.readableBytes))' 'cnioextras_z_deflateBound(stream, cnioextras_z_uLong(inputBuffer.readableBytes))'
    $pool = Join-Path $ScratchPath 'checkouts/async-http-client/Sources/AsyncHTTPClient/ConnectionPool.swift'
    Apply-CheckedPatch $pool "import Glibc`n#else`n#error" "import Glibc`n#elseif os(Windows)`nimport WinSDK`n#else`n#error"
    $vapor = Join-Path $ScratchPath 'checkouts/vapor/Sources/Vapor'
    foreach ($name in @('String+IsIPAddress', 'DotEnv', 'DirectoryConfiguration')) {
        $path = Join-Path $vapor "Utilities/$name.swift"
        $before = if ($name -eq 'DirectoryConfiguration') { "#else`nimport Darwin.C" } else { "#else`nimport Darwin" }
        $after = "#elseif os(Windows)`nimport WinSDK`nimport ucrt`n$before"
        # This insertion retains the original else clause; check its marker first.
        if (-not [IO.File]::ReadAllText($path).Contains('import WinSDK')) { Apply-CheckedPatch $path $before $after }
    }
    $directory = Join-Path $vapor 'Utilities/DirectoryConfiguration.swift'
    $before = '        let cwd = getcwd(nil, Int(PATH_MAX))'
    $after = @'
        #if os(Windows)
        return DirectoryConfiguration(workingDirectory: FileManager.default.currentDirectoryPath)
        #else
        let cwd = getcwd(nil, Int(PATH_MAX))
'@
    if (-not [IO.File]::ReadAllText($directory).Contains('#if os(Windows)')) {
        Apply-CheckedPatch $directory $before $after
        Apply-CheckedPatch $directory '        return DirectoryConfiguration(workingDirectory: workingDirectory)' "        return DirectoryConfiguration(workingDirectory: workingDirectory)`n        #endif"
    }
    $server = Join-Path $vapor 'HTTP/Server/HTTPServer.swift'
    Apply-CheckedPatch $server 'ChannelOptions.socket(SocketOptionLevel(SOL_SOCKET), SO_REUSEADDR)' 'ChannelOptions.socketOption(.so_reuseaddr)'
    Apply-CheckedPatch $server 'ChannelOptions.socket(IPPROTO_TCP, TCP_NODELAY)' 'ChannelOptions.socketOption(.tcp_nodelay)'
    $environment = Join-Path $vapor 'Utilities/WebDropWindowsEnvironment.swift'
    Copy-Item (Join-Path $PSScriptRoot 'patches/windows-environment.swift') $environment -Force
    $date = Join-Path $vapor 'Utilities/RFC1123.swift'
    $dateText = [IO.File]::ReadAllText($date)
    if (-not $dateText.Contains('// WebDrop Windows RFC1123 cache')) {
        $marker = 'internal final class RFC1123DateCache: Sendable {'
        $position = $dateText.IndexOf($marker, [StringComparison]::Ordinal)
        if ($position -lt 0) { throw 'The Vapor date-cache layout changed.' }
        $windows = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'patches/windows-http-date.swift'))
        (Get-Item $date).IsReadOnly = $false
        [IO.File]::WriteAllText($date, $dateText.Substring(0, $position) + "// WebDrop Windows RFC1123 cache`n#if os(Windows)`n$windows`n#else`n" + $dateText.Substring($position) + "`n#endif`n")
    }
}
