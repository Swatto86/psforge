#Requires -Version 7
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Push-Location (Split-Path $PSScriptRoot)
try {
    npm test
    if ($LASTEXITCODE -ne 0) { throw 'Frontend tests failed.' }
    Push-Location 'src-tauri'
    try {
        cargo fmt --all -- --check
        if ($LASTEXITCODE -ne 0) { throw 'Rust formatting failed.' }
        cargo clippy --locked --all-targets -- -D warnings
        if ($LASTEXITCODE -ne 0) { throw 'Rust lint failed.' }
        cargo test --locked --all-targets
        if ($LASTEXITCODE -ne 0) { throw 'Rust tests failed.' }
    } finally { Pop-Location }
    npx tauri build --debug --no-bundle
    if ($LASTEXITCODE -ne 0) { throw 'Debug build failed.' }
    npm run test:e2e
    if ($LASTEXITCODE -ne 0) { throw 'Desktop tests failed.' }
} finally { Pop-Location }
