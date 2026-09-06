#Requires -Version 7
$ErrorActionPreference = 'Stop'
$apps = @(Get-Process | Where-Object { $_.ProcessName -like '*psforge*' -or $_.ProcessName -eq 'msedgewebview2' })
$apps | Select-Object Id, ProcessName, Path, MainWindowTitle | Format-List
Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -in $apps.Id } | ForEach-Object {
    $debugPort = [regex]::Match($_.CommandLine, '--remote-debugging-port=\d+').Value
    [pscustomobject]@{ Id = $_.ProcessId; Name = $_.Name; DebugPort = $debugPort }
} | Format-Table
Get-NetTCPConnection -State Listen | Where-Object { $_.OwningProcess -in $apps.Id } |
    Select-Object LocalAddress, LocalPort, OwningProcess | Format-Table
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
foreach ($app in $apps) {
    $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $app.Id)
    $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
    foreach ($window in $windows) {
        $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) |
            Select-Object -First 30 | ForEach-Object { $_.Current.Name }
    }
}
