<#
.SYNOPSIS
    Creates a local standard user and runs the smoke specs as that user (task 13.6, 7.4).

.DESCRIPTION
    Requirement 7.4 needs a Windows user whose profile path has Chinese characters and a space.
    The workflow passes such a name (for example one made of Chinese characters around a space).
    This script (run as the runner's administrator):

      1. starts the Secondary Logon service, which Start-Process -Credential needs;
      2. creates the user with a random password, member of Users only (like a student account);
      3. grants it read access to the harness, installer and runtime directories and write
         access to the results directory;
      4. starts Run-AsUserInner.ps1 as that user with its profile loaded, which installs
         ModelForge for that user and runs Playwright, and waits for it.

    -EnvFile is the JSON file described in Run-AsUserInner.ps1. Its "resultsDir" is where the
    inner run writes inner-result.json; that file is read back here, because the exit code of a
    process that belongs to another user is not always readable.

    Exit codes: the inner script's (0 passed, 1 tests failed, 2 inner setup failed), 3 when no
    process could run as the new user (the caller then falls back to a simulated profile),
    124 on timeout.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $UserName,
    [Parameter(Mandatory = $true)][string] $EnvFile,
    [string] $GrantRead = '',
    [string] $GrantModify = '',
    [string] $WorkingDirectory = '',
    [string] $ResultFile = '',
    # Above the Playwright budget of Run-AsUserInner.ps1 (-TimeoutSeconds 6300 there).
    [int] $TimeoutSeconds = 6600
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'SmokeCommon.ps1')

$EXIT_CANNOT_START = 3
$EXIT_TIMEOUT = 124

$result = [ordered]@{
    ok              = $false
    userName        = $UserName
    sid             = ''
    profileDir      = ''
    exitCode        = $null
    stage           = 'setup'
    innerResultFile = ''
    inner           = $null
    error           = $null
}
$exitCode = $EXIT_CANNOT_START

function Grant-Access([string] $list, [string] $sid, [string] $rights) {
    foreach ($dir in ($list -split ';')) {
        $dir = $dir.Trim()
        if (-not $dir) { continue }
        if (-not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Force -Path $dir | Out-Null
        }
        # Inheritable grant on the folder; Windows propagates it to what is inside.
        $output = & icacls.exe $dir /grant ("*{0}:(OI)(CI){1}" -f $sid, $rights) /C /Q 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw ("icacls {0} failed: {1}" -f $dir, ($output | Out-String))
        }
        Write-Host ("granted {0} on {1}" -f $rights, $dir)
    }
}

function Read-InnerResult([string] $path) {
    if (-not $path -or -not (Test-Path -LiteralPath $path)) { return $null }
    try {
        return (Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json)
    }
    catch {
        Write-Host ("inner result {0} is not readable: {1}" -f $path, $_.Exception.Message)
        return $null
    }
}

try {
    $envSpec = Get-Content -LiteralPath $EnvFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $envSpec.resultsDir) { throw "$EnvFile has no resultsDir" }
    $innerResultFile = Join-Path ([string]$envSpec.resultsDir) 'inner-result.json'
    $result.innerResultFile = $innerResultFile
    if (Test-Path -LiteralPath $innerResultFile) { Remove-Item -LiteralPath $innerResultFile -Force }

    # 1. Secondary Logon (CreateProcessWithLogonW).
    $service = Get-Service -Name seclogon -ErrorAction SilentlyContinue
    if ($service) {
        if ($service.StartType -eq 'Disabled') {
            Set-Service -Name seclogon -StartupType Manual
        }
        if ($service.Status -ne 'Running') {
            Start-Service -Name seclogon
        }
    }

    # 2. The user.
    $chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    $random = New-Object System.Random
    $plain = 'Mf-' + (-join (1..20 | ForEach-Object { $chars[$random.Next($chars.Length)] })) + '-9a!'
    $secure = ConvertTo-SecureString -String $plain -AsPlainText -Force
    $existing = Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue
    if ($existing) {
        Set-LocalUser -Name $UserName -Password $secure
    }
    else {
        New-LocalUser -Name $UserName -Password $secure -PasswordNeverExpires -AccountNeverExpires `
            -Description 'ModelForge smoke test user' | Out-Null
    }
    $user = Get-LocalUser -Name $UserName
    $sid = $user.SID.Value
    $result.sid = $sid
    # Built-in Users group by SID, whatever the system language calls it.
    $usersGroup = Get-LocalGroup -SID 'S-1-5-32-545'
    $isMember = @(Get-LocalGroupMember -Group $usersGroup -ErrorAction SilentlyContinue |
        Where-Object { $_.SID.Value -eq $sid }).Count -gt 0
    if (-not $isMember) {
        try {
            Add-LocalGroupMember -Group $usersGroup -Member $user -ErrorAction Stop
        }
        catch {
            # New local accounts usually are members already; the listing above can miss it.
            if ($_.FullyQualifiedErrorId -notlike 'MemberExists*') { throw }
        }
    }
    Write-Host ("user ready: SID {0}" -f $sid)

    # 3. Access to what the inner run needs.
    Grant-Access -list $GrantRead -sid $sid -rights 'RX'
    Grant-Access -list $GrantModify -sid $sid -rights 'M'

    # 4. Run the inner script as the user, with the user's profile loaded.
    $result.stage = 'start'
    $credential = New-Object System.Management.Automation.PSCredential(("{0}\{1}" -f $env:COMPUTERNAME, $UserName), $secure)
    $inner = Join-Path $PSScriptRoot 'Run-AsUserInner.ps1'
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $argumentLine = ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -EnvFile "{1}"' -f $inner, $EnvFile)
    if (-not $WorkingDirectory) { $WorkingDirectory = Split-Path -Parent $EnvFile }
    try {
        $process = Start-Process -FilePath $powershell -ArgumentList $argumentLine -Credential $credential `
            -LoadUserProfile -WorkingDirectory $WorkingDirectory -PassThru
    }
    catch {
        throw ("could not start a process as {0}: {1}" -f $UserName, $_.Exception.Message)
    }
    $innerPid = $process.Id
    $result.stage = 'running'
    Write-Host ("started the inner run as {0} (pid {1})" -f $UserName, $innerPid)

    # The process belongs to another user: its handle (and so its exit code) may be denied.
    $haveHandle = $true
    try { $null = $process.Handle } catch { $haveHandle = $false }
    $code = $null
    $timedOut = $false
    if ($haveHandle) {
        $code = Wait-ProcessExit -Process $process -TimeoutSeconds $TimeoutSeconds
        $timedOut = ($null -eq $code)
    }
    else {
        Write-Host 'no handle on the inner process; polling it and reading its result file'
        $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
        while ((Get-Date) -lt $deadline -and (Get-Process -Id $innerPid -ErrorAction SilentlyContinue)) {
            Start-Sleep -Seconds 5
        }
        $timedOut = [bool](Get-Process -Id $innerPid -ErrorAction SilentlyContinue)
    }
    if ($timedOut) {
        & taskkill.exe /PID $innerPid /T /F 2>&1 | Out-Null
        $exitCode = $EXIT_TIMEOUT
        throw "the run as $UserName did not finish within $TimeoutSeconds s"
    }

    $innerResult = Read-InnerResult $innerResultFile
    $result.inner = $innerResult
    if ($null -eq $code -and $innerResult) { $code = [int]$innerResult.exitCode }
    if (-not $innerResult) {
        # Nothing ran as the user (for example it could not read the script): fall back.
        $exitCode = $EXIT_CANNOT_START
        throw ("the process as {0} exited (code {1}) without writing {2}" -f $UserName, $code, $innerResultFile)
    }
    if ($null -eq $code) { $code = 1 }
    $result.exitCode = $code
    $exitCode = $code
    $result.stage = 'finished'

    $userProfile = Get-CimInstance Win32_UserProfile -ErrorAction SilentlyContinue | Where-Object { $_.SID -eq $sid }
    if ($userProfile) { $result.profileDir = [string]$userProfile.LocalPath }
    $result.ok = ($code -eq 0)
}
catch {
    $result.error = $_.Exception.Message
    Write-Host ("run as local user failed at stage {0}: {1}" -f $result.stage, $result.error)
}

Write-SmokeResult -Result $result -Path $ResultFile
exit $exitCode
