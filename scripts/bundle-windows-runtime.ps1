#Requires -Version 7.2
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Binary,
    [Parameter(Mandatory)][string]$Destination,
    [Parameter(Mandatory)][string[]]$RuntimeDirectories,
    [Parameter(Mandatory)][ValidateSet('x86_64', 'arm64')][string]$Architecture,
    [string]$SystemDirectory = $(if ($env:SystemRoot) { Join-Path $env:SystemRoot 'System32' } else { '' })
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# PE32+ import and delay-import tables. Read them directly so packaging does not
# depend on Visual Studio dumpbin or on a particular LLVM tool installation.
function Read-PeImports([string]$Path, [switch]$HeadersOnly) {
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 64 -or [BitConverter]::ToUInt16($bytes, 0) -ne 0x5a4d) { throw "Not a PE image: $Path" }
    $pe = [BitConverter]::ToInt32($bytes, 60)
    if ($pe -lt 64 -or $pe + 264 -gt $bytes.Length -or [BitConverter]::ToUInt32($bytes, $pe) -ne 0x4550) { throw "Invalid PE header: $Path" }
    $machine = [BitConverter]::ToUInt16($bytes, $pe + 4)
    if ($HeadersOnly -or $machine -notin @(0x8664, 0xaa64)) { return [pscustomobject]@{ Machine = $machine; Imports = @() } }
    $count = [BitConverter]::ToUInt16($bytes, $pe + 6)
    $optional = $pe + 24
    if ([BitConverter]::ToUInt16($bytes, $optional) -ne 0x20b) { throw "Expected PE32+: $Path" }
    $sections = $optional + [BitConverter]::ToUInt16($bytes, $pe + 20)
    $headerSize = [BitConverter]::ToUInt32($bytes, $optional + 60)
    function Convert-Rva([uint32]$Rva) {
        if ($Rva -lt $headerSize -and $Rva -lt $bytes.Length) { return [int]$Rva }
        for ($i = 0; $i -lt $count; $i++) {
            $section = $sections + 40 * $i
            $start = [BitConverter]::ToUInt32($bytes, $section + 12)
            $rawSize = [BitConverter]::ToUInt32($bytes, $section + 16)
            if ($Rva -ge $start -and [long]$Rva -lt [long]$start + $rawSize) {
                $offset = [long][BitConverter]::ToUInt32($bytes, $section + 20) + $Rva - $start
                if ($offset -lt $bytes.Length) { return [int]$offset }
            }
        }
        throw "Unmapped PE RVA $Rva in $Path"
    }
    function Read-ImportName([uint32]$Rva) {
        $offset = Convert-Rva $Rva
        $end = $offset
        while ($end -lt $bytes.Length -and $bytes[$end] -ne 0 -and $end - $offset -lt 512) { $end++ }
        if ($end -eq $bytes.Length -or $bytes[$end] -ne 0) { throw "Invalid DLL name in $Path" }
        [Text.Encoding]::ASCII.GetString($bytes, $offset, $end - $offset)
    }
    $imports = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $directoryCount = [BitConverter]::ToUInt32($bytes, $optional + 108)
    foreach ($directory in @(1, 13)) {
        if ($directoryCount -le $directory) { continue }
        $rva = [BitConverter]::ToUInt32($bytes, $optional + 112 + 8 * $directory)
        if ($rva -eq 0) { continue }
        $offset = Convert-Rva $rva
        $stride = if ($directory -eq 1) { 20 } else { 32 }
        while ($true) {
            if ($offset + $stride -gt $bytes.Length) { throw "Truncated import table in $Path" }
            $name = [BitConverter]::ToUInt32($bytes, $offset + $(if ($directory -eq 1) { 12 } else { 4 }))
            if ($name -eq 0) { break }
            if ($directory -eq 13 -and ([BitConverter]::ToUInt32($bytes, $offset) -band 1) -eq 0) { throw "Unsupported VA-based delay import in $Path" }
            $null = $imports.Add((Read-ImportName $name))
            $offset += $stride
        }
    }
    [pscustomobject]@{ Machine = $machine; Imports = @($imports) }
}

$expectedMachine = if ($Architecture -eq 'arm64') { 0xaa64 } else { 0x8664 }
$index = [Collections.Generic.Dictionary[string, string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($directory in $RuntimeDirectories) {
    if (-not $directory -or -not (Test-Path -LiteralPath $directory)) { continue }
    foreach ($file in Get-ChildItem -LiteralPath $directory -Filter '*.dll' -File -Recurse) {
        if ($index.ContainsKey($file.Name)) { continue }
        if ((Read-PeImports $file.FullName -HeadersOnly).Machine -eq $expectedMachine) { $index.Add($file.Name, $file.FullName) }
    }
}
$null = New-Item -ItemType Directory -Path $Destination -Force
$queue = [Collections.Generic.Queue[string]]::new()
$queue.Enqueue([IO.Path]::GetFullPath($Binary))
$visited = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
while ($queue.Count) {
    $path = $queue.Dequeue()
    if (-not $visited.Add($path)) { continue }
    $image = Read-PeImports $path
    if ($image.Machine -ne $expectedMachine) { throw "Wrong PE architecture for $Architecture`: $path" }
    Copy-Item -LiteralPath $path -Destination (Join-Path $Destination ([IO.Path]::GetFileName($path))) -Force
    foreach ($name in $image.Imports) {
        if ($index.ContainsKey($name)) {
            $queue.Enqueue($index[$name])
        } elseif ($name -match '^(vcruntime|msvcp|concrt|vcomp)[0-9].*\.dll$') {
            throw "Missing redistributable CRT $name; install the matching Visual Studio C++ tools."
        } elseif ($name -like 'api-ms-win-*'  -or $name -like 'ext-ms-win-*') {
            continue # Windows API-set contracts are resolved by the OS loader.
        } elseif (-not $SystemDirectory -or -not (Test-Path -LiteralPath (Join-Path $SystemDirectory $name))) {
            throw "Missing runtime DLL $name required by $path"
        }
    }
}
Write-Host "Bundled $($visited.Count - 1) runtime DLLs for $Architecture."
