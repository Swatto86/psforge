#Requires -Version 7
param(
    [Parameter(Position = 0)]
    [AllowEmptyString()]
    [string]$Empty,
    [Parameter(Position = 1)]
    [AllowEmptyString()]
    [string]$Whitespace,
    [string]$Text,
    [string]$OtherText,
    [switch]$Enabled,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
if ($null -eq $Empty -or $Empty.Length -ne 0) { throw 'Empty positional argument was not preserved' }
if ($Whitespace -ne '   ') { throw 'Whitespace positional argument was not preserved' }
if ($Text -cne 'true') { throw "Named string 'true' was coerced: $Text" }
if ($OtherText -cne '$false') { throw "Named string '$false' was coerced: $OtherText" }
if ($Enabled.IsPresent) { throw 'Explicit false switch became true' }
if (-not $Force.IsPresent) { throw 'Bare switch was not preserved' }
[Console]::Out.WriteLine('PSFORGE_ARGUMENT_BINDING_OK')
