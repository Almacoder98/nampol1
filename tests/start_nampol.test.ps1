# Offline/synthetic launcher integration. No real credentials or cloud requests.
param([switch]$SkipFullLaunch)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\scripts\start_nampol.ps1')

function Assert-True($Value, [string]$Message) {
    if (!$Value) { throw "Launcher test failed: $Message" }
}

# Mock only the host input boundary. Exercise the real credential reader without
# asking for real credentials or reading the clipboard.
function Read-Host([string]$Prompt, [switch]$AsSecureString) {
    Assert-True $AsSecureString 'credential entry must request masked host input'
    return ConvertTo-SecureString $script:SyntheticInput -AsPlainText -Force
}
try {
    $script:SyntheticInput = " `r`nhttps://launcher-test.invalid/ `t"
    $output = @(Read-PrivateValue 'Synthetic URL' -SupabaseInput *>&1)
    Assert-True ($output.Count -eq 1 -and $output[0] -ceq 'https://launcher-test.invalid/') 'masked URL input normalizes copied whitespace without extra output'
    $expectedKey = 'sb_secret_' + ('synthetic' * 40)
    $script:SyntheticInput = " $expectedKey `r`n"
    $output = @(Read-PrivateValue 'Synthetic key' -SupabaseInput *>&1)
    Assert-True ($output.Count -eq 1 -and $output[0] -ceq $expectedKey) 'masked secret is returned only to caller'
    $script:SyntheticInput = 'C:\synthetic path\firebase.json'
    Assert-True ((Read-PrivateValue 'Synthetic path') -ceq $script:SyntheticInput) 'Firebase path keeps spaces'
    $rejected = $false
    try { $null = Read-PrivateValue 'Synthetic missing' -NonInteractive -SupabaseInput } catch { $rejected = $true }
    Assert-True $rejected 'noninteractive mode never prompts'
    Write-Host 'PASS: standard masked host input, whitespace normalization, private return values and noninteractive rejection.'
} finally {
    Remove-Item Function:\Read-Host
    $script:SyntheticInput = $null
    $expectedKey = $null
    $output = $null
}

$testRoot = Join-Path $env:TEMP ('nampol-launcher-test-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $testRoot
$python = Join-Path $script:ProjectRoot '.venv-backend\Scripts\python.exe'
$backend = $null
$frontend = $null
try {
    # Generate an ephemeral, non-cloud service-account fixture outside Git.
    $fixtureScript = @'
import json, pathlib, sys
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
p = pathlib.Path(sys.argv[1])
key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
private = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
(p / 'firebase.json').write_text(json.dumps({'type':'service_account', 'project_id':'nampol-recruitment',
    'private_key_id':'synthetic', 'private_key':private,
    'client_email':'launcher-test@nampol-recruitment.iam.gserviceaccount.com',
    'client_id':'123456', 'token_uri':'https://oauth2.googleapis.com/token'}))
(p / 'probe.py').write_text('import json, os, pathlib, sys\n'
    'names = ["SUPABASE_SECRET_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "SUPABASE_URL", "NAMPOL_SMTP_PASSWORD"]\n'
    'pathlib.Path(sys.argv[1]).write_text(json.dumps([bool(os.environ.get(n)) for n in names]))\n')
'@
    $fixtureScript | & $python - $testRoot
    Assert-True ($LASTEXITCODE -eq 0) 'synthetic fixture creation'
    $config = [pscustomobject]@{
        FirebasePath = Join-Path $testRoot 'firebase.json'
        SupabaseUrl = 'https://launcher-test.invalid'
        SupabaseKey = 'sb_secret_synthetic_launcher_only'
        Prompted = $false
        NeedsSave = $false
    }
    Assert-Configuration $config
    foreach ($change in @('FirebasePath', 'SupabaseUrl', 'SupabaseKey')) {
        $invalid = $config.PSObject.Copy()
        $invalid.$change = switch ($change) {
            'FirebasePath' { Join-Path $script:ProjectRoot 'private.json' }
            'SupabaseUrl' { 'http://example.invalid' }
            'SupabaseKey' { 'public-key' }
        }
        $rejected = $false
        try { Assert-Configuration $invalid } catch { $rejected = $true }
        Assert-True $rejected ('unsafe configuration rejected: ' + $change)
    }
    Write-Host 'PASS: configuration validation rejects unsafe paths, URLs and key types.'

    $script:ConfigDirectory = Join-Path $testRoot 'protected'
    $script:ConfigFile = Join-Path $script:ConfigDirectory 'credentials.clixml'
    $originalSavedVerifier = (Get-Item Function:\Assert-SavedConfiguration).ScriptBlock
    # Cloud endpoints are always offline fixtures in this test. Candidate file
    # validation must still occur before commit, and a fresh real process below
    # reloads and uses both DPAPI values through the backend process helper.
    function Assert-SavedConfiguration([string]$Path) {
        $candidate = Import-Clixml -LiteralPath $Path
        Assert-True ($candidate.SupabaseUrl -is [Security.SecureString]) 'candidate URL is encrypted'
        Assert-True ($candidate.SupabaseKey -is [Security.SecureString]) 'candidate key is encrypted'
        $candidate.SupabaseUrl.Dispose()
        $candidate.SupabaseKey.Dispose()
    }
    # A generic Set-Acl call requests audit privileges on the second save. Never
    # permit this path, including on machines where the test token is elevated.
    function Set-Acl { throw 'Credential saving must persist DACL changes only.' }
    Save-NamPolConfiguration $config
    $ownerBefore = (Get-Acl -LiteralPath $script:ConfigDirectory).Owner
    Save-NamPolConfiguration $config
    Assert-True ((Get-Acl -LiteralPath $script:ConfigDirectory).Owner -eq $ownerBefore) 'repeat save preserves directory ownership'
    $saved = Import-Clixml -LiteralPath $script:ConfigFile
    Assert-True ($saved.SupabaseKey -is [Security.SecureString]) 'DPAPI SecureString round trip'
    Assert-True ($saved.SupabaseUrl -is [Security.SecureString]) 'URL is also protected by DPAPI'
    Assert-True ((ConvertFrom-PrivateString $saved.SupabaseKey) -eq $config.SupabaseKey) 'DPAPI decryption'
    Assert-True (!(Get-Content -LiteralPath $script:ConfigFile -Raw).Contains($config.SupabaseKey)) 'no plaintext key in saved XML'
    Assert-True (!(Get-Content -LiteralPath $script:ConfigFile -Raw).Contains($config.SupabaseUrl)) 'no plaintext URL in saved XML'
    Assert-True ((Get-Acl -LiteralPath $script:ConfigDirectory).AreAccessRulesProtected) 'restricted directory inheritance'
    $allowedSids = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18')
    foreach ($path in @($script:ConfigDirectory, $script:ConfigFile)) {
        $rules = (Get-Acl -LiteralPath $path).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
        Assert-True ($rules.Count -gt 0) 'access rules are present'
        foreach ($rule in $rules) {
            Assert-True ($rule.IdentityReference.Value -in $allowedSids) 'only current user and SYSTEM can access credential files'
        }
    }
    Assert-True ($saved.FirebasePath -ceq $config.FirebasePath) 'Firebase path preserved on repeated save'
    Assert-True ((ConvertFrom-PrivateString $saved.SupabaseUrl) -ceq $config.SupabaseUrl) 'Supabase URL preserved on repeated save'
    $saved.SupabaseUrl.Dispose()
    $saved.SupabaseKey.Dispose()
    $loadCheckPath = Join-Path $testRoot 'load-config.ps1'
    @'
param([string]$InputConfigPath, [string]$Launcher, [string]$Python, [string]$Probe, [string]$OutputFile)
$ErrorActionPreference = 'Stop'
try {
    . $Launcher
    $script:ConfigFile = $InputConfigPath
    # Saved values must win even when inherited/user environment values differ.
    $env:SUPABASE_URL = 'https://stale.invalid'
    $env:SUPABASE_SECRET_KEY = 'sb_secret_stale_test_only'
    $loaded = Get-NamPolConfiguration -NonInteractive -SavedOnly
    if ($loaded.NeedsSave) { exit 1 }
    $arguments = '"' + $Probe + '" "' + $OutputFile + '"'
    $child = Start-NamPolProcess $Python $arguments $loaded
    try { if (!$child.WaitForExit(10000) -or $child.ExitCode -ne 0) { exit 2 } }
    finally { if (!$child.HasExited) { $child.Kill(); $child.WaitForExit() }; $child.Dispose() }
    $loaded.SupabaseKey = ''
    Write-Output 'fresh_process_decryption=passed'
} catch { exit 3 }
'@ | Set-Content -LiteralPath $loadCheckPath -Encoding UTF8
    $freshOutputPath = Join-Path $testRoot 'fresh-probe.json'
    $freshProcessOutput = & powershell.exe -NoProfile -File $loadCheckPath -InputConfigPath $script:ConfigFile -Launcher (Join-Path $PSScriptRoot '..\scripts\start_nampol.ps1') -Python $python -Probe (Join-Path $testRoot 'probe.py') -OutputFile $freshOutputPath
    Assert-True ($LASTEXITCODE -eq 0 -and $freshProcessOutput -eq 'fresh_process_decryption=passed') 'DPAPI configuration decrypts in a fresh Windows PowerShell process without prompting'
    $freshFlags = Get-Content -LiteralPath $freshOutputPath -Raw | ConvertFrom-Json
    Assert-True ($freshFlags[0] -and $freshFlags[1] -and $freshFlags[2]) 'fresh PowerShell uses reloaded credentials in backend environment'

    # Run the actual fresh-process verifier with offline HTTP/DNS fixtures in
    # its Python child, rather than reaching any live cloud project.
    @'
import socket
import httpx
original_client = httpx.Client
original_dns = socket.getaddrinfo
def offline_dns(host, *args, **kwargs):
    if host == 'launcher-test.invalid':
        return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', ('127.0.0.1', 443))]
    return original_dns(host, *args, **kwargs)
def handle(request):
    assert request.url.host == 'launcher-test.invalid'
    if request.url.path == '/':
        assert 'apikey' not in request.headers
        return httpx.Response(404)
    assert request.method == 'GET'
    assert request.url.path == '/storage/v1/bucket/applicant-documents'
    assert request.headers['apikey'] == 'sb_secret_synthetic_launcher_only'
    return httpx.Response(200, json={'public': False})
def offline_client(*args, **kwargs):
    kwargs['transport'] = httpx.MockTransport(handle)
    return original_client(*args, **kwargs)
socket.getaddrinfo = offline_dns
httpx.Client = offline_client
'@ | Set-Content -LiteralPath (Join-Path $testRoot 'sitecustomize.py') -Encoding UTF8
    $oldPythonPath = $env:PYTHONPATH
    try {
        $env:PYTHONPATH = $testRoot
        & $originalSavedVerifier $script:ConfigFile
    } finally { $env:PYTHONPATH = $oldPythonPath }
    Write-Host 'PASS: actual fresh PowerShell verifier reloads both values and uses them for DNS/HTTPS/private-bucket checks with offline fixtures.'

    $beforeFailureHash = (Get-FileHash -LiteralPath $script:ConfigFile).Hash
    $fixtureVerifier = (Get-Item Function:\Assert-SavedConfiguration).ScriptBlock
    function Assert-SavedConfiguration { throw 'Synthetic fresh-process verification failure' }
    try {
        $failed = $false
        try { Save-NamPolConfiguration $config } catch { $failed = $true }
        Assert-True $failed 'fresh verification failure blocks saving'
        Assert-True ((Get-FileHash -LiteralPath $script:ConfigFile).Hash -ceq $beforeFailureHash) 'failed verification preserves existing configuration bytes'
        Assert-True (@(Get-ChildItem -LiteralPath $script:ConfigDirectory -File).Count -eq 1) 'failed candidate removed'
    } finally { Set-Item Function:\Assert-SavedConfiguration -Value $fixtureVerifier }
    Write-Host 'PASS: repeated DPAPI save/load, restricted directory/file ACL, preserved settings and ownership; no Set-Acl or audit privileges.'

    # Override only configuration discovery to ensure tests never read real settings.
    function Get-ExistingValue([string]$Name) {
        if ($Name -eq 'SUPABASE_URL') { return 'https://stale.invalid' }
        if ($Name -eq 'SUPABASE_SECRET_KEY') { return 'sb_secret_stale_test_only' }
        return ''
    }
    $loaded = Get-NamPolConfiguration -NonInteractive
    Assert-True ($loaded.SupabaseKey -eq $config.SupabaseKey) 'saved configuration loads without prompts'
    Assert-True ($loaded.SupabaseUrl -eq $config.SupabaseUrl) 'saved pair overrides stale environment values'
    Assert-True (!$loaded.NeedsSave) 'ordinary saved launch does not prompt or save again'
    $loaded.SupabaseKey = ''
    $savedPath = $script:ConfigFile
    $legacy = Import-Clixml -LiteralPath $savedPath
    $legacy.SupabaseUrl.Dispose()
    $legacy.SupabaseUrl = $config.SupabaseUrl
    $legacyPath = Join-Path $testRoot 'legacy.clixml'
    $legacy | Export-Clixml -LiteralPath $legacyPath
    $legacy.SupabaseKey.Dispose()
    $script:ConfigFile = $legacyPath
    $migrating = Get-NamPolConfiguration -NonInteractive
    Assert-True ($migrating.NeedsSave -and $migrating.SupabaseUrl -eq $config.SupabaseUrl -and $migrating.SupabaseKey -eq $config.SupabaseKey) 'legacy URL loads without reentry and requests verified migration'
    $migrating.SupabaseKey = ''
    $script:ConfigFile = $savedPath
    $script:ConfigFile = Join-Path $testRoot 'missing.clixml'
    function Get-ExistingValue([string]$Name) { return '' }
    $rejected = $false
    try { $null = Get-NamPolConfiguration -NonInteractive } catch { $rejected = $true }
    Assert-True $rejected 'missing credentials fail without prompting in NoPrompt mode'
    $script:ConfigFile = $savedPath
    Write-Host 'PASS: saved configuration discovery and missing-credential handling.'

    $originalReader = (Get-Item Function:\Read-PrivateValue).ScriptBlock
    function Read-PrivateValue([string]$Prompt, [switch]$NonInteractive, [switch]$SupabaseInput) {
        if ($Prompt -match 'SUPABASE_URL') { return 'https://reconfigured.invalid' }
        if ($Prompt -match 'SUPABASE_SECRET_KEY') { return 'sb_secret_reconfigured_test_only' }
        throw 'Unexpected prompt during configuration test'
    }
    try {
        $replacement = Get-NamPolConfiguration -Reconfigure
        Assert-True ($replacement.SupabaseUrl -eq 'https://reconfigured.invalid') 'Configure replaces the saved URL'
        Assert-True ($replacement.SupabaseKey -eq 'sb_secret_reconfigured_test_only') 'Configure replaces the saved key'
        Assert-True ($replacement.FirebasePath -eq $config.FirebasePath) 'Configure preserves the Firebase path'
        Assert-True $replacement.Prompted 'Configure records private prompting'
        $replacement.SupabaseKey = ''
    } finally { Set-Item Function:\Read-PrivateValue -Value $originalReader }
    Write-Host 'PASS: explicit configuration replaces stale settings through private prompts.'

    $originalStarter = (Get-Item Function:\Start-NamPolProcess).ScriptBlock
    function Start-NamPolProcess { return $script:ProbeFixture }
    try {
        foreach ($probeCode in @('storage_ready', 'storage_credentials_error', 'private-unexpected-output')) {
            $script:ProbeFixture = [pscustomobject]@{
                HasExited = $true
                ExitCode = $(if ($probeCode -eq 'storage_ready') { 0 } else { 1 })
                StandardOutput = [IO.StringReader]::new($probeCode)
            }
            $script:ProbeFixture | Add-Member ScriptMethod WaitForExit { param($timeout) return $true }
            $script:ProbeFixture | Add-Member ScriptMethod Dispose { $this.StandardOutput.Dispose() }
            $failed = $false
            try { Assert-StorageReady $python $config } catch {
                $failed = $true
                Assert-True (!$_.Exception.Message.Contains('private-unexpected-output')) 'unexpected subprocess output is suppressed'
                Assert-True ($_.Exception.Message -match 'No application servers were started') 'readiness failure explains server state'
            }
            Assert-True ($failed -eq ($probeCode -ne 'storage_ready')) 'storage preflight controls startup'
        }
    } finally { Set-Item Function:\Start-NamPolProcess -Value $originalStarter }
    Write-Host 'PASS: storage readiness gate blocks rejected credentials and suppresses unexpected subprocess output.'

    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try {
        $rejected = $false
        try { Assert-PortAvailable $listener.LocalEndpoint.Port } catch { $rejected = $true }
        Assert-True $rejected 'occupied port rejection'
    } finally { $listener.Stop() }
    Write-Host 'PASS: occupied ports are refused without stopping existing listeners.'

    $parentKey = [Environment]::GetEnvironmentVariable('SUPABASE_SECRET_KEY', 'Process')
    $parentSmtp = [Environment]::GetEnvironmentVariable('NAMPOL_SMTP_PASSWORD', 'Process')
    try {
        [Environment]::SetEnvironmentVariable('SUPABASE_SECRET_KEY', $config.SupabaseKey, 'Process')
        [Environment]::SetEnvironmentVariable('NAMPOL_SMTP_PASSWORD', 'synthetic-smtp-only', 'Process')
        foreach ($isBackend in @($true, $false)) {
            $resultFile = Join-Path $testRoot ('probe-' + $isBackend + '.json')
            $arguments = '"' + (Join-Path $testRoot 'probe.py') + '" "' + $resultFile + '"'
            $childConfig = if ($isBackend) { $config } else { $null }
            $process = Start-NamPolProcess $python $arguments $childConfig
            try {
                Assert-True ($process.WaitForExit(10000)) 'environment probe exits'
                $flags = Get-Content -LiteralPath $resultFile -Raw | ConvertFrom-Json
                Assert-True ($flags[0] -eq $isBackend) 'backend-only secret environment'
                Assert-True ($flags[3] -eq $isBackend) 'SMTP credentials are inherited by backend only'
                if ($isBackend) { Assert-True ($flags[1] -and $flags[2]) 'backend configuration environment' }
            } finally {
                if (!$process.HasExited) { $process.Kill(); $process.WaitForExit() }
                $process.Dispose()
            }
        }
    } finally {
        [Environment]::SetEnvironmentVariable('SUPABASE_SECRET_KEY', $parentKey, 'Process')
        [Environment]::SetEnvironmentVariable('NAMPOL_SMTP_PASSWORD', $parentSmtp, 'Process')
    }
    Write-Host 'PASS: credentials passed in backend environment only, never command arguments.'
    if ($SkipFullLaunch) {
        Write-Host 'SKIP: full launcher restart smoke test; existing application servers are preserved.'
        return
    }

    # Exercise the entire launch/verification/cleanup path. Interrupt the monitor
    # after readiness, just as leaving the launcher must stop its own children.
    $script:FixtureConfig = $config.PSObject.Copy()
    $script:FixtureConfig.NeedsSave = $true
    $script:AutomaticSaveCount = 0
    $originalSaver = (Get-Item Function:\Save-NamPolConfiguration).ScriptBlock
    function Save-NamPolConfiguration($Config) {
        $script:AutomaticSaveCount++
        & $originalSaver $Config
    }
    function Get-NamPolConfiguration { return $script:FixtureConfig.PSObject.Copy() }
    # The live cloud probe is tested separately with HTTP fixtures; this full
    # orchestration test must never contact cloud services using synthetic keys.
    function Assert-StorageReady([string]$Python, $Config) {
        Assert-True ($Config.SupabaseKey -eq $script:FixtureConfig.SupabaseKey) 'storage preflight receives backend configuration'
    }
    function Start-Sleep([int]$Seconds, [int]$Milliseconds) {
        if ($Seconds -eq 1) {
            $response = $null
            try { $null = Invoke-WebRequest 'http://127.0.0.1:8001/api/me/document-sets' -UseBasicParsing }
            catch { $response = $_.Exception.Response }
            Assert-True ($null -ne $response -and [int]$response.StatusCode -eq 401) 'real FastAPI rejects unauthenticated document access'
            throw 'synthetic-test-monitor-stop'
        }
        Microsoft.PowerShell.Utility\Start-Sleep -Milliseconds $Milliseconds
    }
    $NoPrompt = $true
    $CheckOnly = $false
    $SaveCredentials = $false
    $stopped = $false
    Write-Host 'Testing complete launcher with synthetic credentials; test servers will be stopped immediately.'
    try { Start-NamPol } catch {
        if ($_.Exception.Message -ne 'synthetic-test-monitor-stop') { throw }
        $stopped = $true
    }
    Assert-True $stopped 'complete startup reached monitor and cleaned up on interruption'
    Assert-True ($script:AutomaticSaveCount -eq 1) 'verified new settings save automatically without a save prompt or switch'
    Write-Host 'PASS: full launcher, real ClamAV, real servers, authentication boundary, private-path checks and interruption cleanup.'
} finally {
    foreach ($process in @($frontend, $backend)) {
        if ($null -ne $process) {
            if (!$process.HasExited) { $process.Kill(); $process.WaitForExit() }
            $process.Dispose()
        }
    }
    # Remove only this run's explicitly named files; never recursively delete paths.
    foreach ($file in @('firebase.json', 'probe.py', 'load-config.ps1', 'sitecustomize.py', 'legacy.clixml', 'fresh-probe.json', 'probe-True.json', 'probe-False.json', 'protected\credentials.clixml')) {
        $target = Join-Path $testRoot $file
        if (Test-Path -LiteralPath $target -PathType Leaf) { Remove-Item -LiteralPath $target -Force }
    }
    $cacheDirectory = Join-Path $testRoot '__pycache__'
    if (Test-Path -LiteralPath $cacheDirectory) {
        Get-ChildItem -LiteralPath $cacheDirectory -File -Filter 'sitecustomize.*.pyc' | ForEach-Object { Remove-Item -LiteralPath $_.FullName }
        Remove-Item -LiteralPath $cacheDirectory
    }
    if (Test-Path -LiteralPath (Join-Path $testRoot 'protected')) { Remove-Item -LiteralPath (Join-Path $testRoot 'protected') }
    Remove-Item -LiteralPath $testRoot
}
Assert-PortAvailable 8001
Assert-PortAvailable 8000
Write-Host 'PASS: test servers stopped and temporary synthetic credentials removed.'
