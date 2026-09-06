#Requires -Version 7
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [ValidateSet('Enable', 'Restore')] [string] $Mode,
    [Parameter(Mandatory)] [string] $StateFile,
    [int] $Port
)
$ErrorActionPreference = 'Stop'
$key = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments'
$name = 'PSForge.exe'
if ($Mode -eq 'Enable') {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { return }
    if ($Port -lt 1 -or $Port -gt 65535) { throw 'Invalid debugging port.' }
    $existing = Get-ItemProperty -LiteralPath $key -Name $name -ErrorAction SilentlyContinue
    @{ exists = $null -ne $existing; value = if ($existing) { $existing.$name } else { $null } } |
        ConvertTo-Json | Set-Content -LiteralPath $StateFile
    if (-not (Test-Path -LiteralPath $key)) { New-Item -Path $key -Force | Out-Null }
    New-ItemProperty -LiteralPath $key -Name $name -Value "--remote-debugging-port=$Port" -PropertyType String -Force | Out-Null
} elseif (Test-Path -LiteralPath $StateFile) {
    $saved = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
    if ($saved.exists) {
        New-ItemProperty -LiteralPath $key -Name $name -Value $saved.value -PropertyType String -Force | Out-Null
    } else {
        Remove-ItemProperty -LiteralPath $key -Name $name
    }
    Remove-Item -LiteralPath $StateFile
}
