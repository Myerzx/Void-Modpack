[CmdletBinding()]
param(
    [string]$ProfilePath = (Join-Path $PSScriptRoot '..\workspace\profile-original'),
    [string]$OverridesPath = (Join-Path $PSScriptRoot '..\pack\overrides')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$profile = (Resolve-Path -LiteralPath $ProfilePath).Path
$launcherRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$overrides = [System.IO.Path]::GetFullPath($OverridesPath)

if (-not $overrides.StartsWith($launcherRoot + '\',[System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Overrides target escaped Launcher scope: $overrides"
}

New-Item -ItemType Directory -Path $overrides -Force | Out-Null
$configTarget = Join-Path $overrides 'config'
New-Item -ItemType Directory -Path $configTarget -Force | Out-Null

$configDirectories = @('fancymenu','konkrete','voicechat')
foreach ($name in $configDirectories) {
    $source = Join-Path $profile "config\$name"
    if (Test-Path -LiteralPath $source) {
        Copy-Item -LiteralPath $source -Destination $configTarget -Recurse -Force
    }
}

$configFiles = @(
    'armourers_workshop-client.toml',
    'armourers_workshop-common.toml',
    'borninconfiguration-general.toml',
    'curios-client.toml',
    'curios-common.toml',
    'epicfight.toml',
    'epicfight-client.toml',
    'mine_and_slash_neat_gui-client.toml',
    'mine_and_slash-client.toml',
    'roe_weapons-bow-settings.toml',
    'roe_weapons-client.toml',
    'roe_weapons-enchantments.toml',
    'roe_weapons-settings.toml',
    'tectonic.json',
    'voicechat-client.toml',
    'wom.toml',
    'wom-client.toml'
)

foreach ($name in $configFiles) {
    $source = Join-Path $profile "config\$name"
    if (Test-Path -LiteralPath $source) {
        Copy-Item -LiteralPath $source -Destination (Join-Path $configTarget $name) -Force
    }
}

Copy-Item -LiteralPath (Join-Path $profile 'options.txt') -Destination (Join-Path $overrides 'options.txt') -Force

$openLoaderTarget = Join-Path $overrides 'openloader'
New-Item -ItemType Directory -Path $openLoaderTarget -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $profile 'openloader\advanced_options.json') -Destination (Join-Path $openLoaderTarget 'advanced_options.json') -Force

$fancyOptions = Join-Path $configTarget 'fancymenu\options.txt'
if (Test-Path -LiteralPath $fancyOptions) {
    $content = Get-Content -LiteralPath $fancyOptions -Raw
    $content = $content -replace "S:preload_resources = '[^']*';", "S:preload_resources = '';"
    Set-Content -LiteralPath $fancyOptions -Value $content -Encoding UTF8
}

$multiplayerLayout = Join-Path $configTarget 'fancymenu\customization\multiplayerselect.txt'
if (Test-Path -LiteralPath $multiplayerLayout) {
    $content = Get-Content -LiteralPath $multiplayerLayout -Raw
    $content = $content -replace '\[source:local\]/config/fancymenu/assets/mainaudio\.wav', '[source:local]/config/fancymenu/assets/musica-inicial.ogg'
    Set-Content -LiteralPath $multiplayerLayout -Value $content -Encoding UTF8
}

Write-Host "Curated overrides synchronized to: $overrides"
Write-Warning 'Legacy OpenLoader data/resources were intentionally not copied; see docs/launcher/auditoria.md.'

