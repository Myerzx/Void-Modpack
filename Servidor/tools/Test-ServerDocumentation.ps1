[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$serverRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$errors = [System.Collections.Generic.List[string]]::new()
$absolutePathPattern = '(?i)[A-Z]:\\' + 'Users\\|H:\\' + 'void pasta|' + 'file:' + '//'

function Add-ServerError([string]$Message) { $errors.Add($Message) }

$summaryPath = Join-Path $serverRoot 'catalog\resumo-servidor.json'
try { $summary = Get-Content -LiteralPath $summaryPath -Raw | ConvertFrom-Json } catch { Add-ServerError "Invalid summary JSON: $($_.Exception.Message)"; $summary = $null }
if ($summary) {
    if ($summary.profile.minecraft -ne '1.20.1') { Add-ServerError 'Unexpected Minecraft version.' }
    if ($summary.profile.forge -ne '1.20.1-47.4.4') { Add-ServerError 'Unexpected Forge version.' }
    if ($summary.inventory.modsActive -ne 181) { Add-ServerError 'Active mod count drifted from the audited server.' }
    if ($summary.compatibility.embeddedClientExactCommon -ne 178) { Add-ServerError 'Embedded client compatibility inventory drifted.' }
    if ($summary.compatibility.currentLauncherExactCommon -ne 11) { Add-ServerError 'Current launcher comparison drifted.' }
}

$template = Get-Content -LiteralPath (Join-Path $serverRoot 'templates\server.properties.example') -Raw
foreach ($required in @('online-mode=true','white-list=true','enforce-whitelist=true','enable-rcon=false')) {
    if ($template -notmatch [regex]::Escape($required)) { Add-ServerError "Secure template is missing $required" }
}

$publicFiles = @(Get-ChildItem -LiteralPath $serverRoot -Recurse -Force -File | Where-Object {
    $_.FullName -notmatch '[\\/]workspace[\\/]' -and $_.FullName -notmatch '[\\/]build[\\/]'
}) + @(Get-ChildItem -LiteralPath (Join-Path $repoRoot 'docs\servidor') -Recurse -Force -File -ErrorAction SilentlyContinue)
$bannedNames = @('server.properties','ops.json','whitelist.json','banned-ips.json','banned-players.json','usercache.json','usernamecache.json','servers.dat','minecraftinstance.json','.curseclient')
foreach ($file in $publicFiles) {
    $relative = $file.FullName.Substring($repoRoot.Length + 1).Replace('\','/')
    if ($file.Name -in $bannedNames) { Add-ServerError "Sensitive runtime file in public scope: $relative" }
    if ($file.Name -match '(?i)\.(jar|mca|dat|nbt|rar|zip|exe|dll|class|sqlite|log)$') { Add-ServerError "Runtime/binary artifact in public scope: $relative" }
    if ($file.Length -gt 95MB) { Add-ServerError "Public file exceeds 95 MB: $relative" }
    if ($file.Extension -in @('.md','.json','.csv','.ps1','.txt','.properties','.example','.toml','.yml','.yaml')) {
        $content = Get-Content -LiteralPath $file.FullName -Raw
        if ($content -match $absolutePathPattern) { Add-ServerError "Absolute local path in public file: $relative" }
        if ($content -match '(?im)^[ \t]*rcon\.password[ \t]*=[ \t]*\S+') { Add-ServerError "RCON password in public file: $relative" }
        if ($content -match '(?im)^[ \t]*level-seed[ \t]*=[ \t]*\S+') { Add-ServerError "World seed in public file: $relative" }
        if ($content -match '(?im)^[ \t]*server-ip[ \t]*=[ \t]*\S+') { Add-ServerError "Server IP in public file: $relative" }
    }
}

$workspaceProbe = Join-Path $serverRoot 'workspace\server-original\server.properties'
& git -C $repoRoot check-ignore -q -- $workspaceProbe
if ($LASTEXITCODE -ne 0) { Add-ServerError 'Raw server workspace is not ignored by Git.' }

if ($errors.Count) {
    $details = ($errors | ForEach-Object { "- $_" }) -join [Environment]::NewLine
    throw "Server documentation validation failed with $($errors.Count) error(s):$([Environment]::NewLine)$details"
}
Write-Host "Server documentation validation passed: $($publicFiles.Count) public files inspected."
