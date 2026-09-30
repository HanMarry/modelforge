<#
.SYNOPSIS
    Uninstalls ModelForge through its "Apps & features" entry (task 13.6, requirement 7.10).

.DESCRIPTION
    -Mode Silent  runs the quiet uninstall string (/S): no question is asked, data is kept.
    -Mode Keep    runs the normal uninstaller and answers the keep-data question with "Yes".
    -Mode Remove  runs the normal uninstaller and answers it with "No".

    The interactive runs are driven with UI Automation. Buttons are found by their Win32
    control id, so the installer language does not matter: 1 = Next/Uninstall/Finish in the
    NSIS wizard, 6 = Yes and 7 = No in the MessageBox of `customUnInstall`
    (ui/desktop/build/installer.nsh).

    The script reports what it saw and what is left (program files, "Apps & features" entry,
    shortcuts). The uninstaller inherits this script's environment and removes the data folders
    under the APPDATA / LOCALAPPDATA it finds there (customUnInstall in build/installer.nsh), so
    the result also records those two variables, the account the script ran as and whether each
    of the four data folders exists afterwards. The caller starts the script with the profile of
    the user under test and checks the folders itself as well.

    Exit codes: 0 finished, 1 failed, 3 UI Automation could not reach the uninstaller dialogs
    (the keep/remove prompt is then unverified, not passed).
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

$EXIT_UIA_UNAVAILABLE = 3

$result = [ordered]@{
    ok                       = $false
    mode                     = $Mode
    uiaAvailable             = $false
    promptSeen               = $false
    promptText               = ''
    answered                 = ''
    dialogs                  = @()
    clicks                   = @()
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

# --- UI Automation helpers ------------------------------------------------------------------

function Initialize-Uia {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    return [System.Windows.Automation.AutomationElement]::RootElement
}

function Find-ButtonById($element, [string] $id) {
    $byId = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::AutomationIdProperty, $id)
    $isButton = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Button)
    $condition = New-Object System.Windows.Automation.AndCondition($byId, $isButton)
    return $element.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
}

function Get-DialogText($element) {
    $isText = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Text)
    $texts = $element.FindAll([System.Windows.Automation.TreeScope]::Descendants, $isText)
    $parts = @()
    foreach ($text in $texts) {
        $name = $text.Current.Name
        if ($name) { $parts += $name }
    }
    return ($parts -join "`n")
}

function Invoke-Element($element) {
    $pattern = $null
    if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref] $pattern)) {
        $pattern.Invoke()
        return $true
    }
    return $false
}

# Top-level dialogs (#32770) of the uninstaller: its title names ModelForge, or it belongs to
# one of the uninstaller processes.
function Get-UninstallerDialogs($root) {
    $isDialog = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ClassNameProperty, '#32770')
    $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $isDialog)
    $pids = @(Get-UninstallerProcesses | ForEach-Object { $_.Id })
    $found = @()
    foreach ($window in $windows) {
        $title = [string]$window.Current.Name
        if ($title -match 'ModelForge' -or $pids -contains $window.Current.ProcessId) {
            $found += $window
        }
    }
    return $found
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
            $root = Initialize-Uia
            $result.uiaAvailable = $true
            foreach ($dialog in (Get-UninstallerDialogs $root)) {
                $result.dialogs += [string]$dialog.Current.Name
                if ((Find-ButtonById $dialog '6') -and (Find-ButtonById $dialog '7')) {
                    $result.promptSeen = $true
                    $result.promptText = Get-DialogText $dialog
                }
            }
        }
        catch {
            Write-Host ("UI Automation check skipped: {0}" -f $_.Exception.Message)
        }
        if (-not (Test-UninstallFinished $exe)) {
            Add-Screenshot 'timeout'
            throw "silent uninstall did not finish within $TimeoutSeconds s"
        }
        $exitCode = 0
    }
    else {
        try {
            $root = Initialize-Uia
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

        $started = Get-Date
        $deadline = $started.AddSeconds($TimeoutSeconds)
        $sawDialog = $false
        while ((Get-Date) -lt $deadline) {
            $dialogs = @(Get-UninstallerDialogs $root)
            foreach ($dialog in $dialogs) {
                try {
                    $title = [string]$dialog.Current.Name
                    if (-not $sawDialog) { Add-Screenshot 'first-dialog' }
                    $sawDialog = $true
                    if ($result.dialogs -notcontains $title) { $result.dialogs += $title }

                    $yes = Find-ButtonById $dialog '6'
                    $no = Find-ButtonById $dialog '7'
                    if ($yes -and $no) {
                        # The keep-data question from customUnInstall.
                        $result.promptSeen = $true
                        $result.promptText = Get-DialogText $dialog
                        Add-Screenshot 'prompt'
                        if ($Mode -eq 'Keep') {
                            $target = $yes; $answer = 'yes'
                        }
                        else {
                            $target = $no; $answer = 'no'
                        }
                        if (Invoke-Element $target) {
                            $result.answered = $answer
                            $result.clicks += ("{0}: {1}" -f $title, $answer)
                        }
                        Start-Sleep -Milliseconds 800
                        continue
                    }

                    $next = Find-ButtonById $dialog '1'
                    if ($next -and $next.Current.IsEnabled) {
                        $label = [string]$next.Current.Name
                        if (Invoke-Element $next) {
                            $result.clicks += ("{0}: {1}" -f $title, $label)
                        }
                        Start-Sleep -Milliseconds 800
                    }
                }
                catch {
                    # The dialog closed between finding and using it; look again.
                    Start-Sleep -Milliseconds 300
                }
            }

            if ($sawDialog -and $dialogs.Count -eq 0 -and (Test-UninstallFinished $exe)) {
                break
            }
            if (-not $sawDialog -and ((Get-Date) - $started).TotalSeconds -gt 60) {
                Add-Screenshot 'no-dialog'
                Get-UninstallerProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
                $result.error = 'no uninstaller dialog was reachable through UI Automation within 60 s'
                $exitCode = $EXIT_UIA_UNAVAILABLE
                throw $result.error
            }
            Start-Sleep -Milliseconds 500
        }

        Add-Screenshot 'end'
        if (-not (Test-UninstallFinished $exe)) {
            Get-UninstallerProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
            throw "interactive uninstall did not finish within $TimeoutSeconds s (clicks: $($result.clicks -join '; '))"
        }
        if (-not $result.promptSeen) {
            throw 'the uninstaller finished without asking whether to keep the data'
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
