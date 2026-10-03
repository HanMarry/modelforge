<#
.SYNOPSIS
    Repeated fresh per-user silent installs, as the current (new local) user (task 13.6).

.DESCRIPTION
    Started by Invoke-AsLocalUser.ps1 -InnerScript Run-InstallLoop.ps1 for the installer crash
    check of modelforge-windows-smoke.yml. Each round runs every installer of the list once, in
    turn (the order alternates between rounds), as a user would install ModelForge for the first
    time: `<installer> /S`, no /D, so the installer picks its own per-user default directory.
    No crashed install is run again. After a successful install the program is removed with
    Uninstall-ModelForge.ps1 -Mode Silent, which also deletes the installer's registry key, so
    the next round is a fresh install again; each round records whether it was.

    -EnvFile is a UTF-8 JSON file:

      {
        "phase":      "natural",
        "rounds":     20,
        "installers": [ { "label": "baseline", "path": "<installer>" }, { "label": "candidate", ... } ],
        "resultsDir": "<writable directory>"
      }

    Writes <resultsDir>\inner-result.json (the file Invoke-AsLocalUser.ps1 reads back) after
    every install, so a timeout keeps what ran.
    Exit codes: 0 the loop ran (crashes are data, judged by the caller), 2 setup failed.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $EnvFile,
    [int] $InstallTimeoutSeconds = 1200
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'SmokeCommon.ps1')

$result = [ordered]@{
    ok           = $false
    stage        = 'started'
    phase        = ''
    identity     = ''
    userProfile  = ''
    localAppData = ''
    appGuid      = ''
    runs         = @()
    exitCode     = 2
    error        = $null
}
$resultFile = ''

function Set-ProcessEnv([string] $name, [string] $value) {
    [Environment]::SetEnvironmentVariable($name, $value, 'Process')
}

function Save-Result {
    if ($script:resultFile) { Write-SmokeResult -Result $script:result -Path $script:resultFile | Out-Null }
}

# InstallLocation under HKCU\Software\<app guid>, the key electron-builder's installer reads to
# tell an upgrade from a fresh install ('' when there is none).
function Get-InstallLocation([string] $guid) {
    if (-not $guid) { return '' }
    $key = "HKCU:\Software\$guid"
    if (-not (Test-Path -LiteralPath $key)) { return '' }
    return [string](Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue).InstallLocation
}

try {
    $spec = Get-Content -LiteralPath $EnvFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $resultsDir = [string]$spec.resultsDir
    New-Item -ItemType Directory -Force -Path $resultsDir | Out-Null
    $resultFile = Join-Path $resultsDir 'inner-result.json'
    $result.phase = [string]$spec.phase
    Save-Result

    # Profile variables from the logon token (see Run-AsUserInner.ps1); the installer and the
    # uninstaller inherit them.
    $result.stage = 'environment'
    $result.identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $userProfile = [Environment]::GetFolderPath('UserProfile')
    $appData = [Environment]::GetFolderPath('ApplicationData')
    $localAppData = [Environment]::GetFolderPath('LocalApplicationData')
    if (-not $userProfile -or -not $appData -or -not $localAppData) { throw 'the user profile is not loaded' }
    $temp = Join-Path $localAppData 'Temp'
    New-Item -ItemType Directory -Force -Path $temp | Out-Null
    Set-ProcessEnv 'USERPROFILE' $userProfile
    Set-ProcessEnv 'APPDATA' $appData
    Set-ProcessEnv 'LOCALAPPDATA' $localAppData
    Set-ProcessEnv 'TEMP' $temp
    Set-ProcessEnv 'TMP' $temp
    Set-ProcessEnv 'USERNAME' ([Environment]::UserName)
    $result.userProfile = $userProfile
    $result.localAppData = $localAppData

    $installers = @($spec.installers)
    $rounds = [int]$spec.rounds
    $uninstallScript = Join-Path $PSScriptRoot 'Uninstall-ModelForge.ps1'
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $result.stage = 'loop'
    for ($round = 1; $round -le $rounds; $round++) {
        # A copy, reversed every second round so neither installer always runs first.
        $order = @($installers)
        if ($round % 2 -eq 0) { [array]::Reverse($order) }
        foreach ($installer in $order) {
            $run = [ordered]@{
                phase            = $result.phase
                round            = $round
                label            = [string]$installer.label
                startedAt        = (Get-Date).ToUniversalTime().ToString('o')
                freshBefore      = $true
                leftoverBefore   = ''
                exitCode         = $null
                exitHex          = ''
                crashed          = $false
                durationMs       = 0
                installDir       = ''
                exePresent       = $false
                uninstallOk      = $null
                uninstallError   = ''
                error            = $null
            }
            try {
                # A fresh install: no InstallLocation, no "Apps & features" entry.
                $before = Get-InstallLocation $result.appGuid
                $entryBefore = Get-ModelForgeUninstallEntry
                if ($before -or $entryBefore) {
                    $run.freshBefore = $false
                    $run.leftoverBefore = ('InstallLocation {0}; entry {1}' -f $before, [bool]$entryBefore)
                }
                $watch = [System.Diagnostics.Stopwatch]::StartNew()
                $process = Start-Process -FilePath ([string]$installer.path) -ArgumentList '/S' -PassThru
                $code = Wait-ProcessExit -Process $process -TimeoutSeconds $InstallTimeoutSeconds
                $run.durationMs = [int]$watch.ElapsedMilliseconds
                if ($null -eq $code) {
                    & taskkill.exe /PID $process.Id /T /F 2>&1 | Out-Null
                    throw ("installer did not finish within {0} s" -f $InstallTimeoutSeconds)
                }
                $run.exitCode = [int]$code
                $run.exitHex = ('0x{0:X8}' -f [int]$code)
                $run.crashed = @(-1073741819, -1073740791) -contains [int]$code

                $entry = Get-ModelForgeUninstallEntry
                if ($entry) {
                    if (-not $result.appGuid) { $result.appGuid = Split-Path -Leaf $entry.KeyPath }
                    $command = Split-CommandLine -Line $entry.UninstallString
                    $run.installDir = $(if ($entry.InstallLocation) { $entry.InstallLocation } else { Split-Path -Parent $command.Exe })
                    $run.exePresent = Test-Path -LiteralPath (Join-Path $run.installDir 'ModelForge.exe')
                    $uninstallResult = Join-Path $resultsDir ('uninstall-{0}-{1:D2}-{2}.json' -f $result.phase, $round, $run.label)
                    $output = & $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $uninstallScript `
                        -Mode Silent -EvidenceDir (Join-Path $resultsDir 'uninstall-evidence') -ResultFile $uninstallResult 2>&1
                    $run.uninstallOk = ($LASTEXITCODE -eq 0)
                    if (-not $run.uninstallOk) {
                        $run.uninstallError = (($output | Select-Object -Last 5) -join ' ')
                    }
                }
                elseif ($run.exitCode -eq 0) {
                    throw 'the installer exited with 0 but left no "Apps & features" entry'
                }
            }
            catch {
                $run.error = $_.Exception.Message
            }
            $result.runs += $run
            Write-Host ("[{0} round {1} {2}] exit {3}{4}, {5} ms, dir {6}, uninstall {7}{8}" -f $run.phase, $round, $run.label,
                $run.exitHex, $(if ($run.crashed) { ' (crash)' } else { '' }), $run.durationMs, $run.installDir,
                $run.uninstallOk, $(if ($run.error) { '; error: ' + $run.error } else { '' }))
            Save-Result
        }
    }
    $result.stage = 'finished'
    $result.ok = $true
    $result.exitCode = 0
}
catch {
    $result.error = $_.Exception.Message
    Write-Host ("install loop failed at stage {0}: {1}" -f $result.stage, $result.error)
}

Save-Result
exit ([int]$result.exitCode)
