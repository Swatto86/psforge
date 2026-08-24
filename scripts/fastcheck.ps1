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
    if ($Package) {
        cargo check --locked -p $Package --all-targets
    } else {
        Push-Location $root
        try {
            npx --yes tsc --noEmit
        } finally {
            Pop-Location
        }
        cargo clippy --locked --all-targets -- -D warnings
    }
} finally {
    Pop-Location
}
