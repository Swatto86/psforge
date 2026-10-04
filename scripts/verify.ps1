#Requires -Version 7
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Push-Location (Split-Path $PSScriptRoot)
try {
    # File-size guideline (the agent-standards engineering skill): a code file over 400 lines
    # needs a reason on record or a split; files already over it are listed in
    # scripts/file-size-baseline.txt and may not grow.
    $sizeCheck = Join-Path $HOME '.agents/scripts/check-file-size.ps1'
    if (Test-Path -LiteralPath $sizeCheck) {
        pwsh -NoProfile -File $sizeCheck -Root (Get-Location).Path
        if ($LASTEXITCODE -ne 0) { throw 'File size check failed.' }
    } else {
        Write-Host 'skip - file size check: ~/.agents/scripts/check-file-size.ps1 not found'
    }
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
