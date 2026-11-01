#Requires -Version 7.2
# Builds a data-only ICU subset without changing the installed SDK.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$IcuArchive,
    [string]$OutputDirectory,
    [ValidateSet('linux-x86_64', 'linux-arm64')]
    [string]$Target = 'linux-x86_64',
    [string[]]$Languages = @('root', 'en', 'zh', 'es', 'de', 'fr', 'ru', 'ja', 'pt', 'it', 'ko')
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
foreach ($tool in @('llvm-ar', 'llvm-objcopy', 'llvm-nm', 'clang', 'icupkg')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "Required ICU subset tool missing: $tool" }
}
$IcuArchive = (Resolve-Path -LiteralPath $IcuArchive).Path
if (-not $OutputDirectory) { $OutputDirectory = Join-Path (Split-Path $PSScriptRoot -Parent) "dist/api/icu/$Target" }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$null = New-Item -ItemType Directory -Force -Path $OutputDirectory
Push-Location $OutputDirectory
try {
    & llvm-ar x $IcuArchive icu_packaged_data.cpp.o
    if ($LASTEXITCODE -ne 0) { throw 'Cannot extract the SDK ICU data object.' }
    $object = Join-Path $OutputDirectory 'icu_packaged_data.cpp.o'
    $nm = @(& llvm-nm -g $object)
    if ($LASTEXITCODE -ne 0) { throw 'Unable to read ICU symbol.' }
    $symbolLine = @($nm | Where-Object { $_ -match '\bR icudt\d+_dat$' })
    if ($symbolLine.Count -ne 1) { throw 'Unexpected ICU data object layout.' }
    $symbol = ($symbolLine[0] -split '\s+')[-1]
    $version = [regex]::Match($symbol, 'icudt(\d+)_dat').Groups[1].Value
    $fullData = Join-Path $OutputDirectory "icudt${version}l.dat"
    & llvm-objcopy "--dump-section=.rodata=$fullData" $object
    if ($LASTEXITCODE -ne 0) { throw 'Cannot extract ICU .rodata.' }
    # Reject an archive for the wrong target before producing a replacement object.
    $machine = if ($Target -eq 'linux-arm64') { 183 } else { 62 }
    $header = [IO.File]::ReadAllBytes($object)
    if ($header[0] -ne 0x7f -or $header[4] -ne 2 -or $header[5] -ne 1 -or [BitConverter]::ToUInt16($header, 18) -ne $machine) { throw "Expected a 64-bit little-endian ELF ICU archive for $Target." }
    $items = @(& icupkg -l $fullData)
    if ($LASTEXITCODE -ne 0) { throw 'icupkg cannot read this SDK data version.' }
    $items | Set-Content (Join-Path $OutputDirectory 'items.txt') -Encoding utf8NoBOM
    $remove = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($item in $items) {
        if (-not $item.EndsWith('.res')) { continue }
        $stem = [IO.Path]::GetFileNameWithoutExtension($item)
        $language = ($stem -split '_')[0]
        if ($stem -in @('res_index', 'pool')) { continue }
        if (($language -cmatch '^[a-zA-Z]{2,3}$' -or $stem -eq 'root') -and $language -notin $Languages) { $null = $remove.Add($item) }
    }
    $removeFile = Join-Path $OutputDirectory 'remove-locales.txt'
    $slimData = Join-Path $OutputDirectory "icudt${version}l-slim.dat"
    $restored = [Collections.Generic.List[string]]::new()
    $success = $false
    for ($round = 0; $round -lt 100; $round++) {
        @($remove | Sort-Object) | Set-Content $removeFile -Encoding utf8NoBOM
        $diagnostics = @(& icupkg --toc_prefix "icudt${version}l" -r $removeFile $fullData $slimData 2>&1)
        $code = $LASTEXITCODE
        if ($code -eq 0) { $success = $true; break }
        $changed = $false
        foreach ($line in $diagnostics) {
            if ("$line" -match 'depends on missing item (\S+)') {
                if ($remove.Remove($Matches[1])) { $restored.Add($Matches[1]); $changed = $true }
            }
        }
        if (-not $changed) { throw "Dependency validation failed: $($diagnostics -join '; ')" }
    }
    if (-not $success) { throw 'ICU resource dependencies did not converge.' }
    # Validate the package namespace before creating an object; a renamed ToC
    # may pass packaging checks but makes ICU lookups fail at runtime.
    $data = [IO.File]::ReadAllBytes($slimData)
    $headerSize = [BitConverter]::ToUInt16($data, 0)
    $nameOffset = [BitConverter]::ToUInt32($data, $headerSize + 4)
    $nameStart = $headerSize + $nameOffset
    $nameEnd = [Array]::IndexOf($data, [byte]0, [int]$nameStart)
    if ($nameEnd -lt $nameStart) { throw 'ICU package has no valid first entry name.' }
    $firstName = [Text.Encoding]::UTF8.GetString($data, [int]$nameStart, [int]($nameEnd - $nameStart))
    $tocPrefix = "icudt${version}l"
    if (-not $firstName.StartsWith("$tocPrefix/", [StringComparison]::Ordinal)) { throw "Wrong ICU package namespace: $firstName" }
    $wrappedSymbol = "__wrap_$symbol"
    $source = Join-Path $OutputDirectory 'icu-wrapped.S'
    $dataPath = $slimData.Replace('\', '/').Replace('"', '\"')
    @"
.section .rodata.$wrappedSymbol,"a",@progbits
.balign 16
.global $wrappedSymbol
.type $wrappedSymbol,@object
${wrappedSymbol}:
.incbin "$dataPath"
.size $wrappedSymbol, .-$wrappedSymbol
.section .note.GNU-stack,"",@progbits
"@ | Set-Content $source -Encoding utf8NoBOM
    $dataHash = (Get-FileHash $slimData -Algorithm SHA256).Hash.ToLowerInvariant()
    $wrappedObject = Join-Path $OutputDirectory ("icu-wrapped-$Target-" + $dataHash.Substring(0, 16) + '.o')
    $triple = if ($Target -eq 'linux-arm64') { 'aarch64-unknown-linux-musl' } else { 'x86_64-unknown-linux-musl' }
    if (-not (Test-Path -LiteralPath $wrappedObject)) {
        & clang "--target=$triple" -c $source -o $wrappedObject
        if ($LASTEXITCODE -ne 0) { throw 'Cannot compile the replacement data object.' }
    }
    $profile = [ordered]@{
        target = $Target; profile = 'locale-subset'; icuSymbol = $symbol; tocPrefix = $tocPrefix
        sourceArchive = $IcuArchive; sourceArchiveSha256 = (Get-FileHash $IcuArchive -Algorithm SHA256).Hash.ToLowerInvariant()
        languages = $Languages; removedItems = $remove.Count; dependencyRestored = @($restored)
        fullDataSha256 = (Get-FileHash $fullData -Algorithm SHA256).Hash.ToLowerInvariant()
        slimDataSha256 = $dataHash
        fullDataBytes = (Get-Item $fullData).Length; slimDataBytes = (Get-Item $slimData).Length
        linkerArguments = @("--wrap=$symbol", $wrappedObject)
        warning = 'Locale subset changes Foundation behavior; indexes/available locales are not regenerated. Removed locales may fall back; use -FullICU for the complete SDK data.'
    }
    $profile | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $OutputDirectory 'profile.json') -Encoding utf8
    $profile | ConvertTo-Json -Depth 4
} finally { Pop-Location }
