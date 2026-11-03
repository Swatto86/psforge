#Requires -Version 7
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $AppBinary,
    [Parameter(Mandatory)] [string] $OutputFile,
    [switch] $Fast
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'The portable Windows build must run on Windows.' }
$metadata = Get-Content (Join-Path $PSScriptRoot 'webview2-runtime.json') -Raw | ConvertFrom-Json
$binary = (Resolve-Path -LiteralPath $AppBinary).Path
$output = if ([IO.Path]::IsPathRooted($OutputFile)) { $OutputFile } else { Join-Path $PWD.Path $OutputFile }
$outputParent = Split-Path -Parent $output
if ($outputParent) { New-Item -ItemType Directory -Path $outputParent -Force | Out-Null }
$cache = Join-Path ([IO.Path]::GetTempPath()) "psforge-webview2-$($metadata.version)"
New-Item -ItemType Directory -Path $cache -Force | Out-Null
$archive = Join-Path $cache 'runtime.cab'
if ((Test-Path -LiteralPath $archive) -and
    ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $metadata.sha256)) {
    # A partial or corrupt cache entry must not poison every later build.
    Remove-Item -LiteralPath $archive -Force
}
if (-not (Test-Path -LiteralPath $archive)) {
    $download = "$archive.download"
    Remove-Item -LiteralPath $download -Force -ErrorAction SilentlyContinue
    try {
        Invoke-WebRequest -Uri $metadata.url -OutFile $download
        if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash -ne $metadata.sha256) {
            throw 'Downloaded WebView2 archive hash mismatch.'
        }
        Move-Item -LiteralPath $download -Destination $archive -Force
    } finally {
        Remove-Item -LiteralPath $download -Force -ErrorAction SilentlyContinue
    }
}
$runtime = Join-Path $cache "Microsoft.WebView2.FixedVersionRuntime.$($metadata.version).x64"
$completionMarker = Join-Path $runtime '.psforge-extraction-complete'
if (-not (Test-Path -LiteralPath $completionMarker)) {
    $staging = Join-Path $cache 'runtime.extracting'
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    try {
        & expand.exe '-F:*' $archive $staging > $null
        if ($LASTEXITCODE -ne 0) { throw "WebView2 extraction failed: $LASTEXITCODE" }
        $stagedRuntime = Join-Path $staging (Split-Path $runtime -Leaf)
        if (-not (Test-Path -LiteralPath (Join-Path $stagedRuntime 'msedgewebview2.exe'))) {
            throw 'WebView2 extraction is incomplete.'
        }
        Remove-Item -LiteralPath $runtime -Recurse -Force -ErrorAction SilentlyContinue
        New-Item -ItemType File -Path (Join-Path $stagedRuntime '.psforge-extraction-complete') -Force | Out-Null
        Move-Item -LiteralPath $stagedRuntime -Destination $runtime
    } finally {
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
}
$runtimeExe = Join-Path $runtime 'msedgewebview2.exe'
$signature = Get-AuthenticodeSignature -FilePath $runtimeExe
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft Corporation') {
    throw 'WebView2 runtime does not have a valid Microsoft signature.'
}
$compiler = Get-Command makensis.exe -ErrorAction SilentlyContinue
$compilerPath = if ($compiler) { $compiler.Source } else { Join-Path ${env:ProgramFiles(x86)} 'NSIS\makensis.exe' }
if (-not (Test-Path -LiteralPath $compilerPath)) { throw 'Install NSIS before building the portable executable.' }
$arguments = @('/V2', "/DAPP_BINARY=$binary", "/DRUNTIME_DIR=$runtime", "/DOUTPUT_FILE=$output")
if ($Fast) { $arguments += '/DFAST_BUILD' }
& $compilerPath @arguments (Join-Path $PSScriptRoot 'portable.nsi')
if ($LASTEXITCODE -ne 0) { throw "Portable executable build failed: $LASTEXITCODE" }
if (-not (Test-Path -LiteralPath $output)) { throw "Portable executable is missing: $output" }
Write-Output $output
