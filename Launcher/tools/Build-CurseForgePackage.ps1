[CmdletBinding()]
param(
    [string]$PackPath = (Join-Path $PSScriptRoot '..\pack'),
    [string]$BuildPath = (Join-Path $PSScriptRoot '..\build')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

& (Join-Path $PSScriptRoot 'Test-LauncherPack.ps1') -PackPath $PackPath

$pack = (Resolve-Path -LiteralPath $PackPath).Path
$manifest = Get-Content -LiteralPath (Join-Path $pack 'manifest.json') -Raw | ConvertFrom-Json
$launcherRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$build = [System.IO.Path]::GetFullPath($BuildPath)
if (-not $build.StartsWith($launcherRoot + '\',[System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Build target escaped Launcher scope: $build"
}
New-Item -ItemType Directory -Path $build -Force | Out-Null
$archive = Join-Path $build ("VoidFall-{0}-curseforge.zip" -f $manifest.version)

if (Test-Path -LiteralPath $archive) {
    Remove-Item -LiteralPath $archive -Force
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archiveStream = [System.IO.File]::Open($archive,[System.IO.FileMode]::CreateNew)
$zip = [System.IO.Compression.ZipArchive]::new($archiveStream,[System.IO.Compression.ZipArchiveMode]::Create,$false)
try {
    $sourceFiles = @((Get-Item -LiteralPath (Join-Path $pack 'manifest.json')))
    $sourceFiles += @(Get-ChildItem -LiteralPath (Join-Path $pack 'overrides') -Recurse -File)
    foreach ($file in $sourceFiles) {
        $entryName = $file.FullName.Substring($pack.Length + 1).Replace('\','/')
        [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $zip,
            $file.FullName,
            $entryName,
            [System.IO.Compression.CompressionLevel]::Optimal
        )
    }
} finally {
    $zip.Dispose()
    $archiveStream.Dispose()
}

$hash = Get-FileHash -LiteralPath $archive -Algorithm SHA256
Set-Content -LiteralPath ($archive + '.sha256') -Value ("{0}  {1}" -f $hash.Hash.ToLowerInvariant(),[System.IO.Path]::GetFileName($archive)) -Encoding ASCII

Write-Host "Built: $archive"
Write-Host "SHA256: $($hash.Hash.ToLowerInvariant())"
