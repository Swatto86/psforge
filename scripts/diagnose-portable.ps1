#Requires -Version 7
$ErrorActionPreference = 'Stop'
$apps = @(Get-Process | Where-Object { $_.ProcessName -like '*psforge*' -or $_.ProcessName -eq 'msedgewebview2' })
$apps | Select-Object Id, ProcessName, Path, MainWindowTitle | Format-List
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
