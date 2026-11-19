# Windows PowerShell 5.1+. Credentials never appear in arguments, output or logs.
[CmdletBinding()]
param(
    [switch]$NoPrompt,
    [switch]$CheckOnly,
    [switch]$SaveCredentials,
    [switch]$Configure,
    # Internal fresh-process verification; never receives credential values.
    [switch]$VerifySavedConfiguration,
    [string]$ConfigurationPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:ProjectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$script:ConfigDirectory = Join-Path $env:LOCALAPPDATA 'NamPol\launcher'
$script:ConfigFile = Join-Path $script:ConfigDirectory 'credentials.clixml'

function ConvertFrom-PrivateString([Security.SecureString]$Value) {
    return [Net.NetworkCredential]::new('', $Value).Password
}

function Get-ExistingValue([string]$Name) {
    foreach ($scope in @('Process', 'User', 'Machine')) {
        $value = [Environment]::GetEnvironmentVariable($Name, $scope)
        if (![string]::IsNullOrWhiteSpace($value)) { return $value }
    }
    return ''
}

function Read-PrivateValue([string]$Prompt, [switch]$NonInteractive, [switch]$SupabaseInput) {
    if ($NonInteractive) { throw "Missing required configuration: $Prompt. Run without -NoPrompt to enter it privately." }
    # Let the PowerShell host manage editing and masking in integrated terminals.
    # Do not read raw console keys: those are not reliable across terminal hosts.
    if ($SupabaseInput) { $Prompt += ' (type the value, then Enter; input masked)' }
    $secure = Read-Host $Prompt -AsSecureString
    try {
        $value = ConvertFrom-PrivateString $secure
        if ($SupabaseInput) { return ($value -replace '\s', '') }
        return $value
    } finally {
        $value = $null
        $secure.Dispose()
    }
}

function Assert-ExternalPath([string]$Path) {
    if (![IO.Path]::IsPathRooted($Path)) { throw 'Firebase credentials must use an absolute file path outside the repository.' }
    $full = [IO.Path]::GetFullPath($Path)
    if ($full.Equals($script:ProjectRoot, [StringComparison]::OrdinalIgnoreCase) -or
        $full.StartsWith($script:ProjectRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Credential/configuration files must stay outside the repository.'
    }
}

function Assert-Configuration($Config) {
    Assert-ExternalPath $Config.FirebasePath
    try {
        $account = Get-Content -LiteralPath $Config.FirebasePath -Raw | ConvertFrom-Json
        if ($account.type -ne 'service_account' -or $account.project_id -ne 'nampol-recruitment' -or
            !$account.private_key -or !$account.client_email) { throw 'invalid' }
    } catch { throw 'Firebase service-account file is unreadable or does not match nampol-recruitment. Its contents were not printed.' }
    $uri = $null
    if (![Uri]::TryCreate($Config.SupabaseUrl, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -ne 'https' -or !$uri.Host -or $uri.UserInfo -or $uri.Query -or
        $uri.Fragment -or $uri.AbsolutePath -ne '/') {
        throw 'SUPABASE_URL must be an HTTPS project origin without credentials, path or query.'
    }
    if (!$Config.SupabaseKey.StartsWith('sb_secret_')) { throw 'SUPABASE_SECRET_KEY must be a server sb_secret_ key.' }
}

function Get-NamPolConfiguration([switch]$NonInteractive, [switch]$Reconfigure, [switch]$SavedOnly) {
    $saved = $null
    if (Test-Path -LiteralPath $script:ConfigFile) {
        try {
            $saved = Import-Clixml -LiteralPath $script:ConfigFile
            if ($saved.SupabaseKey -isnot [Security.SecureString] -or
                ($saved.SupabaseUrl -isnot [Security.SecureString] -and $saved.SupabaseUrl -isnot [string])) { throw 'invalid' }
        } catch { throw 'Saved configuration cannot be read for this Windows account. Restore it or move it aside and run again to enter credentials privately.' }
    }
    if ($SavedOnly -and !$saved) { throw 'Saved configuration is missing.' }
    $firebase = if ($saved) { $saved.FirebasePath } else { '' }
    $url = ''
    $key = ''
    if ($saved) {
        $url = if ($saved.SupabaseUrl -is [Security.SecureString]) {
            ConvertFrom-PrivateString $saved.SupabaseUrl
        } else { $saved.SupabaseUrl } # Backward-compatible; migrate after verification.
        $key = ConvertFrom-PrivateString $saved.SupabaseKey
    }
    if (!$SavedOnly) {
        if (!$firebase) { $firebase = Get-ExistingValue 'GOOGLE_APPLICATION_CREDENTIALS' }
        # Never mix stale environment values into an already saved project/key pair.
        if (!$saved -and !$Reconfigure) {
            $url = Get-ExistingValue 'SUPABASE_URL'
            $key = Get-ExistingValue 'SUPABASE_SECRET_KEY'
        }
    }
    if (!$firebase -and !$SavedOnly) {
        $secretDirectory = Join-Path $env:LOCALAPPDATA 'NamPol\secrets'
        $candidates = @(Get-ChildItem -LiteralPath $secretDirectory -Filter '*-firebase-adminsdk-*.json' -File -ErrorAction SilentlyContinue)
        if ($candidates.Count -eq 1) { $firebase = $candidates[0].FullName }
    }
    # Explicit configuration replaces stale URL/key values without deleting files
    # or changing the caller's environment. The Firebase path is retained.
    if ($Reconfigure) { $url = ''; $key = '' }
    $prompted = $false
    if (!$firebase) { $firebase = Read-PrivateValue 'Absolute Firebase service-account JSON path outside Git' -NonInteractive:$NonInteractive; $prompted = $true }
    if (!$url) { $url = Read-PrivateValue 'SUPABASE_URL (HTTPS project origin)' -NonInteractive:$NonInteractive -SupabaseInput; $prompted = $true }
    if (!$key) { $key = Read-PrivateValue 'SUPABASE_SECRET_KEY (server sb_secret_ key)' -NonInteractive:$NonInteractive -SupabaseInput; $prompted = $true }
    $needsSave = !$saved -or $Reconfigure -or $prompted -or ($saved.SupabaseUrl -isnot [Security.SecureString])
    $config = [pscustomobject]@{ FirebasePath = $firebase; SupabaseUrl = $url; SupabaseKey = $key; Prompted = $prompted; NeedsSave = $needsSave }
    Assert-Configuration $config
    return $config
}

function Save-NamPolConfiguration($Config) {
    Assert-ExternalPath $script:ConfigDirectory
    # Reject links before applying a restrictive ACL to our dedicated directory.
    foreach ($path in @((Split-Path -Parent $script:ConfigDirectory), $script:ConfigDirectory, $script:ConfigFile)) {
        if ((Test-Path -LiteralPath $path) -and
            ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Refusing linked local configuration paths.'
        }
    }
    $null = New-Item -ItemType Directory -Path $script:ConfigDirectory -Force
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    foreach ($identity in @($sid, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', $inherit, 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    # Only Access (the DACL) was modified on this fresh descriptor. Persist those
    # changes directly: Set-Acl copies all sections and can request audit/SACL
    # privileges when this directory already has protected access rules.
    # Leave owner, group and audit rules untouched; no elevated token is needed.
    $directory = [IO.DirectoryInfo]::new($script:ConfigDirectory)
    if ($PSVersionTable.PSEdition -eq 'Desktop') {
        $directory.SetAccessControl($acl)
    } else {
        [IO.FileSystemAclExtensions]::SetAccessControl($directory, $acl)
    }
    $temporary = Join-Path $script:ConfigDirectory ([Guid]::NewGuid().ToString('N') + '.clixml')
    $secure = ConvertTo-SecureString $Config.SupabaseKey -AsPlainText -Force
    $secureUrl = ConvertTo-SecureString $Config.SupabaseUrl -AsPlainText -Force
    try {
        # On Windows Export-Clixml encrypts SecureString with current-user DPAPI.
        [pscustomobject]@{ FirebasePath = $Config.FirebasePath; SupabaseUrl = $secureUrl; SupabaseKey = $secure } |
            Export-Clixml -LiteralPath $temporary
        # Keep the old file until another PowerShell process can decrypt and use
        # this candidate for the real DNS/HTTPS/private-bucket preflight.
        Assert-SavedConfiguration $temporary
        Move-Item -LiteralPath $temporary -Destination $script:ConfigFile -Force
    } finally {
        $secure.Dispose()
        $secureUrl.Dispose()
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
    Write-Host 'Verified configuration saved outside Git; both Supabase values are encrypted for this Windows account.'
}

function Assert-SavedConfiguration([string]$Path) {
    $process = $null
    try {
        $powerShell = (Get-Process -Id $PID).Path
        $launcher = Join-Path $PSScriptRoot 'start_nampol.ps1'
        $arguments = '-NoProfile -File "' + $launcher + '" -VerifySavedConfiguration -ConfigurationPath "' + $Path + '"'
        $process = Start-NamPolProcess $powerShell $arguments $null -CaptureOutput
        if (!$process.WaitForExit(55000)) { throw 'Fresh-process credential verification timed out. Existing saved settings were kept.' }
        $output = $process.StandardOutput.ReadToEnd().Trim()
        if ($process.ExitCode -ne 0 -or !$output.EndsWith('saved_configuration_verified')) {
            throw 'A fresh PowerShell process could not reload and verify the candidate settings. Existing saved settings were kept; no credential values were printed.'
        }
    } finally {
        if ($null -ne $process) {
            try { if (!$process.HasExited) { $process.Kill(); $null = $process.WaitForExit(5000) } }
            finally { $process.Dispose() }
        }
    }
}

function Invoke-ClamAVProbe([byte[]]$Payload) {
    $client = [Net.Sockets.TcpClient]::new()
    try {
        $pending = $client.ConnectAsync('127.0.0.1', 3310)
        if (!$pending.Wait(3000)) { throw 'timeout' }
        $stream = $client.GetStream()
        $stream.ReadTimeout = 10000
        $stream.WriteTimeout = 3000
        $stream.Write($Payload, 0, $Payload.Length)
        $reply = [Collections.Generic.List[byte]]::new()
        while ($reply.Count -lt 1024) {
            $value = $stream.ReadByte()
            if ($value -lt 0) { throw 'incomplete response' }
            if ($value -eq 0) { return [Text.Encoding]::ASCII.GetString($reply.ToArray()) }
            $reply.Add([byte]$value)
        }
        throw 'oversized response'
    } finally { $client.Dispose() }
}

function Assert-ClamAVReady {
    try {
        if ((Invoke-ClamAVProbe ([Text.Encoding]::ASCII.GetBytes("zPING`0"))) -ne 'PONG') { throw 'ping' }
        $content = [Text.Encoding]::ASCII.GetBytes('NamPol harmless startup readiness probe')
        $length = [BitConverter]::GetBytes([uint32]$content.Length)
        if ([BitConverter]::IsLittleEndian) { [Array]::Reverse($length) }
        [byte[]]$payload = [Text.Encoding]::ASCII.GetBytes("zINSTREAM`0") + $length + $content + [byte[]]@(0, 0, 0, 0)
        if ((Invoke-ClamAVProbe $payload) -ne 'stream: OK') { throw 'scan' }
    } catch { throw 'ClamAV is not ready on 127.0.0.1:3310. Check the existing NamPol-ClamAV scheduled task and ClamAV logs; no scanner settings were changed.' }
    Write-Host 'ClamAV PING and harmless INSTREAM scan passed on 127.0.0.1:3310.'
}

function Assert-PortAvailable([int]$Port) {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    try { $listener.ExclusiveAddressUse = $true; $listener.Start() }
    catch { throw "Port $Port is occupied or unavailable. No existing process was stopped. Close the previous server and retry." }
    finally { $listener.Stop() }
}

function Start-NamPolProcess([string]$Python, [string]$Arguments, $Config, [switch]$CaptureOutput) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $Python
    $info.Arguments = $Arguments
    $info.WorkingDirectory = $script:ProjectRoot
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($name in @($info.EnvironmentVariables.Keys)) {
        if ($name -match '^(SUPABASE_|FIREBASE_|GOOGLE_APPLICATION_CREDENTIALS$)') { $info.EnvironmentVariables.Remove($name) }
        if ($null -eq $Config -and $name -match '^NAMPOL_(SMTP_|EMAIL_|APPROVED_EMAIL_DELIVERY$)') {
            $info.EnvironmentVariables.Remove($name)
        }
    }
    if ($null -ne $Config) {
        $info.EnvironmentVariables['GOOGLE_APPLICATION_CREDENTIALS'] = $Config.FirebasePath
        $info.EnvironmentVariables['SUPABASE_URL'] = $Config.SupabaseUrl
        $info.EnvironmentVariables['SUPABASE_SECRET_KEY'] = $Config.SupabaseKey
        $info.EnvironmentVariables['SUPABASE_BUCKET'] = 'applicant-documents'
        $info.EnvironmentVariables['FIREBASE_PROJECT_ID'] = 'nampol-recruitment'
        $info.EnvironmentVariables['CLAMAV_PORT'] = '3310'
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    $null = $process.Start()
    # Drain both pipes asynchronously without printing or persisting SDK output.
    if (!$CaptureOutput) { $null = $process.StandardOutput.BaseStream.CopyToAsync([IO.Stream]::Null) }
    $null = $process.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
    $process.StartInfo.EnvironmentVariables.Clear()
    return $process
}

function Assert-StorageReady([string]$Python, $Config) {
    $probe = $null
    try {
        Write-Host 'Checking Supabase credentials and private bucket (read-only)...'
        $probe = Start-NamPolProcess $Python '-m backend.preflight' $Config -CaptureOutput
        if (!$probe.WaitForExit(40000)) { throw 'Supabase readiness timed out. Check the project URL, network and project status. No servers were started.' }
        $code = $probe.StandardOutput.ReadToEnd().Trim()
        if ($probe.ExitCode -eq 0 -and $code -eq 'storage_ready') {
            Write-Host 'Supabase accepted the server credentials and the document bucket is private.'
            return
        }
        $messages = @{
            storage_dns_error = 'The Supabase project hostname does not resolve. Copy the exact current Project URL from the dashboard.'
            storage_https_error = 'The Supabase HTTPS connection failed. Check the project URL, network and certificate trust; TLS verification remains enabled.'
            storage_credentials_error = 'Supabase rejected the saved server key. Copy an active sb_secret_ key and the matching project URL from the same project.'
            storage_connection_error = 'Cannot connect to the saved Supabase project. Check the exact project URL, DNS, network and project status.'
            storage_bucket_missing = 'The applicant-documents bucket was not found in the configured project.'
            storage_bucket_not_private = 'The applicant-documents bucket is not private. Readiness failed; no bucket settings were changed.'
            storage_request_error = 'Supabase rejected the storage API request. Check the project/key pair and storage integration.'
            storage_timeout = 'Supabase storage timed out. Check network access and project status.'
            storage_service_error = 'Supabase storage is unavailable. Check project status and permissions.'
            storage_configuration_error = 'The backend could not load its storage configuration.'
        }
        $message = if ($messages.ContainsKey($code)) { $messages[$code] } else { 'Storage readiness failed; raw process output was suppressed to protect credentials.' }
        throw ($message + ' Run this launcher with -Configure to privately replace and verify saved settings. No application servers were started.')
    } finally {
        if ($null -ne $probe) {
            try { if (!$probe.HasExited) { $probe.Kill(); $null = $probe.WaitForExit(5000) } }
            finally { $probe.Dispose() }
        }
    }
}

function Wait-NamPolServer($Process, [string]$Url, [switch]$Backend) {
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($Process.HasExited) { throw 'A server exited during startup. Check the existing environment/dependencies and backend credential/project permissions; raw SDK output is suppressed to protect credentials.' }
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2 -MaximumRedirection 0
            if ($response.StatusCode -eq 200) {
                if ($Backend) {
                    $health = $response.Content | ConvertFrom-Json
                    if ($health.status -ne 'ok' -or $health.phase -ne '2A') { throw 'Unexpected health response' }
                }
                if (!$Process.HasExited) { return }
            }
        } catch { }
        Start-Sleep -Milliseconds 250
    }
    throw 'Server readiness timed out after 30 seconds. Check port availability, existing dependencies and credentials.'
}

function Start-NamPol {
    $backend = $null
    $frontend = $null
    $config = $null
    try {
        $python = Join-Path $script:ProjectRoot '.venv-backend\Scripts\python.exe'
        if (!(Test-Path -LiteralPath $python -PathType Leaf)) { throw 'Existing .venv-backend Python is missing. No dependencies were installed.' }
        if (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'serve_frontend.py') -PathType Leaf)) { throw 'The existing secure frontend server script is missing.' }
        foreach ($name in @('FIREBASE_AUTH_EMULATOR_HOST', 'FIRESTORE_EMULATOR_HOST')) {
            if (Get-ExistingValue $name) { throw 'Emulator configuration is not allowed for this launcher.' }
        }
        Assert-PortAvailable 8001
        Assert-PortAvailable 8000
        Assert-ClamAVReady
        $config = Get-NamPolConfiguration -NonInteractive:$NoPrompt -Reconfigure:$Configure
        Assert-StorageReady $python $config
        $save = [bool]$SaveCredentials -or $config.NeedsSave
        if ($save) { Save-NamPolConfiguration $config }
        if ($CheckOnly) { Write-Host 'Preflight passed. No application servers were started.'; return }
        $backend = Start-NamPolProcess $python '-m uvicorn app:app --host 127.0.0.1 --port 8001 --no-access-log' $config
        $config.SupabaseKey = ''
        Wait-NamPolServer $backend 'http://127.0.0.1:8001/health' -Backend
        $frontend = Start-NamPolProcess $python 'scripts/serve_frontend.py --port 8000' $null
        Wait-NamPolServer $frontend 'http://127.0.0.1:8000/Frontend/login.html'
        foreach ($path in @('/.env', '/app.py', '/.venv-backend/pyvenv.cfg')) {
            try {
                $null = Invoke-WebRequest -Uri ('http://127.0.0.1:8000' + $path) -UseBasicParsing -TimeoutSec 3 -MaximumRedirection 0
                throw 'Private path unexpectedly accessible'
            } catch {
                $responseProperty = $_.Exception.PSObject.Properties['Response']
                if (!$responseProperty -or !$responseProperty.Value -or [int]$responseProperty.Value.StatusCode -notin @(403, 404)) {
                    throw 'Frontend private-path protection check failed; servers are being stopped.'
                }
            }
        }
        Write-Host 'Login:   http://127.0.0.1:8000/Frontend/login.html'
        Write-Host 'Backend: http://127.0.0.1:8001/health'
        Write-Host 'Both servers are ready. Keep this terminal open; press Ctrl+C to stop both.'
        while ($true) {
            if ($backend.HasExited -or $frontend.HasExited) { throw 'A NamPol server stopped unexpectedly. Both launcher-owned servers will be stopped; run the launcher again after investigating.' }
            Start-Sleep -Seconds 1
        }
    } finally {
        if ($config) { $config.SupabaseKey = '' }
        foreach ($process in @($frontend, $backend)) {
            if ($null -ne $process) {
                try {
                    if (!$process.HasExited) {
                        $process.Kill()
                        if (!$process.WaitForExit(5000)) { Write-Warning 'A launcher-owned server did not exit within five seconds.' }
                    }
                } catch { Write-Warning 'Could not stop a launcher-owned server. Check ports 8000/8001 before relaunching.' }
                finally { $process.Dispose() }
            }
        }
    }
}

# Dot-source for offline launcher tests; normal invocation runs the launcher.
if ($MyInvocation.InvocationName -ne '.') {
    try {
        if ($VerifySavedConfiguration) {
            Assert-ExternalPath $ConfigurationPath
            $script:ConfigFile = $ConfigurationPath
            $savedConfig = Get-NamPolConfiguration -NonInteractive -SavedOnly
            try {
                Assert-StorageReady (Join-Path $script:ProjectRoot '.venv-backend\Scripts\python.exe') $savedConfig
                Write-Output 'saved_configuration_verified'
            } finally { $savedConfig.SupabaseKey = '' }
        } else { Start-NamPol }
    }
    catch { Write-Host ('NamPol startup failed: ' + $_.Exception.Message) -ForegroundColor Red; exit 1 }
}
