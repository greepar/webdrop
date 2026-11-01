#Requires -Version 7.2
[CmdletBinding()]
param(
    [ValidateSet('auto', 'linux-x86_64', 'linux-arm64', 'macos-x86_64', 'macos-arm64', 'windows-x86_64', 'windows-arm64')]
    [string]$Target = 'auto',
    [ValidateRange(1, 256)]
    [int]$Jobs = 4,
    [string]$OutputDirectory,
    [switch]$KeepSymbols,
    [switch]$SkipStrip,
    [switch]$ApiOnly,
    [switch]$SkipWebBuild,
    [switch]$FullICU,
    [string]$IcuArchive,
    [string[]]$ExtraLinkerArguments = @()
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$projectRoot = Split-Path -Parent $PSScriptRoot
$apiDirectory = Join-Path $projectRoot 'apps/api'
$hostArchitecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
if ($Target -eq 'auto') {
    $architecture = if ($hostArchitecture -eq 'Arm64') { 'arm64' } elseif ($hostArchitecture -eq 'X64') { 'x86_64' } else { throw "Unsupported host architecture: $hostArchitecture" }
    $Target = if ($IsWindows) { "windows-$architecture" } elseif ($IsMacOS) { "macos-$architecture" } else { "linux-$architecture" }
}
$isWindowsTarget = $Target.StartsWith('windows-')
$isLinuxTarget = $Target.StartsWith('linux-')
if ($isWindowsTarget) {
    if (-not $IsWindows) { throw 'Windows targets require a native Windows runner and Swift SDK.' }
    $expectedArchitecture = if ($Target -eq 'windows-arm64') { 'Arm64' } else { 'X64' }
    if ($hostArchitecture -ne $expectedArchitecture) { throw "Use a native $expectedArchitecture Windows runner for $Target." }
}
if ($Target.StartsWith('macos-') -and -not $IsMacOS) { throw 'macOS targets require a macOS runner and its Apple SDK.' }
if (-not (Get-Command swift -ErrorAction SilentlyContinue)) { throw 'Install a matching Swift toolchain and (for Linux targets) Static Linux SDK first. See apps/api/README.md.' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot 'dist/api' }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$scratchName = if ($Target -eq 'linux-x86_64') { 'static-linux' } else { "package-$Target" }
$options = @('--package-path', $apiDirectory, '--scratch-path', (Join-Path $apiDirectory ".build/$scratchName"),
    '-c', 'release', '--product', 'webdrop', '--force-resolved-versions', '-j', "$Jobs")
if ($isLinuxTarget) {
    $sdk = if ($Target -eq 'linux-arm64') { 'aarch64-swift-linux-musl' } else { 'x86_64-swift-linux-musl' }
    $options += @('--build-system', 'native', '--swift-sdk', $sdk)
} elseif (-not $isWindowsTarget) {
    $triple = if ($Target -eq 'macos-arm64') { 'arm64-apple-macosx13.0' } else { 'x86_64-apple-macosx13.0' }
    $options += @('--triple', $triple)
}

if (-not $ApiOnly) {
    & (Join-Path $PSScriptRoot 'embed-web.ps1') -SkipBuild:$SkipWebBuild
    $options += @('-Xswiftc', '-DWEBDROP_EMBED_WEB')
}

$icuProfile = $null
$icuMode = if ($isLinuxTarget) { 'full' } elseif ($isWindowsTarget) { 'runtime' } else { 'system' }
if ($isLinuxTarget -and -not $FullICU) {
    if (-not $IcuArchive) {
        # Ask Swift for this toolchain's installed SDK configuration instead of guessing $HOME paths.
        $swiftVersion = (& swift --version) -join "`n"
        if ($LASTEXITCODE -ne 0 -or $swiftVersion -notmatch 'Swift version (\d+\.\d+(?:\.\d+)?)') { throw 'Cannot determine the Swift version for ICU SDK discovery. Use -IcuArchive to provide the matching archive.' }
        $version = $Matches[1]
        $installed = @(& swift sdk list)
        if ($LASTEXITCODE -ne 0) { throw 'Cannot list installed Swift SDKs.' }
        $matching = @($installed | Where-Object { $_ -match "^swift-$([regex]::Escape($version))-RELEASE_static-linux-" })
        if ($matching.Count -ne 1) { throw 'Cannot uniquely select a matching Static Linux SDK. Use -IcuArchive with the archive used by this toolchain.' }
        $configuration = @(& swift sdk configure --show-configuration $matching[0] $sdk)
        if ($LASTEXITCODE -ne 0) { throw 'Cannot read the Static Linux SDK configuration.' }
        $roots = @($configuration | Where-Object { $_ -match '^swiftStaticResourcesPath: ' })
        if ($roots.Count -ne 1) { throw 'The SDK does not declare a static resources path. Use -IcuArchive.' }
        $resourceRoot = $roots[0].Substring('swiftStaticResourcesPath: '.Length).Trim()
        $IcuArchive = Join-Path $resourceRoot 'linux-static/lib_FoundationICU.a'
    }
    $icuDirectory = Join-Path $apiDirectory ".build/icu/$Target"
    & (Join-Path $PSScriptRoot 'prepare-icu.ps1') -IcuArchive $IcuArchive -Target $Target -OutputDirectory $icuDirectory | Out-Host
    $icuProfile = Get-Content -LiteralPath (Join-Path $icuDirectory 'profile.json') -Raw | ConvertFrom-Json
    $icuMode = 'locale-subset'
    foreach ($argument in $icuProfile.linkerArguments) { $options += @('-Xlinker', $argument) }
    Write-Host "ICU locale subset: $($icuProfile.languages -join ', '); use -FullICU for complete locale data."
}

foreach ($argument in $ExtraLinkerArguments) { $options += @('-Xlinker', $argument) }

# Read ELF headers directly: no platform-specific readelf/grep/install required.
function Assert-StaticElf([string]$Path, [string]$TargetName) {
    $stream = [IO.File]::OpenRead($Path)
    $reader = [IO.BinaryReader]::new($stream)
    try {
        $header = $reader.ReadBytes(64)
        if ($header.Length -ne 64 -or [BitConverter]::ToString($header[0..3]) -ne '7F-45-4C-46' -or $header[4] -ne 2 -or $header[5] -ne 1) { throw 'Expected a 64-bit little-endian ELF executable.' }
        $machine = [BitConverter]::ToUInt16($header, 18)
        $expected = if ($TargetName -eq 'linux-arm64') { 183 } else { 62 }
        if ($machine -ne $expected) { throw "ELF machine $machine does not match $TargetName." }
        $offset = [BitConverter]::ToUInt64($header, 32)
        $entrySize = [BitConverter]::ToUInt16($header, 54)
        $count = [BitConverter]::ToUInt16($header, 56)
        if ($entrySize -lt 56 -or $count -eq 0) { throw 'Invalid ELF program header table.' }
        for ($i = 0; $i -lt $count; $i++) {
            $null = $stream.Seek([long]($offset + $i * $entrySize), [IO.SeekOrigin]::Begin)
            $program = $reader.ReadBytes(56)
            if ($program.Length -ne 56) { throw 'Truncated ELF program header.' }
            $kind = [BitConverter]::ToUInt32($program, 0)
            if ($kind -eq 3) { throw 'ELF contains PT_INTERP: the result is not fully static.' }
            if ($kind -eq 2) {
                $dynamicOffset = [BitConverter]::ToUInt64($program, 8)
                $dynamicSize = [BitConverter]::ToUInt64($program, 32)
                $null = $stream.Seek([long]$dynamicOffset, [IO.SeekOrigin]::Begin)
                for ($j = 0; $j -lt $dynamicSize; $j += 16) {
                    $tag = $reader.ReadInt64(); $null = $reader.ReadUInt64()
                    if ($tag -eq 1) { throw 'ELF contains DT_NEEDED: shared libraries are still required.' }
                    if ($tag -eq 0) { break }
                }
            }
        }
    } finally { $reader.Dispose(); $stream.Dispose() }
}

$scratchPath = Join-Path $apiDirectory ".build/$scratchName"
& swift package --package-path $apiDirectory --scratch-path $scratchPath resolve --force-resolved-versions
if ($LASTEXITCODE -ne 0) { throw 'Dependency resolution failed.' }
& (Join-Path $PSScriptRoot 'patch-swift-dependencies.ps1') -ScratchPath $scratchPath

Write-Host "Building $Target"
& swift build @options
if ($LASTEXITCODE -ne 0) { throw "Swift build failed ($LASTEXITCODE)." }
$binOutput = @(& swift build @options --show-bin-path)
if ($LASTEXITCODE -ne 0 -or $binOutput.Count -ne 1) { throw 'Unable to determine Swift build output directory.' }
$binary = Join-Path $binOutput[0].Trim() $(if ($isWindowsTarget) { 'webdrop.exe' } else { 'webdrop' })
if ($isLinuxTarget) { Assert-StaticElf $binary $Target }
$null = New-Item -ItemType Directory -Force -Path $OutputDirectory
$artifact = Join-Path $OutputDirectory "webdrop-$Target"
if ($KeepSymbols) {
    $symbols = Join-Path $OutputDirectory 'symbols'
    $null = New-Item -ItemType Directory -Force -Path $symbols
    Copy-Item -LiteralPath $binary -Destination (Join-Path $symbols "webdrop-$Target.unstripped") -Force
}
Copy-Item -LiteralPath $binary -Destination $artifact -Force
if (-not $IsWindows) {
    & chmod 755 $artifact
    if ($LASTEXITCODE -ne 0) { throw 'Unable to make output executable.' }
}
if (-not $SkipStrip -and -not $isWindowsTarget) {
    $tool = if ($isLinuxTarget) { Get-Command llvm-strip, strip -ErrorAction SilentlyContinue | Select-Object -First 1 } else { Get-Command strip -ErrorAction SilentlyContinue }
    if (-not $tool) { throw 'Install llvm-strip (recommended for Linux cross targets) or use -SkipStrip for diagnostic builds.' }
    $stripOptions = if ($isLinuxTarget) { @('--strip-unneeded', $artifact) } else { @('-S', '-x', $artifact) }
    & $tool.Source @stripOptions
    if ($LASTEXITCODE -ne 0) { throw "strip failed ($LASTEXITCODE)." }
}
if ($isLinuxTarget) { Assert-StaticElf $artifact $Target }
if ($isWindowsTarget) {
    $bundle = Join-Path $OutputDirectory $Target
    $null = New-Item -ItemType Directory -Force -Path $bundle
    Copy-Item $binary (Join-Path $bundle 'webdrop.exe') -Force
    $targetInfo = (& swift -print-target-info | Out-String | ConvertFrom-Json)
    if ($LASTEXITCODE -ne 0) { throw 'Cannot query Swift runtime paths' }
    $runtimePaths = @($targetInfo.paths.runtimeLibraryPaths) + @((Split-Path (Get-Command swift).Source))
    foreach ($path in $runtimePaths) {
        if (Test-Path $path) {
            Get-ChildItem $path -Filter '*.dll' -File -Recurse | ForEach-Object { Copy-Item $_.FullName $bundle -Force }
            $siblingBin = Join-Path (Split-Path $path -Parent) 'bin'
            if (Test-Path $siblingBin) { Get-ChildItem $siblingBin -Filter '*.dll' -File | ForEach-Object { Copy-Item $_.FullName $bundle -Force } }
        }
    }
    Copy-Item (Join-Path $projectRoot 'LICENSE') $bundle -Force
    $artifact = Join-Path $OutputDirectory "webdrop-$Target.zip"
    Compress-Archive -Path (Join-Path $bundle '*') -DestinationPath $artifact -Force
}
$metadata = [ordered]@{
    target = $Target; file = [IO.Path]::GetFileName($artifact)
    bytes = (Get-Item -LiteralPath $artifact).Length
    sha256 = (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash.ToLowerInvariant()
    embeddedWeb = -not $ApiOnly
    icuMode = $icuMode
    icu = if ($icuProfile) { $icuProfile } else { $null }
    linkerArguments = @($ExtraLinkerArguments)
    fullyStatic = $isLinuxTarget; stripped = -not $SkipStrip -and -not $isWindowsTarget
    swiftVersion = ((& swift --version) -join "`n")
}
if ($LASTEXITCODE -ne 0) { throw 'Unable to query Swift version.' }
$metadata | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath "$artifact.json" -Encoding utf8
Write-Host ($metadata | ConvertTo-Json -Depth 6)
