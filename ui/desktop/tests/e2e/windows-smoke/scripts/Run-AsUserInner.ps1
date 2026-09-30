<#
.SYNOPSIS
    Inner half of Invoke-AsLocalUser.ps1: runs as the new local user (task 13.6, 7.4).

.DESCRIPTION
    Installs ModelForge for the current user at the default per-user location
    (%LOCALAPPDATA%\Programs\ModelForge, so inside a profile path with Chinese characters and a
    space) and runs the smoke specs with Playwright.

    -EnvFile is a UTF-8 JSON file written by the workflow:

      {
        "installer":  "<NSIS installer>",
        "harnessDir": "<directory with node_modules and tests/e2e>",
        "node":       "<node.exe of the harness>",
        "specs":      ["windows-installed-smoke", "windows-installed-uninstall"],
        "resultsDir": "<writable directory for reports and evidence>",
        "env":        { "MODELFORGE_SMOKE_APP_PATH": "...", "MODELFORGE_STUB_PORT": "47372", ... }
      }

    The profile variables (USERPROFILE, APPDATA, LOCALAPPDATA, TEMP) are taken from the logon
    token, not inherited from the administrator that started this process, and everything
    started from here inherits them: Playwright, the app, and the helpers the uninstall spec
    runs, so the NSIS uninstaller removes (or keeps) this user's own data folders. Then
    MODELFORGE_INSTALL_DIR, MODELFORGE_INSTALLER and the results, evidence and state directories
    are set for the harness.

    Writes <resultsDir>\inner-result.json. Exit codes: 0 specs passed, 1 specs failed,
    2 setup or install failed.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $EnvFile,
    # Below the -TimeoutSeconds the workflow gives Invoke-AsLocalUser.ps1.
    [int] $TimeoutSeconds = 6300
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'SmokeCommon.ps1')

$EXIT_SETUP_FAILED = 2

$result = [ordered]@{
    ok           = $false
    stage        = 'started'
    identity     = ''
    userProfile  = ''
    appData      = ''
    localAppData = ''
    installDir   = ''
    install      = $null
    exitCode     = $EXIT_SETUP_FAILED
    stdoutLog    = ''
    stderrLog    = ''
    error        = $null
}
$resultFile = ''
$logFile = ''

function Write-InnerLog([string] $message) {
    $line = ('{0} {1}' -f (Get-Date).ToString('o'), $message)
    Write-Host $line
    if ($script:logFile) {
        [System.IO.File]::AppendAllText($script:logFile, $line + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
    }
}

function Set-ProcessEnv([string] $name, [string] $value) {
    [Environment]::SetEnvironmentVariable($name, $value, 'Process')
}

try {
    $spec = Get-Content -LiteralPath $EnvFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $resultsDir = [string]$spec.resultsDir
    New-Item -ItemType Directory -Force -Path $resultsDir | Out-Null
    $resultFile = Join-Path $resultsDir 'inner-result.json'
    $logFile = Join-Path $resultsDir 'inner.log'
    # Written first, so the outer script knows this process ran as the user at all.
    Write-SmokeResult -Result $result -Path $resultFile

    # 1. Profile variables from the logon token.
    $result.stage = 'environment'
    $result.identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $userProfile = [Environment]::GetFolderPath('UserProfile')
    $appData = [Environment]::GetFolderPath('ApplicationData')
    $localAppData = [Environment]::GetFolderPath('LocalApplicationData')
    if (-not $userProfile -or -not $appData -or -not $localAppData) {
        throw 'the user profile is not loaded (no UserProfile/AppData folder)'
    }
    $temp = Join-Path $localAppData 'Temp'
    New-Item -ItemType Directory -Force -Path $temp | Out-Null
    Set-ProcessEnv 'USERPROFILE' $userProfile
    Set-ProcessEnv 'HOMEDRIVE' $userProfile.Substring(0, 2)
    Set-ProcessEnv 'HOMEPATH' $userProfile.Substring(2)
    Set-ProcessEnv 'APPDATA' $appData
    Set-ProcessEnv 'LOCALAPPDATA' $localAppData
    Set-ProcessEnv 'TEMP' $temp
    Set-ProcessEnv 'TMP' $temp
    Set-ProcessEnv 'USERNAME' ([Environment]::UserName)
    $result.userProfile = $userProfile
    $result.appData = $appData
    $result.localAppData = $localAppData
    Write-InnerLog ("running as {0}, profile {1}" -f $result.identity, $userProfile)

    # 2. Harness variables from the workflow, then the ones that depend on this user.
    if ($spec.env) {
        foreach ($property in $spec.env.PSObject.Properties) {
            Set-ProcessEnv $property.Name ([string]$property.Value)
        }
    }
    $installDir = Join-Path $localAppData 'Programs\ModelForge'
    $result.installDir = $installDir
    Set-ProcessEnv 'MODELFORGE_INSTALL_DIR' $installDir
    Set-ProcessEnv 'MODELFORGE_INSTALLER' ([string]$spec.installer)
    Set-ProcessEnv 'MODELFORGE_SMOKE_SCENARIO' 'cn-user'
    Set-ProcessEnv 'MODELFORGE_SMOKE_RESULTS_DIR' $resultsDir
    Set-ProcessEnv 'MODELFORGE_SMOKE_EVIDENCE_DIR' (Join-Path $resultsDir 'evidence')
    Set-ProcessEnv 'MODELFORGE_SMOKE_STATE_DIR' (Join-Path $resultsDir 'state')
    Set-ProcessEnv 'CI' '1'
    Set-ProcessEnv 'FORCE_COLOR' '0'

    # 3. Per-user install at the default location.
    $result.stage = 'install'
    $installResult = Join-Path $resultsDir 'evidence\Install-ModelForge-cn-user.json'
    & (Join-Path $PSScriptRoot 'Install-ModelForge.ps1') -Installer ([string]$spec.installer) `
        -InstallDir $installDir -ResultFile $installResult
    $installCode = $LASTEXITCODE
    $result.install = Get-Content -LiteralPath $installResult -Raw -Encoding UTF8 -ErrorAction SilentlyContinue |
        ConvertFrom-Json -ErrorAction SilentlyContinue
    if ($installCode -ne 0) {
        throw "Install-ModelForge.ps1 exited with $installCode"
    }
    Write-InnerLog ("installed to {0}" -f $installDir)

    # 4. Playwright. Output goes to files: this process has no console the workflow can read,
    # and redirecting to files keeps the UTF-8 bytes Node writes.
    $result.stage = 'playwright'
    $harnessDir = [string]$spec.harnessDir
    $cli = Join-Path $harnessDir 'node_modules\@playwright\test\cli.js'
    if (-not (Test-Path -LiteralPath $cli)) { throw "Playwright CLI not found at $cli" }
    $specs = @($spec.specs | ForEach-Object { [string]$_ })
    $argumentLine = ('"{0}" test -c "tests\e2e\windows-smoke\playwright.config.ts" {1}' -f $cli, ($specs -join ' '))
    $result.stdoutLog = Join-Path $resultsDir 'playwright.out.log'
    $result.stderrLog = Join-Path $resultsDir 'playwright.err.log'
    Write-InnerLog ("{0} {1}" -f $spec.node, $argumentLine)
    $process = Start-Process -FilePath ([string]$spec.node) -ArgumentList $argumentLine -WorkingDirectory $harnessDir `
        -NoNewWindow -PassThru -RedirectStandardOutput $result.stdoutLog -RedirectStandardError $result.stderrLog
    $code = Wait-ProcessExit -Process $process -TimeoutSeconds $TimeoutSeconds
    if ($null -eq $code) {
        & taskkill.exe /PID $process.Id /T /F 2>&1 | Out-Null
        throw "Playwright did not finish within $TimeoutSeconds s"
    }
    $result.stage = 'finished'
    $result.exitCode = $(if ($code -eq 0) { 0 } else { 1 })
    $result.ok = ($code -eq 0)
    Write-InnerLog ("Playwright exited with {0}" -f $code)
}
catch {
    $result.error = $_.Exception.Message
    # A Playwright run that could not finish counts as failed specs; anything earlier is setup.
    $result.exitCode = $(if ($result.stage -eq 'playwright') { 1 } else { $EXIT_SETUP_FAILED })
    Write-InnerLog ("inner run failed at stage {0}: {1}" -f $result.stage, $result.error)
}

if ($resultFile) {
    Write-SmokeResult -Result $result -Path $resultFile
}
exit ([int]$result.exitCode)
