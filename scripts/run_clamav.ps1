# Task runner: no installation, credentials, config edits, or protocol bypasses.
[CmdletBinding()]
param(
    [string]$ConfigPath = (Join-Path $env:LOCALAPPDATA 'ClamAV\clamd.conf'),
    [string]$LogDirectory = (Join-Path $env:LOCALAPPDATA 'ClamAV\logs')
)
$ErrorActionPreference = 'Stop'
$executable = 'C:\Program Files\ClamAV\clamd.exe'
$clamProcess = $null
try {
    if (!(Test-Path -LiteralPath $executable -PathType Leaf) -or
        !(Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
        throw 'ClamAV executable or configuration is missing.'
    }
    New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
    $runnerLog = Join-Path $LogDirectory 'runner.log'
    # Refuse a duplicate even while an existing daemon is still loading its DB.
    if (Get-Process -Name clamd -ErrorAction SilentlyContinue) {
        throw 'A clamd process already exists; refusing to start a duplicate.'
    }
    for ($attempt = 0; $attempt -le 3; $attempt++) {
        Add-Content -LiteralPath $runnerLog -Value "$(Get-Date -Format o) Starting clamd with explicit config; attempt=$attempt."
        $clamProcess = Start-Process -FilePath $executable -ArgumentList @(
        "--config-file=`"$ConfigPath`"", '--foreground',
        "--log=`"$(Join-Path $LogDirectory 'clamd.log')`""
    ) -WorkingDirectory (Split-Path -Parent $executable) -WindowStyle Hidden -PassThru
        # Keep the task active for the lifetime of the actual daemon.
        $clamProcess.WaitForExit()
        Add-Content -LiteralPath $runnerLog -Value "$(Get-Date -Format o) clamd exited; code=$($clamProcess.ExitCode)."
        if ($attempt -lt 3) {
            Add-Content -LiteralPath $runnerLog -Value "$(Get-Date -Format o) Restarting in 60 seconds; retry=$($attempt + 1)/3."
            Start-Sleep -Seconds 60
            if (Get-Process -Name clamd -ErrorAction SilentlyContinue) {
                throw 'Another clamd process appeared; refusing duplicate restart.'
            }
        }
    }
    Add-Content -LiteralPath $runnerLog -Value "$(Get-Date -Format o) All three restart attempts exhausted."
    exit 1
} catch {
    if ($runnerLog) {
        Add-Content -LiteralPath $runnerLog -Value "$(Get-Date -Format o) Runner error: $($_.Exception.Message)"
    }
    Write-Error $_ -ErrorAction Continue
    exit 1
}
