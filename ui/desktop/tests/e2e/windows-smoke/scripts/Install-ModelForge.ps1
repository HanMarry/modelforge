<#
.SYNOPSIS
    Silent per-user install of the ModelForge NSIS installer (task 13.6, requirement 7.4/7.5).

.DESCRIPTION
    Runs `<installer> /S "/D=<InstallDir>"`. Over an existing installation this is the upgrade path:
    the installer runs the installed uninstaller with --updated (build/installer.nsh then keeps
    the data) and writes the new files. Afterwards it checks the executable, the "Apps & features"
    entry and the shortcuts, and writes a JSON result.

    Exit code 0 when the installer succeeded and ModelForge.exe is in place, 1 otherwise.

.EXAMPLE
    powershell -File Install-ModelForge.ps1 -Installer "D:\a\ModelForge Setup 1.50.0.exe" -InstallDir "C:\x y\ModelForge"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $Installer,
    [Parameter(Mandatory = $true)][string] $InstallDir,
    [string] $ResultFile = '',
    [int] $TimeoutSeconds = 900,
    # How often an installer that crashed is run again. 0 (the default): a crash fails the
    # install. The workflow sets MODELFORGE_SMOKE_INSTALLER_CRASH_RETRIES only for runs against
    # packages built before build/modelforge-multiuser.nsh, whose installers crash at random.
    [int] $CrashRetries = -1
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'SmokeCommon.ps1')

$result = [ordered]@{
    ok                       = $false
    exitCode                 = $null
    installer                = $Installer
    installDir               = $InstallDir
    exe                      = (Join-Path $InstallDir 'ModelForge.exe')
    exeWriteTimeUtc          = ''
    uninstallEntryPresent    = $false
    displayName              = ''
    displayVersion           = ''
    publisher                = ''
    installLocation          = ''
    uninstallString          = ''
    quietUninstallString     = ''
    startMenuShortcut        = ''
    startMenuShortcutPresent = $false
    desktopShortcut          = ''
    desktopShortcutPresent   = $false
    durationMs               = 0
    # Installer runs that crashed, the last one included when it ended the install.
    crashes                  = @()
    # Reruns allowed after a crash (-CrashRetries) and reruns made.
    crashRetries             = 0
    reruns                   = 0
    error                    = $null
}

try {
    if (-not (Test-Path -LiteralPath $Installer)) {
        throw "installer not found: $Installer"
    }
    Stop-ModelForgeProcesses -InstallDir $InstallDir

    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    # The installer takes its directory from electron-builder's own parameter parser
    # (multiUser.nsh, StdUtils.GetParameter "D"), which overrides NSIS's native /D= and splits the
    # command line at spaces: an unquoted `/D=C:\a b\App` installed into `C:\a`. Quoting the whole
    # token keeps the path in one piece for that parser. A single argument string is passed to
    # CreateProcess unchanged.
    $argumentLine = '/S "/D=' + $InstallDir + '"'
    # Installers built before build/modelforge-multiuser.nsh crash at random on a fresh per-user
    # install (access violation in %TEMP%\ns*.tmp\System.dll, exit 0xC0000005, in .onInit before
    # writing anything; see that file). A crash fails the install unless -CrashRetries allows
    # running it again; a rerun stays in the result and in the summary, never passed over.
    if ($CrashRetries -lt 0) {
        $CrashRetries = 0
        $fromEnv = 0
        if ([int]::TryParse([string]$env:MODELFORGE_SMOKE_INSTALLER_CRASH_RETRIES, [ref] $fromEnv) -and $fromEnv -gt 0) {
            $CrashRetries = $fromEnv
        }
    }
    $result.crashRetries = $CrashRetries
    $crashCodes = @(-1073741819, -1073740791)   # 0xC0000005, 0xC0000409
    $attempt = 0
    while ($true) {
        $attempt++
        Write-Host ("running {0} {1} (attempt {2})" -f $Installer, $argumentLine, $attempt)
        $process = Start-Process -FilePath $Installer -ArgumentList $argumentLine -PassThru
        $code = Wait-ProcessExit -Process $process -TimeoutSeconds $TimeoutSeconds
        if ($null -eq $code) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            throw "installer did not finish within $TimeoutSeconds s"
        }
        if ($crashCodes -contains [int]$code) {
            $crash = 'attempt {0} exited with 0x{1:X8}' -f $attempt, [int]$code
            $result.crashes += $crash
            if ($result.reruns -lt $CrashRetries) {
                Write-Host ("installer crashed: {0}; running it again" -f $crash)
                $result.reruns++
                Stop-ModelForgeProcesses -InstallDir $InstallDir
                Start-Sleep -Seconds 5
                continue
            }
            Write-Host ("installer crashed: {0}" -f $crash)
        }
        break
    }
    $result.exitCode = $code

    # The silent installer returns when it is done; allow a little slack for file flushes.
    for ($i = 0; $i -lt 60 -and -not (Test-Path -LiteralPath $result.exe); $i++) {
        Start-Sleep -Seconds 1
    }
    $result.durationMs = [int]$watch.ElapsedMilliseconds

    if (Test-Path -LiteralPath $result.exe) {
        $result.exeWriteTimeUtc = (Get-Item -LiteralPath $result.exe).LastWriteTimeUtc.ToString('o')
    }
    $entry = Get-ModelForgeUninstallEntry
    if ($entry) {
        $result.uninstallEntryPresent = $true
        $result.displayName = $entry.DisplayName
        $result.displayVersion = $entry.DisplayVersion
        $result.publisher = $entry.Publisher
        $result.installLocation = $entry.InstallLocation
        $result.uninstallString = $entry.UninstallString
        $result.quietUninstallString = $entry.QuietUninstallString
    }
    $shortcuts = Get-ModelForgeShortcuts
    $result.startMenuShortcut = $shortcuts.StartMenu
    $result.startMenuShortcutPresent = Test-Path -LiteralPath $shortcuts.StartMenu
    $result.desktopShortcut = $shortcuts.Desktop
    $result.desktopShortcutPresent = Test-Path -LiteralPath $shortcuts.Desktop

    if ($code -ne 0) {
        throw ("installer exited with code {0} (0x{0:X8}); reruns after a crash allowed: {1}" -f [int]$code, $CrashRetries)
    }
    if (-not (Test-Path -LiteralPath $result.exe)) {
        throw ("installed executable not found at {0}" -f $result.exe)
    }
    $result.ok = $true
}
catch {
    $result.error = $_.Exception.Message
    Write-Host ("install failed: {0}" -f $result.error)
}

Write-SmokeResult -Result $result -Path $ResultFile
if ($result.ok) { exit 0 } else { exit 1 }
