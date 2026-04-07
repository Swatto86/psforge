<#
.SYNOPSIS
    Automated release script for PSForge.

.DESCRIPTION
    Validates the version increment, updates all version-bearing project files
    (manifests, lockfiles, UI fallback, and README release examples),
    runs quality gates, commits, tags, pushes, and prunes older releases.

.PARAMETER Version
    Target semantic version in x.y.z format.

.PARAMETER Notes
    Release notes text. Multi-line input collected interactively when omitted.

.PARAMETER Force
    Allow overwriting an existing tag or releasing without a version increment.

.PARAMETER DryRun
    Describe every planned action without modifying files, git, or remote hosting.

.EXAMPLE
    .\update-application.ps1 -Version 1.2.3 -Notes "Fixed critical bug."

.EXAMPLE
    .\update-application.ps1 -DryRun
#>
[CmdletBinding()]
param(
    [string]$Version,
    [string]$Notes,
    [switch]$Force,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Coloured output helpers
# ---------------------------------------------------------------------------
function Write-Info    { param([string]$Msg) Write-Host "[INFO] $Msg" -ForegroundColor Cyan }
function Write-Success { param([string]$Msg) Write-Host "[OK]   $Msg" -ForegroundColor Green }
function Write-WarnLine { param([string]$Msg) Write-Host "[WARN] $Msg" -ForegroundColor Yellow }
function Write-ErrorLine { param([string]$Msg) Write-Host "[ERR]  $Msg" -ForegroundColor Red }

# ---------------------------------------------------------------------------
# Git helpers
#
# CRITICAL: Invoke-Git MUST be a simple (non-advanced) function using the
# automatic $args variable, NOT [Parameter(ValueFromRemainingArguments)].
# Adding any [Parameter()] attribute makes PowerShell bind common parameters
# (-Debug, -Verbose, etc.) whose abbreviations swallow short git flags:
#   -d  -> -Debug   (so `Invoke-Git tag -d v1.0` would CREATE the tag!)
#   -v  -> -Verbose
#   -m  -> could bind in future PS versions
# Using $args has no named-parameter binding; every argument is forwarded verbatim.
# ---------------------------------------------------------------------------
function Invoke-Git {
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $rawOutput = & git @args 2>&1
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    $output = @($rawOutput | ForEach-Object {
        if ($_ -is [System.Management.Automation.ErrorRecord]) {
            $_.ToString()
        }
        else {
            "$_"
        }
    })
    if ($LASTEXITCODE -ne 0) {
        throw "git $($args -join ' ') failed (exit $LASTEXITCODE): $(($output | Out-String).Trim())"
    }
    return $output
}

function Test-IsGitRepository {
    $null = & git rev-parse --is-inside-work-tree 2>&1
    return ($LASTEXITCODE -eq 0)
}

function Get-RemoteHttpsUrl {
    try {
        $raw = (& git remote get-url origin 2>&1) | Out-String
        $raw = $raw.Trim()
        # Convert SSH (git@github.com:owner/repo.git) to HTTPS
        if ($raw -match '^git@([^:]+):(.+?)(?:\.git)?$') {
            return "https://$($Matches[1])/$($Matches[2])"
        }
        return ($raw -replace '\.git$', '')
    }
    catch {
        return '(remote URL unavailable)'
    }
}

function Invoke-Gh {
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $rawOutput = & gh @args 2>&1
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    $output = @($rawOutput | ForEach-Object {
        if ($_ -is [System.Management.Automation.ErrorRecord]) {
            $_.ToString()
        }
        else {
            "$_"
        }
    })
    if ($LASTEXITCODE -ne 0) {
        throw "gh $($args -join ' ') failed (exit $LASTEXITCODE): $(($output | Out-String).Trim())"
    }
    return $output
}

function Get-GitHubRepoSlug {
    $remoteUrl = Get-RemoteHttpsUrl
    if ($remoteUrl -match '^https://github\.com/([^/]+/[^/]+)$') {
        return $Matches[1]
    }
    throw "Origin remote must point at a GitHub HTTPS repository. Found: $remoteUrl"
}

function Test-GitHubReleaseExists {
    param(
        [string]$RepoSlug,
        [string]$TagName
    )

    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $null = & gh release view $TagName --repo $RepoSlug 2>&1
        return ($LASTEXITCODE -eq 0)
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
}

function Set-UpdaterSigningEnvironment {
    $defaultKeyPath = Join-Path $env:USERPROFILE '.tauri\psforge-updater.key'
    if (-not (Test-Path $defaultKeyPath)) {
        throw "Updater signing key not found. Expected: $defaultKeyPath"
    }
    if ([string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY_PATH)) {
        $env:TAURI_SIGNING_PRIVATE_KEY_PATH = $defaultKeyPath
    }
    if ([string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY)) {
        $env:TAURI_SIGNING_PRIVATE_KEY = [System.IO.File]::ReadAllText($defaultKeyPath).TrimEnd("`r", "`n")
    }
    Write-Info "Using updater signing key: $defaultKeyPath"
    if ([string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD)) {
        $persistedPassword = [Environment]::GetEnvironmentVariable('TAURI_SIGNING_PRIVATE_KEY_PASSWORD', 'User')
        if ([string]::IsNullOrWhiteSpace($persistedPassword)) {
            $persistedPassword = [Environment]::GetEnvironmentVariable('TAURI_SIGNING_PRIVATE_KEY_PASSWORD', 'Machine')
        }
        if (-not [string]::IsNullOrWhiteSpace($persistedPassword)) {
            $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $persistedPassword.Trim()
            Write-Info "Loaded updater signing password from persisted environment."
        }
    }
    if (
        $null -ne $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -and
        [string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD)
    ) {
        Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
    }
}

function Get-LatestBundleAsset {
    param(
        [string]$SearchRoot,
        [string]$FilterPattern
    )

    if (-not (Test-Path $SearchRoot)) {
        throw "Bundle folder not found: $SearchRoot"
    }

    $asset = Get-ChildItem -Path $SearchRoot -Recurse -File |
        Where-Object { $_.Name -like $FilterPattern } |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1

    if (-not $asset) {
        throw "Could not find bundle asset matching '$FilterPattern' under $SearchRoot"
    }

    return $asset
}

function Get-AssetSignatureText {
    param([string]$AssetPath)

    $signaturePath = "$AssetPath.sig"
    if (-not (Test-Path $signaturePath)) {
        throw "Signature file not found: $signaturePath"
    }
    return [System.IO.File]::ReadAllText($signaturePath).Trim()
}

function New-StaticUpdaterManifest {
    param(
        [string]$FilePath,
        [string]$Version,
        [string]$Notes,
        [string]$PubDate,
        [string]$PlatformKey,
        [string]$AssetUrl,
        [string]$SignatureText
    )

    $payload = [ordered]@{
        version = $Version
        notes = $Notes
        pub_date = $PubDate
        platforms = [ordered]@{}
    }
    $payload.platforms[$PlatformKey] = [ordered]@{
        signature = $SignatureText
        url = $AssetUrl
    }

    $json = ($payload | ConvertTo-Json -Depth 5)
    [System.IO.File]::WriteAllText(
        $FilePath,
        ($json.TrimEnd("`r", "`n") + "`n"),
        [System.Text.UTF8Encoding]::new($false)
    )
}

# ---------------------------------------------------------------------------
# Path resolution
# ---------------------------------------------------------------------------
function Get-WorkspaceRoot {
    return Split-Path -Parent $PSCommandPath
}

# ---------------------------------------------------------------------------
# Version helpers
# ---------------------------------------------------------------------------

function Get-PackageVersion {
    param([string]$Root)
    $text = [System.IO.File]::ReadAllText((Join-Path $Root 'package.json'))
    if ($text -match '"version"\s*:\s*"(\d+\.\d+\.\d+)"') {
        return $Matches[1]
    }
    throw "Could not read version from package.json"
}

function Compare-SemVer {
    param([string]$A, [string]$B)
    $pa = $A -split '\.' | ForEach-Object { [int]$_ }
    $pb = $B -split '\.' | ForEach-Object { [int]$_ }
    for ($i = 0; $i -lt 3; $i++) {
        if ($pa[$i] -gt $pb[$i]) { return  1 }
        if ($pa[$i] -lt $pb[$i]) { return -1 }
    }
    return 0
}

# Updates the first regex match in a text file while preserving the file's
# original line-ending style and UTF-8-without-BOM encoding.
function Update-ManifestVersion {
    param(
        [string]$FilePath,
        [string]$NewVersion,
        [string]$Pattern,
        [string]$Template,  # e.g. '"version": "NEWVER"' -- literal replacement without groups
        [switch]$AllowNoChange
    )
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    $raw = [System.IO.File]::ReadAllText($FilePath)
    $hasCrlf = $raw -match '\r\n'

    if (-not ($raw -match $Pattern)) {
        throw "Version pattern not found in: $FilePath"
    }

    # Replace only the first match so that dependency versions are untouched.
    $updated = [regex]::Replace($raw, $Pattern, $Template, 1)

    if ($updated -eq $raw) {
        if ($AllowNoChange) {
            return $false
        }
        throw "Version unchanged after replacement in: $FilePath"
    }

    # Normalise to exactly one trailing newline.
    $updated = $updated.TrimEnd("`r", "`n") + "`n"
    if ($hasCrlf) {
        $updated = $updated -replace '(?<!\r)\n', "`r`n"
    }

    [System.IO.File]::WriteAllText($FilePath, $updated, $utf8NoBom)
    return $true
}

# ---------------------------------------------------------------------------
# Main body
# ---------------------------------------------------------------------------
$root = Get-WorkspaceRoot
Set-Location $root

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  PSForge Release Script" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# Paths
$pkgJsonPath   = Join-Path $root 'package.json'
$srcTauriDir = Join-Path $root 'src-tauri'
$srcDir = Join-Path $root 'src'
$componentsDir = Join-Path $srcDir 'components'
$cargoTomlPath = Join-Path $srcTauriDir 'Cargo.toml'
$cargoLockPath = Join-Path $srcTauriDir 'Cargo.lock'
$tauriConfPath = Join-Path $srcTauriDir 'tauri.conf.json'
$bundleDir = Join-Path $srcTauriDir 'target\release\bundle'
$pkgLockPath   = Join-Path $root 'package-lock.json'
$aboutDialogPath = Join-Path $componentsDir 'AboutDialog.tsx'
$readmePath = Join-Path $root 'README.md'

# Snapshot placeholders for rollback (populated in try block before any writes)
$origPkgJson   = $null
$origCargoToml = $null
$origCargoLock = $null
$origTauriConf = $null
$origPkgLock   = $null
$origAboutDialog = $null
$origReadme = $null
$currentVersion = $null
$repoUrl = $null
$repoSlug = $null
$releaseExists = $false
$releaseNotesFile = $null
$generatedLatestJsonPath = $null
$releaseAssetPaths = @()

try {
    # -----------------------------------------------------------------------
    # 1. Collect and validate version
    # -----------------------------------------------------------------------
    $currentVersion = Get-PackageVersion -Root $root
    Write-Info "Current version: $currentVersion"

    if (-not $Version) {
        $Version = Read-Host "Enter new version (current: $currentVersion)"
    }

    if ($Version -notmatch '^\d+\.\d+\.\d+$') {
        throw "Invalid version '$Version'. Must match x.y.z (e.g. 1.2.3)."
    }

    if (-not $Force) {
        $cmp = Compare-SemVer -A $Version -B $currentVersion
        if ($cmp -lt 0) {
            throw "New version $Version must be greater than or equal to $currentVersion. Use -Force to override."
        }
        if ($cmp -eq 0) {
            Write-WarnLine "Requested version matches current version ($currentVersion); proceeding without forced increment."
        }
    }

    # -----------------------------------------------------------------------
    # 2. Collect and validate release notes
    # -----------------------------------------------------------------------
    if (-not $Notes) {
        Write-Info "Enter release notes (press Enter on a blank line when done):"
        $lines = [System.Collections.Generic.List[string]]::new()
        while ($true) {
            $line = Read-Host
            if ($line -eq '') { break }
            $lines.Add($line)
        }
        $Notes = $lines -join "`n"
    }

    if ([string]::IsNullOrWhiteSpace($Notes)) {
        throw "Release notes must not be empty."
    }

    # -----------------------------------------------------------------------
    # 3. Git state checks
    # -----------------------------------------------------------------------
    if (-not $DryRun) {
        if (-not (Test-IsGitRepository)) {
            throw "Not inside a git repository."
        }
    }

    $tagName   = "v$Version"
    $tagExists = $false
    try {
        $foundTag  = & git tag -l $tagName 2>&1
        $tagExists = ($foundTag -contains $tagName)
    }
    catch { }

    if ($tagExists -and -not $Force) {
        throw "Tag $tagName already exists. Use -Force to overwrite."
    }

    $dirtyLines = & git status --porcelain 2>&1
    if ($dirtyLines) {
        Write-WarnLine "Working tree has uncommitted changes."
    }

    $repoUrl = Get-RemoteHttpsUrl
    if (-not $DryRun) {
        if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
            throw "GitHub CLI (gh) is required to publish the release."
        }
        $repoSlug = Get-GitHubRepoSlug
        try {
            Invoke-Gh auth status | Out-Null
        }
        catch {
            throw "GitHub CLI is not authenticated. Run 'gh auth login' first."
        }
        $releaseExists = Test-GitHubReleaseExists -RepoSlug $repoSlug -TagName $tagName
        if ($releaseExists -and -not $Force) {
            throw "GitHub release $tagName already exists. Use -Force to overwrite."
        }
    }

    # -----------------------------------------------------------------------
    # 4. Snapshot originals for rollback
    # -----------------------------------------------------------------------
    $origPkgJson   = [System.IO.File]::ReadAllText($pkgJsonPath)
    $origCargoToml = [System.IO.File]::ReadAllText($cargoTomlPath)
    $origCargoLock = [System.IO.File]::ReadAllText($cargoLockPath)
    $origTauriConf = [System.IO.File]::ReadAllText($tauriConfPath)
    $origAboutDialog = [System.IO.File]::ReadAllText($aboutDialogPath)
    $origReadme = [System.IO.File]::ReadAllText($readmePath)
    if (Test-Path $pkgLockPath) {
        $origPkgLock = [System.IO.File]::ReadAllText($pkgLockPath)
    }

    # -----------------------------------------------------------------------
    # 5. Dry-run mode
    # -----------------------------------------------------------------------
    if ($DryRun) {
        Write-Host ""
        Write-WarnLine "DRY RUN -- no changes will be made"
        Write-Host ""
        Write-Info "Current version : $currentVersion"
        Write-Info "New version     : $Version"
        Write-Info "Tag             : $tagName"
        Write-Info "Release notes   :"
        ($Notes -split "`n") | ForEach-Object { Write-Host "  $_" }
        Write-Host ""
        Write-Host "Planned actions:" -ForegroundColor Yellow
        Write-Host "   1. Update version in package.json"
        Write-Host "   2. Update version in src-tauri/Cargo.toml"
        Write-Host "   3. Update version in src-tauri/Cargo.lock (root package)"
        Write-Host "   4. Update version in src-tauri/tauri.conf.json"
        Write-Host "   5. Update About dialog fallback version in src/components/AboutDialog.tsx"
        Write-Host "   6. Update README release examples"
        Write-Host "   7. npm install  (refresh package-lock.json)"
        Write-Host "   8. npm run build  (TypeScript + Vite compile check)"
        Write-Host "   9. npx prettier --check --ignore-unknown <release files>"
        Write-Host "  10. npx tsc --noEmit"
        Write-Host "  11. cargo fmt -- --check"
        Write-Host "  12. cargo clippy -- -D warnings"
        Write-Host "  13. cargo test"
        Write-Host "  14. Set TAURI_SIGNING_PRIVATE_KEY / TAURI_SIGNING_PRIVATE_KEY_PASSWORD"
        Write-Host "  15. npm run tauri build  (signed NSIS/MSI bundles + updater signatures)"
        Write-Host "  16. Generate latest.json for windows-x86_64"
        Write-Host "  17. git commit -m `"chore: bump version to $Version`""
        Write-Host "  18. git tag -a $tagName"
        Write-Host "  19. git push + git push --tags"
        Write-Host "  20. gh release create $tagName <bundles + signatures + latest.json>"
        Write-Host "  21. Prune older v*.*.* tags and their GitHub Releases"
        Write-Host ""
        exit 0
    }

    # -----------------------------------------------------------------------
    # Step 1 -- Update version strings
    # -----------------------------------------------------------------------
    Write-Info "Step 1/8 -- Updating version strings to $Version ..."

    # package.json: "version": "x.y.z"
    $pkgJsonUpdated = Update-ManifestVersion -FilePath $pkgJsonPath -NewVersion $Version `
        -Pattern '"version"\s*:\s*"\d+\.\d+\.\d+"' `
        -Template "`"version`": `"$Version`"" `
        -AllowNoChange
    if ($pkgJsonUpdated) { Write-Success "Updated package.json" } else { Write-Info "package.json already at $Version" }

    # src-tauri/Cargo.toml: version = "x.y.z"  (first occurrences only -- avoids dependency entries)
    $cargoTomlUpdated = Update-ManifestVersion -FilePath $cargoTomlPath -NewVersion $Version `
        -Pattern 'version\s*=\s*"\d+\.\d+\.\d+"' `
        -Template "version = `"$Version`"" `
        -AllowNoChange
    if ($cargoTomlUpdated) { Write-Success "Updated src-tauri/Cargo.toml" } else { Write-Info "src-tauri/Cargo.toml already at $Version" }

    # src-tauri/Cargo.lock: [[package]] name = "psforge" -> version = "x.y.z"
    $cargoLockUpdated = Update-ManifestVersion -FilePath $cargoLockPath -NewVersion $Version `
        -Pattern '(?ms)(\[\[package\]\]\s*name\s*=\s*"psforge"\s*version\s*=\s*")\d+\.\d+\.\d+(")' `
        -Template ('${1}' + $Version + '${2}') `
        -AllowNoChange
    if ($cargoLockUpdated) { Write-Success "Updated src-tauri/Cargo.lock" } else { Write-Info "src-tauri/Cargo.lock already at $Version" }

    # src-tauri/tauri.conf.json: "version": "x.y.z"
    $tauriConfUpdated = Update-ManifestVersion -FilePath $tauriConfPath -NewVersion $Version `
        -Pattern '"version"\s*:\s*"\d+\.\d+\.\d+"' `
        -Template "`"version`": `"$Version`"" `
        -AllowNoChange
    if ($tauriConfUpdated) { Write-Success "Updated src-tauri/tauri.conf.json" } else { Write-Info "src-tauri/tauri.conf.json already at $Version" }

    # About dialog fallback version (used only if Tauri version lookup fails).
    $aboutDialogUpdated = Update-ManifestVersion -FilePath $aboutDialogPath -NewVersion $Version `
        -Pattern 'setVersion\("\d+\.\d+\.\d+"\)' `
        -Template "setVersion(`"$Version`")" `
        -AllowNoChange
    if ($aboutDialogUpdated) { Write-Success "Updated About dialog fallback version" } else { Write-Info "About dialog fallback already at $Version" }

    # README release examples.
    $readmeSetupUpdated = Update-ManifestVersion -FilePath $readmePath -NewVersion $Version `
        -Pattern 'PSForge_\d+\.\d+\.\d+_x64-setup\.exe' `
        -Template "PSForge_${Version}_x64-setup.exe" `
        -AllowNoChange
    $readmeMsiUpdated = Update-ManifestVersion -FilePath $readmePath -NewVersion $Version `
        -Pattern 'PSForge_\d+\.\d+\.\d+_x64_en-US\.msi' `
        -Template "PSForge_${Version}_x64_en-US.msi" `
        -AllowNoChange
    $readmeReleaseUpdated = Update-ManifestVersion -FilePath $readmePath -NewVersion $Version `
        -Pattern 'Release version \d+\.\d+\.\d+' `
        -Template "Release version $Version" `
        -AllowNoChange
    $readmeCommandUpdated = Update-ManifestVersion -FilePath $readmePath -NewVersion $Version `
        -Pattern '(?m)^\.\\update-application\.ps1 -Version \d+\.\d+\.\d+$' `
        -Template ".\update-application.ps1 -Version $Version" `
        -AllowNoChange
    $readmeDryRunUpdated = Update-ManifestVersion -FilePath $readmePath -NewVersion $Version `
        -Pattern '(?m)^\.\\update-application\.ps1 -Version \d+\.\d+\.\d+ -DryRun$' `
        -Template ".\update-application.ps1 -Version $Version -DryRun" `
        -AllowNoChange
    if ($readmeSetupUpdated -or $readmeMsiUpdated -or $readmeReleaseUpdated -or $readmeCommandUpdated -or $readmeDryRunUpdated) {
        Write-Success "Updated README release examples"
    } else {
        Write-Info "README release examples already at $Version"
    }

    # Refresh package-lock.json
    Write-Info "Running npm install to refresh package-lock.json ..."
    & npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
    Write-Success "package-lock.json updated"

    # -----------------------------------------------------------------------
    # Show summary and diff, then confirm
    # -----------------------------------------------------------------------
    Write-Host ""
    Write-Host "Release Summary" -ForegroundColor Cyan
    Write-Host "  Current : $currentVersion"
    Write-Host "  New     : $Version"
    Write-Host "  Tag     : $tagName"
    Write-Host "  Notes   : $($Notes -replace "`n", ' | ')"
    Write-Host ""
    Write-Info "Changed files diff:"
    & git diff -- package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json src/components/AboutDialog.tsx README.md package-lock.json
    Write-Host ""

    if ($env:PSFORGE_RELEASE_ASSUME_YES -eq '1') {
        $answer = 'y'
        Write-Info "PSFORGE_RELEASE_ASSUME_YES=1 detected; proceeding without interactive confirmation."
    }
    else {
        $answer = (Read-Host "Proceed with release? (y/N)").Trim()
    }
    if ($answer -notin @('y', 'Y', 'yes', 'YES')) {
        Write-WarnLine "Release cancelled."
        exit 0
    }

    # -----------------------------------------------------------------------
    # Step 2 -- Pre-release build
    # -----------------------------------------------------------------------
    Write-Info "Step 2/8 -- Pre-release build (npm run build) ..."
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed." }
    Write-Success "Frontend build passed"

    # -----------------------------------------------------------------------
    # Step 3 -- Quality gates
    # -----------------------------------------------------------------------
    Write-Info "Step 3/8 -- Quality gates ..."

    Write-Info "  [1/5] Prettier format check (release-managed files) ..."
    $prettierTargets = @(
        'package.json',
        'package-lock.json',
        'README.md',
        'src/components/AboutDialog.tsx',
        'src-tauri/tauri.conf.json'
    )
    & npx prettier --check --ignore-unknown @prettierTargets
    if ($LASTEXITCODE -ne 0) {
        throw "Prettier check failed. Run: npx prettier --write ."
    }

    Write-Info "  [2/5] TypeScript type check ..."
    & npx tsc --noEmit
    if ($LASTEXITCODE -ne 0) { throw "TypeScript type check failed." }

    Push-Location (Join-Path $root 'src-tauri')
    try {
        Write-Info "  [3/5] cargo fmt check ..."
        & cargo fmt -- --check
        if ($LASTEXITCODE -ne 0) { throw "cargo fmt check failed. Run: cargo fmt" }

        Write-Info "  [4/5] cargo clippy ..."
        & cargo clippy -- -D warnings
        if ($LASTEXITCODE -ne 0) { throw "cargo clippy failed." }

        Write-Info "  [5/5] cargo test ..."
        & cargo test
        if ($LASTEXITCODE -ne 0) { throw "cargo test failed." }
    }
    finally {
        Pop-Location
    }

    Write-Success "All quality gates passed"

    # -----------------------------------------------------------------------
    # Step 4 -- Build signed updater artifacts
    # -----------------------------------------------------------------------
    Write-Info "Step 4/8 -- Building signed installer bundles and updater artifacts ..."
    Set-UpdaterSigningEnvironment
    & npm run tauri build
    if ($LASTEXITCODE -ne 0) { throw "npm run tauri build failed." }

    $nsisAsset = Get-LatestBundleAsset -SearchRoot (Join-Path $bundleDir 'nsis') -FilterPattern '*setup.exe'
    $msiAsset = Get-LatestBundleAsset -SearchRoot (Join-Path $bundleDir 'msi') -FilterPattern '*.msi'
    $nsisSignatureText = Get-AssetSignatureText -AssetPath $nsisAsset.FullName
    $null = Get-AssetSignatureText -AssetPath $msiAsset.FullName

    $generatedLatestJsonPath = Join-Path $bundleDir 'latest.json'
    New-StaticUpdaterManifest `
        -FilePath $generatedLatestJsonPath `
        -Version $Version `
        -Notes $Notes `
        -PubDate ([DateTimeOffset]::UtcNow.ToString('o')) `
        -PlatformKey 'windows-x86_64' `
        -AssetUrl "https://github.com/$repoSlug/releases/download/$tagName/$($nsisAsset.Name)" `
        -SignatureText $nsisSignatureText

    $releaseAssetPaths = @(
        $nsisAsset.FullName,
        "$($nsisAsset.FullName).sig",
        $msiAsset.FullName,
        "$($msiAsset.FullName).sig",
        $generatedLatestJsonPath
    )
    Write-Success "Built signed bundles and generated latest.json"

    # -----------------------------------------------------------------------
    # Step 5 -- Handle existing tag and release
    # -----------------------------------------------------------------------
    if ($Force -and $tagExists) {
        Write-Info "Step 5/8 -- Removing existing tag $tagName ..."
        Invoke-Git tag -d $tagName
        try { Invoke-Git push origin --delete $tagName }
        catch { Write-WarnLine "Remote tag delete failed (may not exist remotely): $_" }
        Write-Success "Removed old tag $tagName"
    }
    else {
        Write-Info "Step 5/8 -- No existing tag to remove"
    }
    if ($Force -and $releaseExists) {
        Write-Info "Removing existing GitHub release $tagName ..."
        Invoke-Gh release delete $tagName --repo $repoSlug --yes | Out-Null
        Write-Success "Removed old GitHub release $tagName"
    }

    # -----------------------------------------------------------------------
    # Step 6 -- Commit version bump
    # -----------------------------------------------------------------------
    Write-Info "Step 6/8 -- Committing version bump ..."
    Invoke-Git add package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json src/components/AboutDialog.tsx README.md package-lock.json
    $staged = (& git diff --cached --name-only 2>&1) | Where-Object { $_ -and -not $_.StartsWith("warning:") }
    if ($staged) {
        Invoke-Git commit -m "chore: bump version to $Version"
        Write-Success "Committed version bump"
    }
    else {
        Write-WarnLine "No version file changes to commit; continuing with existing HEAD."
    }

    # -----------------------------------------------------------------------
    # Step 7 -- Tag, push, and publish GitHub release
    # -----------------------------------------------------------------------
    Write-Info "Step 7/8 -- Tagging, pushing, and publishing GitHub release ..."
    Invoke-Git tag -a $tagName -m $Notes
    Invoke-Git push origin HEAD
    Invoke-Git push origin $tagName

    $releaseNotesFile = Join-Path ([System.IO.Path]::GetTempPath()) "psforge-release-notes-$Version.txt"
    [System.IO.File]::WriteAllText(
        $releaseNotesFile,
        ($Notes.TrimEnd("`r", "`n") + "`n"),
        [System.Text.UTF8Encoding]::new($false)
    )
    Invoke-Gh release create $tagName @releaseAssetPaths --repo $repoSlug --title "PSForge $Version" --notes-file $releaseNotesFile | Out-Null
    if (Test-Path $releaseNotesFile) {
        Remove-Item $releaseNotesFile -Force
        $releaseNotesFile = $null
    }
    Write-Success "Pushed $tagName to $repoUrl"
    Write-Success "Published GitHub release $tagName"

    # -----------------------------------------------------------------------
    # Step 8 -- Prune older release tags
    # -----------------------------------------------------------------------
    Write-Info "Step 8/8 -- Pruning older release tags ..."
    $allTags = @(& git tag -l 'v*.*.*' 2>&1)
    $oldTags = $allTags | Where-Object { $_ -and ($_ -ne $tagName) }
    if ($oldTags.Count -gt 0) {
        foreach ($old in $oldTags) {
            Write-Info "  Removing $old ..."
            try { Invoke-Git tag -d $old }
            catch { Write-WarnLine "Local tag delete failed for $old : $_" }
            try { Invoke-Git push origin --delete $old }
            catch { Write-WarnLine "Remote tag delete failed for $old : $_" }
            if (Get-Command gh -ErrorAction SilentlyContinue) {
                try { & gh release delete $old --yes 2>&1 | Out-Null }
                catch { Write-WarnLine "GitHub Release delete failed for $old" }
            }
        }
        Write-Success "Pruned $($oldTags.Count) older tag(s)"
    }
    else {
        Write-Info "No older tags to prune"
    }

    # -----------------------------------------------------------------------
    # Done
    # -----------------------------------------------------------------------
    Write-Host ""
    Write-Success "Release $tagName complete!"
    Write-Info "Monitor CI/CD at: $repoUrl/actions"
    Write-Host ""
}
catch {
    Write-Host ""
    Write-ErrorLine "Release failed: $_"

    # Rollback: restore manifest files from in-memory snapshots.
    Write-Info "Rolling back version files ..."
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    if ($null -ne $origPkgJson)   { try { [System.IO.File]::WriteAllText($pkgJsonPath,   $origPkgJson,   $utf8NoBom) } catch {} }
    if ($null -ne $origCargoToml) { try { [System.IO.File]::WriteAllText($cargoTomlPath, $origCargoToml, $utf8NoBom) } catch {} }
    if ($null -ne $origCargoLock) { try { [System.IO.File]::WriteAllText($cargoLockPath, $origCargoLock, $utf8NoBom) } catch {} }
    if ($null -ne $origTauriConf) { try { [System.IO.File]::WriteAllText($tauriConfPath, $origTauriConf, $utf8NoBom) } catch {} }
    if ($null -ne $origAboutDialog) { try { [System.IO.File]::WriteAllText($aboutDialogPath, $origAboutDialog, $utf8NoBom) } catch {} }
    if ($null -ne $origReadme) { try { [System.IO.File]::WriteAllText($readmePath, $origReadme, $utf8NoBom) } catch {} }
    if ($null -ne $origPkgLock)   { try { [System.IO.File]::WriteAllText($pkgLockPath,   $origPkgLock,   $utf8NoBom) } catch {} }
    if ($null -ne $releaseNotesFile -and (Test-Path $releaseNotesFile)) {
        try { Remove-Item $releaseNotesFile -Force } catch {}
    }

    if ($null -ne $currentVersion) {
        Write-WarnLine "Version files restored to $currentVersion"
    }
    exit 1
}
