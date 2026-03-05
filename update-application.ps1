<#
.SYNOPSIS
    Automated release script for PSForge.

.DESCRIPTION
    Validates the version increment, updates all 3 manifest version fields
    (package.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json),
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
    $output = & git @args 2>&1
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

# Updates the version string in a manifest file.
# $Pattern must be a .NET regex with exactly 2 capture groups: prefix and suffix.
# The replacement preserves the prefix and suffix around the new version number.
function Update-ManifestVersion {
    param(
        [string]$FilePath,
        [string]$NewVersion,
        [string]$Pattern,
        [string]$Template  # e.g. '"version": "NEWVER"' -- literal replacement without groups
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
        throw "Version unchanged after replacement in: $FilePath"
    }

    # Normalise to exactly one trailing newline.
    $updated = $updated.TrimEnd("`r", "`n") + "`n"
    if ($hasCrlf) {
        $updated = $updated -replace '(?<!\r)\n', "`r`n"
    }

    [System.IO.File]::WriteAllText($FilePath, $updated, $utf8NoBom)
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
$cargoTomlPath = Join-Path $root 'src-tauri' 'Cargo.toml'
$tauriConfPath = Join-Path $root 'src-tauri' 'tauri.conf.json'
$pkgLockPath   = Join-Path $root 'package-lock.json'

# Snapshot placeholders for rollback (populated in try block before any writes)
$origPkgJson   = $null
$origCargoToml = $null
$origTauriConf = $null
$origPkgLock   = $null
$currentVersion = $null

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
        if ($cmp -le 0) {
            throw "New version $Version must be greater than $currentVersion. Use -Force to override."
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

    # -----------------------------------------------------------------------
    # 4. Snapshot originals for rollback
    # -----------------------------------------------------------------------
    $origPkgJson   = [System.IO.File]::ReadAllText($pkgJsonPath)
    $origCargoToml = [System.IO.File]::ReadAllText($cargoTomlPath)
    $origTauriConf = [System.IO.File]::ReadAllText($tauriConfPath)
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
        Write-Host "   3. Update version in src-tauri/tauri.conf.json"
        Write-Host "   4. npm install  (refresh package-lock.json)"
        Write-Host "   5. npm run build  (TypeScript + Vite compile check)"
        Write-Host "   6. npx prettier --check ."
        Write-Host "   7. npx tsc --noEmit"
        Write-Host "   8. cargo fmt -- --check"
        Write-Host "   9. cargo clippy -- -D warnings"
        Write-Host "  10. cargo test"
        Write-Host "  11. npx tauri build"
        Write-Host "  12. git commit -m `"chore: bump version to $Version`""
        Write-Host "  13. git tag -a $tagName"
        Write-Host "  14. git push + git push --tags"
        Write-Host "  15. Prune older v*.*.* tags and their GitHub Releases"
        Write-Host ""
        exit 0
    }

    # -----------------------------------------------------------------------
    # Step 1 -- Update version strings
    # -----------------------------------------------------------------------
    Write-Info "Step 1/7 -- Updating version strings to $Version ..."

    # package.json: "version": "x.y.z"
    Update-ManifestVersion -FilePath $pkgJsonPath -NewVersion $Version `
        -Pattern '"version"\s*:\s*"\d+\.\d+\.\d+"' `
        -Template "`"version`": `"$Version`""
    Write-Success "Updated package.json"

    # src-tauri/Cargo.toml: version = "x.y.z"  (first occurrences only -- avoids dependency entries)
    Update-ManifestVersion -FilePath $cargoTomlPath -NewVersion $Version `
        -Pattern 'version\s*=\s*"\d+\.\d+\.\d+"' `
        -Template "version = `"$Version`""
    Write-Success "Updated src-tauri/Cargo.toml"

    # src-tauri/tauri.conf.json: "version": "x.y.z"
    Update-ManifestVersion -FilePath $tauriConfPath -NewVersion $Version `
        -Pattern '"version"\s*:\s*"\d+\.\d+\.\d+"' `
        -Template "`"version`": `"$Version`""
    Write-Success "Updated src-tauri/tauri.conf.json"

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
    & git diff -- package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json
    Write-Host ""

    $answer = Read-Host "Proceed with release? (y/N)"
    if ($answer -notin @('y', 'Y', 'yes', 'YES')) {
        Write-WarnLine "Release cancelled."
        exit 0
    }

    # -----------------------------------------------------------------------
    # Step 2 -- Pre-release build
    # -----------------------------------------------------------------------
    Write-Info "Step 2/7 -- Pre-release build (npm run build) ..."
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed." }
    Write-Success "Frontend build passed"

    # -----------------------------------------------------------------------
    # Step 3 -- Quality gates
    # -----------------------------------------------------------------------
    Write-Info "Step 3/7 -- Quality gates ..."

    Write-Info "  [1/5] Prettier format check ..."
    & npx prettier --check .
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
    # Step 4 -- Handle existing tag
    # -----------------------------------------------------------------------
    if ($Force -and $tagExists) {
        Write-Info "Step 4/7 -- Removing existing tag $tagName ..."
        Invoke-Git tag -d $tagName
        try { Invoke-Git push origin --delete $tagName }
        catch { Write-WarnLine "Remote tag delete failed (may not exist remotely): $_" }
        Write-Success "Removed old tag $tagName"
    }
    else {
        Write-Info "Step 4/7 -- No existing tag to remove"
    }

    # -----------------------------------------------------------------------
    # Step 5 -- Commit version bump
    # -----------------------------------------------------------------------
    Write-Info "Step 5/7 -- Committing version bump ..."
    Invoke-Git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json package-lock.json
    Invoke-Git commit -m "chore: bump version to $Version"
    Write-Success "Committed version bump"

    # -----------------------------------------------------------------------
    # Step 6 -- Tag and push
    # -----------------------------------------------------------------------
    Write-Info "Step 6/7 -- Tagging v$Version and pushing ..."
    Invoke-Git tag -a $tagName -m $Notes
    Invoke-Git push origin HEAD
    Invoke-Git push origin $tagName
    $repoUrl = Get-RemoteHttpsUrl
    Write-Success "Pushed $tagName to $repoUrl"

    # -----------------------------------------------------------------------
    # Step 7 -- Prune older release tags
    # -----------------------------------------------------------------------
    Write-Info "Step 7/7 -- Pruning older release tags ..."
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
    if ($null -ne $origTauriConf) { try { [System.IO.File]::WriteAllText($tauriConfPath, $origTauriConf, $utf8NoBom) } catch {} }
    if ($null -ne $origPkgLock)   { try { [System.IO.File]::WriteAllText($pkgLockPath,   $origPkgLock,   $utf8NoBom) } catch {} }

    if ($null -ne $currentVersion) {
        Write-WarnLine "Version files restored to $currentVersion"
    }
    exit 1
}
