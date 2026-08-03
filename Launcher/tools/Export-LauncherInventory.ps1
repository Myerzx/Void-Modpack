[CmdletBinding()]
param(
    [string]$ProfilePath = (Join-Path $PSScriptRoot '..\workspace\profile-original'),
    [string]$InventoryPath = (Join-Path $PSScriptRoot '..\..\docs\launcher\inventario'),
    [string]$CatalogPath = (Join-Path $PSScriptRoot '..\catalog'),
    [string]$ManifestPath = (Join-Path $PSScriptRoot '..\pack\manifest.json'),
    [string]$PackVersion = '0.1.0-audit'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$profile = (Resolve-Path -LiteralPath $ProfilePath).Path
$instancePath = Join-Path $profile 'minecraftinstance.json'
$legacyManifestPath = Join-Path $profile 'manifest.json'

if (-not (Test-Path -LiteralPath $instancePath)) {
    throw "Missing profile metadata: $instancePath"
}

$instance = Get-Content -LiteralPath $instancePath -Raw | ConvertFrom-Json
$legacyManifest = if (Test-Path -LiteralPath $legacyManifestPath) {
    Get-Content -LiteralPath $legacyManifestPath -Raw | ConvertFrom-Json
} else {
    $null
}

New-Item -ItemType Directory -Path $InventoryPath -Force | Out-Null
New-Item -ItemType Directory -Path $CatalogPath -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $ManifestPath) -Force | Out-Null

$addons = @($instance.installedAddons | ForEach-Object {
    $category = [string]$_.categorySection.path
    [pscustomobject][ordered]@{
        category = $category
        name = [string]$_.name
        enabled = [bool]$_.isEnabled
        projectId = [int64]$_.addonID
        fileId = [int64]$_.installedFile.id
        fileName = [string]$_.fileNameOnDisk
        required = ($category -ne 'shaderpacks')
        distributionAllowed = [bool]$_.allowModDistribution
        projectUrl = [string]$_.webSiteURL
    }
} | Sort-Object category,name)

$enabled = @($addons | Where-Object enabled)
$modFiles = @(Get-ChildItem -LiteralPath (Join-Path $profile 'mods') -File -ErrorAction SilentlyContinue)
$allFiles = @(Get-ChildItem -LiteralPath $profile -Recurse -Force -File -ErrorAction SilentlyContinue)

$topDirectories = @(Get-ChildItem -LiteralPath $profile -Directory -Force | ForEach-Object {
    $directoryFiles = @(Get-ChildItem -LiteralPath $_.FullName -Recurse -Force -File -ErrorAction SilentlyContinue)
    $directoryBytes = if ($directoryFiles.Count -eq 0) { 0 } else { ($directoryFiles | Measure-Object Length -Sum).Sum }
    [pscustomobject][ordered]@{
        name = $_.Name
        files = [int]$directoryFiles.Count
        bytes = [int64]$directoryBytes
    }
} | Sort-Object bytes -Descending)

$summary = [pscustomobject][ordered]@{
    profileName = [string]$instance.name
    minecraftVersion = [string]$instance.gameVersion
    runtimeModLoader = [string]$instance.baseModLoader.name
    legacyManifestName = if ($null -ne $legacyManifest) { [string]$legacyManifest.name } else { $null }
    legacyManifestModLoader = if ($null -ne $legacyManifest) { [string]$legacyManifest.minecraft.modLoaders[0].id } else { $null }
    legacyManifestEntries = if ($null -ne $legacyManifest) { [int]$legacyManifest.files.Count } else { 0 }
    registeredAddons = [int]$addons.Count
    enabledAddons = [int]$enabled.Count
    disabledAddons = [int](@($addons | Where-Object { -not $_.enabled }).Count)
    activeJarFiles = [int](@($modFiles | Where-Object Extension -eq '.jar').Count)
    disabledJarFiles = [int](@($modFiles | Where-Object Name -like '*.jar.disabled').Count)
    totalFiles = [int]$allFiles.Count
    totalBytes = [int64](($allFiles | Measure-Object Length -Sum).Sum)
    topDirectories = $topDirectories
}

$manifestFiles = @($enabled | Sort-Object projectId,fileId | ForEach-Object {
    [pscustomobject][ordered]@{
        projectID = [int64]$_.projectId
        fileID = [int64]$_.fileId
        required = [bool]$_.required
    }
})

$forgeId = [string]$instance.baseModLoader.name
$manifest = [pscustomobject][ordered]@{
    minecraft = [pscustomobject][ordered]@{
        version = [string]$instance.gameVersion
        modLoaders = @([pscustomobject][ordered]@{
            id = $forgeId
            primary = $true
        })
    }
    manifestType = 'minecraftModpack'
    manifestVersion = 1
    name = 'VoidFall'
    version = $PackVersion
    author = 'VoidFall Team'
    files = $manifestFiles
    overrides = 'overrides'
}

$addons | Export-Csv -LiteralPath (Join-Path $InventoryPath 'addons.csv') -NoTypeInformation -Encoding UTF8
$topDirectories | Export-Csv -LiteralPath (Join-Path $InventoryPath 'diretorios.csv') -NoTypeInformation -Encoding UTF8
$summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $InventoryPath 'resumo-perfil.json') -Encoding UTF8
$addons | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $CatalogPath 'addons.json') -Encoding UTF8
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ManifestPath -Encoding UTF8

Write-Host "Inventory exported: $($addons.Count) addons ($($enabled.Count) enabled)."
Write-Host "Manifest written: $ManifestPath"
