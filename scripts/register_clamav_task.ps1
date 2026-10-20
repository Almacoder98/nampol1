# Run only after the user explicitly approves persistent task registration.
# Requires the Windows ScheduledTasks module; never changes execution policy.
[CmdletBinding(SupportsShouldProcess)]
param()
$ErrorActionPreference = 'Stop'
$taskName = 'NamPol-ClamAV'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$installDirectory = Join-Path $env:LOCALAPPDATA 'ClamAV'
$runnerSource = Join-Path $PSScriptRoot 'run_clamav.ps1'
$runnerTarget = Join-Path $installDirectory 'run_clamav.ps1'
$powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    throw 'NamPol-ClamAV already exists. Inspect it rather than overwrite it.'
}
if (!(Test-Path -LiteralPath $runnerSource -PathType Leaf) -or
    !(Test-Path -LiteralPath (Join-Path $installDirectory 'clamd.conf') -PathType Leaf)) {
    throw 'The reviewed runner or ClamAV configuration is missing.'
}
$action = New-ScheduledTaskAction -Execute $powershellExe -Argument (
    "-NoProfile -NonInteractive -WindowStyle Hidden -File `"$runnerTarget`""
) -WorkingDirectory 'C:\Program Files\ClamAV'
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew
if ($PSCmdlet.ShouldProcess("$taskName for $identity", 'Copy reviewed runner to LocalAppData and register logon task')) {
    Copy-Item -LiteralPath $runnerSource -Destination $runnerTarget
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings `
        -Description 'Local ClamAV for NamPol; explicit config, loopback TCP, logged exits, bounded restart.' | Out-Null
    Write-Output 'NamPol-ClamAV registered. Start it only after resolving any existing diagnostic clamd instance.'
}
