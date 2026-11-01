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
# swift-crypto 5.0.3: Foundation on macOS 15 lacks Data.mutableBytes.
# The dependency already uses the equivalent unsafe-buffer path on visionOS 1.0.
if ($IsMacOS) {
    # Swift 6.2 adds a SerialExecutor default witness unavailable in macOS 15.
    # Supply the same nil (unknown) result locally instead of binding that symbol.
    $executor = Join-Path $ScratchPath 'checkouts/swift-nio/Sources/NIOCore/EventLoop+SerialExecutor.swift'
    $before = @'
    @inlinable
    public func asUnownedSerialExecutor() -> UnownedSerialExecutor {
'@
    $after = @'
    @inlinable
    public func isIsolatingCurrentContext() -> Bool? { nil }

    @inlinable
    public func asUnownedSerialExecutor() -> UnownedSerialExecutor {
'@
    Apply-CheckedPatch $executor $before $after
    $path = Join-Path $ScratchPath 'checkouts/swift-crypto/Sources/CryptoBoringWrapper/AEAD/BoringSSLAEAD.swift'
    $before = @'
            var outputSpan = output.mutableBytes
            try open(message: &outputSpan, nonce: nonceBytes, tag: tagBytes, authenticatedData: authenticatedData)
'@
    $after = @'
            try output.withUnsafeMutableBytes { bytes in
                var outputSpan = bytes.mutableBytes
                try open(message: &outputSpan, nonce: nonceBytes, tag: tagBytes, authenticatedData: authenticatedData)
            }
'@
    Apply-CheckedPatch $path $before $after
    $fileProvider = Join-Path $ScratchPath 'checkouts/swift-configuration/Sources/Configuration/Providers/Files/FileProvider.swift'
    $before = @'
            self._snapshot = try snapshotType.init(
                data: fileContents!.bytes,
                providerName: providerName,
                parsingOptions: parsingOptions
            )
'@
    $after = @'
            self._snapshot = try fileContents!.withUnsafeBytes { bytes in
                try snapshotType.init(
                    data: bytes.bytes,
                    providerName: providerName,
                    parsingOptions: parsingOptions
                )
            }
'@
    Apply-CheckedPatch $fileProvider $before $after
    $reloading = Join-Path $ScratchPath 'checkouts/swift-configuration/Sources/Configuration/Providers/Files/ReloadingFileProvider.swift'
    $before = @'
        try snapshotType.init(
            data: data.bytes,
            providerName: providerName,
            parsingOptions: parsingOptions
        )
'@
    $after = @'
        try data.withUnsafeBytes { bytes in
            try snapshotType.init(
                data: bytes.bytes,
                providerName: providerName,
                parsingOptions: parsingOptions
            )
        }
'@
    Apply-CheckedPatch $reloading $before $after

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
