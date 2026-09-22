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
