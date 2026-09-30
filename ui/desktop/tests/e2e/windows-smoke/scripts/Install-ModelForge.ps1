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
    [int] $TimeoutSeconds = 900
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
    # Installer runs that crashed before the one whose exit code is reported.
    crashes                  = @()
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
    # Under a freshly created local user the installer once crashed in its NSIS System plug-in
    # (access violation in %TEMP%\ns*.tmp\System.dll, exit 0xC0000005) before writing anything,
    # while the same installer passed for that user in other runs. A crash like that is run once
    # more; it stays in the result and in the summary, so it is never passed over silently.
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
        if ($attempt -lt 2 -and $crashCodes -contains [int]$code) {
            $crash = 'attempt {0} exited with 0x{1:X8}' -f $attempt, [int]$code
            Write-Host ("installer crashed: {0}; running it again" -f $crash)
            $result.crashes += $crash
            Stop-ModelForgeProcesses -InstallDir $InstallDir
            Start-Sleep -Seconds 5
            continue
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
        throw "installer exited with code $code"
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
