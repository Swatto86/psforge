# PSForge runner coverage — read-only stress script for F5 / psrun paths.
# Valid PowerShell 7+ constructs. No files written; no durable state changed.
#Requires -Version 7

$ErrorActionPreference = "Stop"
$script:sections = 0

function Section([string]$name) {
    $script:sections++
    Write-Host ("=`n{0,-30} [{1}]" -f $name, $script:sections) -ForegroundColor Cyan
}

Section "Basic cmdlets + pipeline"
$bigProcesses = Get-Process |
    Where-Object { $_.WorkingSet64 -gt 100MB } |
    Sort-Object WorkingSet64 -Descending |
    Select-Object -First 3 Name, @{n = 'MB'; e = { [math]::Round($_.WorkingSet64 / 1MB, 1) } }
$bigProcesses | Format-Table -AutoSize | Out-String | Write-Host

function Get-WordCount {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, Position = 0)]
        [Alias('Text', 'InputObject')]
        [ValidateNotNullOrEmpty()]
        [string]$Value,
        [switch]$VerboseCount
    )
    $words = ($Value -split '\s+') | Where-Object { $_ } | Measure-Object
    if ($VerboseCount) { Write-Verbose "Counted $($words.Count) tokens." }
    return $words.Count
}
$wc = Get-WordCount -Value "This sentence has seven words in it"
Write-Host "Get-WordCount: ${wc} words (expected 7)"
if ($wc -ne 7) { throw "Get-WordCount expected 7, got $wc" }

Section "Control flow"
$os = $IsWindows
switch -Regex ([string]$os) {
    'True' { Write-Host "Running on: Windows"; break }
    'False' { Write-Host "Running on: non-Windows"; break }
    default { Write-Host "Running on: unknown" }
}
$score = 85
switch ($score) {
    { $_ -ge 90 } { Write-Host 'Grade: A'; break }
    { $_ -ge 80 } { Write-Host 'Grade: B'; break }
    default { Write-Host 'Grade: other' }
}

Section "Error handling"
try {
    throw [System.ArgumentNullException]::new('ParameterName', 'Deliberate failure to test catch block')
} catch [ArgumentNullException] {
    Write-Host ("Caught expected exception: {0}" -f $_.Exception.Message) -ForegroundColor Yellow
} finally {
    Write-Host "finally block executed" -ForegroundColor DarkGray
}

Section "Classes"
class Pet {
    [string]$Name
    [int]$Age
    Pet([string]$n, [int]$a) {
        $this.Name = $n
        $this.Age = $a
    }
    [string] Describe() { return "$($this.Name) is $($this.Age) years old." }
}
class Dog : Pet {
    Dog([string]$n, [int]$a) : base($n, $a) {}
    [string] Speak() { return "Woof - $($this.Describe())" }
}
$rex = [Dog]::new('Rex', 7)
Write-Host $rex.Speak()

Section "Variable scopes"
$script:ScriptVar = "script scope"
$global:GlobalVar = "global scope"
function Test-Scoping {
    $local = "local to function"
    $script:FnWrote = "function wrote me"
    return $local
}
$fromFn = Test-Scoping
Write-Host "scope check: function sees '$fromFn', after call script:Wrote='$script:FnWrote'"

Section "Collections"
$people = [ordered]@{
    Alice = 'Admin'
    Bob   = 'Operator'
}
$list = [System.Collections.ArrayList]::new()
foreach ($p in $people.GetEnumerator()) {
    [void]$list.Add("$($p.Key)=$($p.Value)")
}
$list | ForEach-Object { Write-Host "  $_" }

Section "Serialization"
$obj = [pscustomobject]@{
    Name   = 'PSForge'
    Tools  = @('editor', 'runner', 'diag')
    Active = $true
}
$json = $obj | ConvertTo-Json -Depth 3
Write-Host "JSON out: $json"
$back = $json | ConvertFrom-Json
Write-Host ("Round-trip: {0} / {1} / {2}" -f $back.Name, $back.Tools[0], $back.Active)
$xml = [xml]'<report><tool>PSForge</tool><status>OK</status></report>'
Write-Host ("XML read: {0} / {1}" -f $xml.report.tool, $xml.report.status)

Section "Strings + formatting"
$s = "Hello, {0}! Value={1:N2}" -f 'World', 3.14159
Write-Host $s
Write-Host ("padme".PadRight(12))
Write-Host ("-f operator: {0,8:N0} bytes" -f 1536)

Section "Advanced pipeline"
1..10 | ForEach-Object {
    "Item-$_" | ForEach-Object {
        [pscustomobject]@{
            Id     = $_
            IsEven = ((($_.Split('-')[-1] -as [int]) % 2) -eq 0)
        }
    }
} | Where-Object IsEven | Select-Object -First 3 | Format-Table -AutoSize | Out-String | Write-Host

Section "Comparison + ternary"
$x = 42
$result = ($x -eq 42) ? 'match' : 'no match'
Write-Host "Ternary: $result"
Write-Host "Pattern: 'abc123' -match '\d{2}' = $('abc123' -match '\d{2}')"

Section "Aliases + subexpressions"
$ps = Get-Process -Name pwsh -ErrorAction SilentlyContinue
$pwshCount = @($ps).Count
Write-Host "pwsh processes running: $pwshCount"

Section "Output streams"
$toPipeline = Get-Service -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'spooler' -or $_.Name -like 'spatial*' } |
    Select-Object -First 2
if ($toPipeline) {
    $toPipeline | Format-Table -AutoSize | Out-String | Write-Host
} else {
    Write-Host "(no matching services — pipeline output still emitted correctly)"
}

Section "SUMMARY"
Write-Host "PSFORGE_COVERAGE_OK sections=$($script:sections)"
