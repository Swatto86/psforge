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
$cache = Join-Path ([IO.Path]::GetTempPath()) "psforge-webview2-$($metadata.version)"
New-Item -ItemType Directory -Path $cache -Force | Out-Null
$archive = Join-Path $cache 'runtime.cab'
if (-not (Test-Path -LiteralPath $archive)) {
    Invoke-WebRequest -Uri $metadata.url -OutFile $archive
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $metadata.sha256) {
    throw "WebView2 archive hash mismatch: $archive"
}
$runtime = Join-Path $cache "Microsoft.WebView2.FixedVersionRuntime.$($metadata.version).x64"
if (-not (Test-Path -LiteralPath (Join-Path $runtime 'msedgewebview2.exe'))) {
    & expand.exe '-F:*' $archive $cache > $null
    if ($LASTEXITCODE -ne 0) { throw "WebView2 extraction failed: $LASTEXITCODE" }
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
