<#
.SYNOPSIS
    Uninstalls ModelForge through its "Apps & features" entry (task 13.6, requirement 7.10).

.DESCRIPTION
    -Mode Silent  runs the quiet uninstall string (/S): no question is asked, data is kept.
    -Mode Keep    runs the normal uninstaller and answers the keep-data question with "Yes".
    -Mode Remove  runs the normal uninstaller and answers it with "No".

    The interactive runs press the buttons of whatever window the uninstaller shows, in the
    order it shows them (UninstallerDialogs.ps1 has the details):

      1. "Are you sure you want to uninstall ModelForge?" [OK] [Cancel]: the one-click
         uninstaller of electron-builder asks this first -> OK (IDOK 1). The assisted uninstaller
         shows its wizard instead -> Next / Uninstall (1) on each page.
      2. The keep-data question of customUnInstall (ui/desktop/build/installer.nsh), [Yes] [No]:
         "Yes" keeps the data, "No" removes it -> Yes (IDYES 6) for Keep, No (IDNO 7) for Remove.
      3. The end: the one-click uninstaller closes by itself, the wizard's last page is closed
         with Finish (1).

    Windows are recognised by their controls and buttons by their control id, never by text, so
    the installer language does not matter. The uninstaller copies itself to %TEMP% and runs
    from there (Un_A.exe), so the windows belong to that process; a window counts as the
    uninstaller's when it belongs to an uninstaller process or its title names ModelForge.

    The result records every press (clicks, steps), the windows seen, the flow (one-click or
    assisted), and on a timeout the window it was waiting at, with its title, buttons and text.
    It also records what is left (program files, "Apps & features" entry, shortcuts). The
    uninstaller inherits this script's environment and removes the data folders under the
    APPDATA / LOCALAPPDATA it finds there (customUnInstall in build/installer.nsh), so the result
    also records those two variables, the account the script ran as and whether each of the four
    data folders exists afterwards. The caller starts the script with the profile of the user
    under test and checks the folders itself as well.

    Exit codes: 0 finished, 1 failed, 3 UI Automation could not reach or press the uninstaller's
    windows (the keep/remove prompt is then unverified, not passed).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('Silent', 'Keep', 'Remove')][string] $Mode,
    [string] $EvidenceDir = '',
    [string] $ResultFile = '',
    [int] $TimeoutSeconds = 300
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'SmokeCommon.ps1')
. (Join-Path $PSScriptRoot 'UninstallerDialogs.ps1')

$EXIT_UIA_UNAVAILABLE = 3

$result = [ordered]@{
    ok                       = $false
    mode                     = $Mode
    uiaAvailable             = $false
    # finished | timeout | no-window | unexpected-dialog | no-reaction | cannot-click (interactive)
    outcome                  = ''
    # one-click: an OK/Cancel confirmation first; assisted: the NSIS wizard
    flow                     = ''
    confirmSeen              = $false
    confirmText              = ''
    promptSeen               = $false
    promptText               = ''
    answered                 = ''
    dialogs                  = @()
    clicks                   = @()
    steps                    = @()
    openWindows              = @()
    uiaErrors                = @()
    leftoverUninstallers     = @()
    killedUninstallers       = @()
    screenshots              = @()
    installDir               = ''
    installDirExists         = $false
    exePresent               = $false
    remainingFiles           = @()
    uninstallEntryPresent    = $false
    startMenuShortcut        = ''
    startMenuShortcutPresent = $false
    desktopShortcut          = ''
    desktopShortcutPresent   = $false
    identity                 = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    userProfile              = [string]$env:USERPROFILE
    appData                  = [string]$env:APPDATA
    localAppData             = [string]$env:LOCALAPPDATA
    dataDirs                 = @()
    error                    = $null
}
$exitCode = 1

# The folders "remove" deletes (build/installer.nsh), under this environment's profile.
function Get-DataDirs {
    $dirs = @()
    if ($env:APPDATA) {
        $dirs += (Join-Path $env:APPDATA 'ModelForge')
        $dirs += (Join-Path $env:APPDATA 'Block\goose')
    }
    if ($env:LOCALAPPDATA) {
        $dirs += (Join-Path $env:LOCALAPPDATA 'modelforge-updater')
        $dirs += (Join-Path $env:LOCALAPPDATA 'Block\goose')
    }
    return @($dirs | ForEach-Object {
            [ordered]@{ path = $_; exists = (Test-Path -LiteralPath $_) }
        })
}

if (-not $EvidenceDir) {
    $EvidenceDir = Join-Path $env:TEMP 'modelforge-uninstall-evidence'
}
New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null

function Add-Screenshot([string] $name) {
    $file = Join-Path $EvidenceDir ("{0}-{1}.png" -f $Mode.ToLowerInvariant(), $name)
    if (Save-Screenshot -Path $file) {
        $script:result.screenshots += $file
    }
}

function Test-UninstallFinished([string] $exe) {
    $gone = -not (Test-Path -LiteralPath $exe)
    $entryGone = $null -eq (Get-ModelForgeUninstallEntry)
    $running = (Get-UninstallerProcesses).Count -gt 0
    return ($gone -and $entryGone -and -not $running)
}

# What is not done yet, for the error message.
function Get-UnfinishedParts([string] $exe) {
    $parts = @()
    if (Test-Path -LiteralPath $exe) { $parts += "$exe still present" }
    if ($null -ne (Get-ModelForgeUninstallEntry)) { $parts += '"Apps & features" entry still present' }
    $running = @(Get-UninstallerProcesses | ForEach-Object { '{0} (pid {1})' -f $_.ProcessName, $_.Id })
    if ($running.Count -gt 0) { $parts += ('uninstaller still running: {0}' -f ($running -join ', ')) }
    return ($parts -join '; ')
}

function Stop-Uninstallers([string] $field) {
    foreach ($process in (Get-UninstallerProcesses)) {
        $script:result[$field] += ('{0} (pid {1})' -f $process.ProcessName, $process.Id)
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
}

# The uninstaller's windows: those of its processes (the copy it runs from %TEMP% included), or
# any dialog whose title names ModelForge.
function Test-UninstallerWindow($info) {
    if ($info.title -match 'ModelForge') { return $true }
    $pids = @(Get-UninstallerProcesses | ForEach-Object { $_.Id })
    return ($pids -contains $info.pid)
}

# --- main -------------------------------------------------------------------------------------

try {
    $entry = Get-ModelForgeUninstallEntry
    if (-not $entry) {
        throw 'no ModelForge entry under Apps & features (HKCU/HKLM Uninstall keys)'
    }
    $command = Split-CommandLine -Line $entry.UninstallString
    $installDir = $entry.InstallLocation
    if (-not $installDir) { $installDir = Split-Path -Parent $command.Exe }
    $result.installDir = $installDir
    $exe = Join-Path $installDir 'ModelForge.exe'
    Stop-ModelForgeProcesses -InstallDir $installDir
    # An uninstaller left over from an earlier run would hold its dialog open and the files busy.
    Stop-Uninstallers 'leftoverUninstallers'
    if ($result.leftoverUninstallers.Count -gt 0) {
        Write-Host ("stopped leftover uninstallers: {0}" -f ($result.leftoverUninstallers -join ', '))
        Start-Sleep -Seconds 1
    }

    if ($Mode -eq 'Silent') {
        $quiet = $entry.QuietUninstallString
        if (-not $quiet) { $quiet = $entry.UninstallString + ' /S' }
        $silent = Split-CommandLine -Line $quiet
        Write-Host ("running {0} {1}" -f $silent.Exe, $silent.Args)
        $process = Start-Process -FilePath $silent.Exe -ArgumentList $silent.Args -PassThru
        $null = Wait-ProcessExit -Process $process -TimeoutSeconds $TimeoutSeconds
        # The uninstaller restarts itself from %TEMP%; wait for that copy too. A silent run
        # must never show a dialog, so any ModelForge dialog seen here is reported.
        $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
        while ((Get-Date) -lt $deadline -and -not (Test-UninstallFinished $exe)) {
            Start-Sleep -Milliseconds 500
        }
        try {
            $root = Initialize-UninstallerUi
            $result.uiaAvailable = $true
            foreach ($window in (Get-ChildrenByClass $root '#32770')) {
                $info = Get-DialogInfo $window
                if (-not (Test-UninstallerWindow $info)) { continue }
                $result.dialogs += ("{0}: {1}" -f $info.role, $info.title)
                $result.openWindows += (Get-DialogSummary $info)
                if ($info.role -eq 'keep-data-question') {
                    $result.promptSeen = $true
                    $result.promptText = $info.text
                }
            }
        }
        catch {
            Write-Host ("UI Automation check skipped: {0}" -f $_.Exception.Message)
        }
        if (-not (Test-UninstallFinished $exe)) {
            Add-Screenshot 'timeout'
            throw ("silent uninstall did not finish within {0} s: {1}" -f $TimeoutSeconds, (Get-UnfinishedParts $exe))
        }
        $result.outcome = 'finished'
        $exitCode = 0
    }
    else {
        try {
            $root = Initialize-UninstallerUi
            $result.uiaAvailable = $true
        }
        catch {
            $result.error = "UI Automation unavailable: $($_.Exception.Message)"
            $exitCode = $EXIT_UIA_UNAVAILABLE
            throw
        }

        Write-Host ("running {0} {1}" -f $command.Exe, $command.Args)
        if ($command.Args) {
            $null = Start-Process -FilePath $command.Exe -ArgumentList $command.Args -PassThru
        }
        else {
            $null = Start-Process -FilePath $command.Exe -PassThru
        }

        $run = Invoke-UninstallerDialogs -Root $root -Mode $Mode -TimeoutSeconds $TimeoutSeconds `
            -IsOurWindow { param($info) Test-UninstallerWindow $info } `
            -IsFinished { Test-UninstallFinished $exe } `
            -OnScreenshot { param($name) Add-Screenshot $name }
        # The state is the function's last output; anything a callback wrote comes before it.
        if ($run -isnot [System.Collections.IDictionary]) { $run = @($run)[-1] }
        foreach ($key in 'outcome', 'flow', 'confirmSeen', 'confirmText', 'promptSeen', 'promptText', 'answered',
            'dialogs', 'clicks', 'steps', 'openWindows', 'uiaErrors') {
            $result[$key] = $run[$key]
        }
        $clicks = $result.clicks -join ' -> '
        if (-not $clicks) { $clicks = 'none' }
        Add-Screenshot 'end'

        if ($run.outcome -ne 'finished') {
            $what = $run.message
            if ($run.outcome -eq 'timeout') {
                $what = ('did not finish within {0} s; {1}; {2}' -f $TimeoutSeconds, $run.message, (Get-UnfinishedParts $exe))
            }
            elseif ($run.outcome -eq 'no-window') {
                $what = ('no uninstaller window was reachable through UI Automation within 60 s; {0}' -f (Get-UnfinishedParts $exe))
            }
            Stop-Uninstallers 'killedUninstallers'
            if ($run.outcome -eq 'no-window' -or $run.outcome -eq 'cannot-click') {
                $exitCode = $EXIT_UIA_UNAVAILABLE
            }
            throw ("interactive uninstall ({0}) {1} (clicks: {2})" -f $run.outcome, $what, $clicks)
        }
        if (-not $result.promptSeen) {
            $hint = ''
            if ($result.flow -eq 'one-click') {
                $hint = ' (one-click uninstaller: after its OK/Cancel confirmation electron-builder uninstalls silently, so customUnInstall skips the question)'
            }
            throw ("the uninstaller finished without asking whether to keep the data{0} (clicks: {1})" -f $hint, $clicks)
        }
        $exitCode = 0
    }
}
catch {
    if (-not $result.error) { $result.error = $_.Exception.Message }
    Write-Host ("uninstall failed: {0}" -f $result.error)
}

# What is left, whatever happened above.
try {
    $dir = $result.installDir
    if ($dir) {
        $result.installDirExists = Test-Path -LiteralPath $dir
        $result.exePresent = Test-Path -LiteralPath (Join-Path $dir 'ModelForge.exe')
        if ($result.installDirExists) {
            $result.remainingFiles = @(Get-ChildItem -LiteralPath $dir -Recurse -File -ErrorAction SilentlyContinue |
                Select-Object -First 50 | ForEach-Object { $_.FullName })
        }
    }
    $result.uninstallEntryPresent = $null -ne (Get-ModelForgeUninstallEntry)
    $shortcuts = Get-ModelForgeShortcuts
    $result.startMenuShortcut = $shortcuts.StartMenu
    $result.startMenuShortcutPresent = Test-Path -LiteralPath $shortcuts.StartMenu
    $result.desktopShortcut = $shortcuts.Desktop
    $result.desktopShortcutPresent = Test-Path -LiteralPath $shortcuts.Desktop
    $result.dataDirs = @(Get-DataDirs)
}
catch {
    Write-Host ("post-uninstall inspection failed: {0}" -f $_.Exception.Message)
}

$result.ok = ($exitCode -eq 0)
Write-SmokeResult -Result $result -Path $ResultFile
exit $exitCode
