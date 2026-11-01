#Requires -Version 7.2
[CmdletBinding()]
param([switch]$Check)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$root = Split-Path $PSScriptRoot -Parent
$formatter = Get-Command swift-format -ErrorAction SilentlyContinue
if (-not $formatter) { throw 'Install swift-format 604.x (the official formatter matching Swift 6.4), then rerun this command.' }
$version = (& $formatter.Source --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $version -notmatch '^604\.') { throw "Expected swift-format 604.x, found: $version" }

function Get-MaintainedSwiftFiles([string]$Directory) {
    Get-ChildItem -LiteralPath $Directory -File -Filter '*.swift'
    foreach ($child in Get-ChildItem -LiteralPath $Directory -Directory) {
        if ($child.Name -in @('.build', '.swiftpm', '.data', 'Generated', 'Packages', 'dist', 'node_modules')) { continue }
        if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
        Get-MaintainedSwiftFiles $child.FullName
    }
}
$files = @(
    Get-MaintainedSwiftFiles (Join-Path $root 'apps/api')
    Get-MaintainedSwiftFiles (Join-Path $root 'scripts/probes')
) | Sort-Object FullName
if ($files.Count -eq 0) { throw 'No maintained Swift source files found.' }
$options = if ($Check) { @('lint', '--strict') } else { @('format', '--in-place') }
$options += @('--configuration', (Join-Path $root '.swift-format'))
$options += @($files | ForEach-Object { $_.FullName })
& $formatter.Source @options
if ($LASTEXITCODE -ne 0) { throw "Swift style check/format failed ($LASTEXITCODE)." }
Write-Host "$($files.Count) Swift files processed with swift-format $version."
