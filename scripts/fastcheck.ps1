#Requires -Version 7
[CmdletBinding()]
param(
    [string] $Package
)
$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot
$crate = Join-Path $root 'src-tauri'
Push-Location $crate
try {
    cargo fmt --all -- --check
    if ($LASTEXITCODE -ne 0) { throw 'Rust formatting failed.' }
    if ($Package) {
        cargo check --locked -p $Package --all-targets
        if ($LASTEXITCODE -ne 0) { throw 'Rust check failed.' }
    } else {
        # File-size guideline (the agent-standards engineering skill): a code file over 400 lines
        # needs a reason on record or a split; files already over it are listed in
        # scripts/file-size-baseline.txt and may not grow.
        $sizeCheck = Join-Path $HOME '.agents/scripts/check-file-size.ps1'
        if (Test-Path -LiteralPath $sizeCheck) {
            pwsh -NoProfile -File $sizeCheck -Root $root
            if ($LASTEXITCODE -ne 0) { throw 'File size check failed.' }
        } else {
            Write-Host 'skip - file size check: ~/.agents/scripts/check-file-size.ps1 not found'
        }
        Push-Location $root
        try {
            npx --yes tsc --noEmit
            if ($LASTEXITCODE -ne 0) { throw 'TypeScript check failed.' }
        } finally {
            Pop-Location
        }
        cargo clippy --locked --all-targets -- -D warnings
        if ($LASTEXITCODE -ne 0) { throw 'Rust lint failed.' }
    }
} finally {
    Pop-Location
}
