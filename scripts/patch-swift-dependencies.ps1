#Requires -Version 7.2
[CmdletBinding()]
param([Parameter(Mandatory)][string]$ScratchPath)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Apply-CheckedPatch([string]$Path, [string]$Before, [string]$After) {
    $text = [IO.File]::ReadAllText($Path)
    if ($text.Contains($After)) { return }
    if (-not $text.Contains($Before)) { throw "Dependency patch no longer matches: $Path. Recheck the locked dependency version." }
    [IO.File]::WriteAllText($Path, $text.Replace($Before, $After), [Text.UTF8Encoding]::new($false))
}
# swift-crypto 5.0.3: Foundation on macOS 15 lacks Data.mutableBytes.
# The dependency already uses the equivalent unsafe-buffer path on visionOS 1.0.
if ($IsMacOS) {
    $path = Join-Path $ScratchPath 'checkouts/swift-crypto/Sources/CryptoBoringWrapper/AEAD/BoringSSLAEAD.swift'
    Apply-CheckedPatch $path 'if #available(visionOS 1.1, *) {' 'if #available(macOS 9999, visionOS 1.1, *) {'
}
# swift-nio-extras 1.35.2 ships a configure-generated Unix zlib header.
if ($IsWindows) {
    $path = Join-Path $ScratchPath 'checkouts/swift-nio-extras/Sources/CNIOExtrasZlib/include/nioextras-zconf.h'
    Apply-CheckedPatch $path "#if 1     /* was set to #if 1 by ./configure */`n#  define CNIOEXTRAS_Z_HAVE_UNISTD_H" "#if !defined(_WIN32) /* Windows has no unistd.h */`n#  define CNIOEXTRAS_Z_HAVE_UNISTD_H"
}
