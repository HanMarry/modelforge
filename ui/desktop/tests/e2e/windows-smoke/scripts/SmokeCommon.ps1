# Shared helpers for the ModelForge Windows smoke scripts (spec mathmodel-parity-and-beyond,
# task 13.6). Dot-source it: . (Join-Path $PSScriptRoot 'SmokeCommon.ps1')
#
# Written for Windows PowerShell 5.1 (UI Automation and the NSIS installer are driven from
# there) and kept ASCII-only: 5.1 reads BOM-less scripts in the ANSI code page, so Chinese text
# arrives through parameters and JSON files instead of literals.

function Write-SmokeResult {
    param(
        [Parameter(Mandatory = $true)] $Result,
        [string] $Path
    )
    $json = $Result | ConvertTo-Json -Depth 8
    if ($Path) {
        $dir = Split-Path -Parent $Path
        if ($dir -and -not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Force -Path $dir | Out-Null
        }
        # UTF-8 without a BOM, so Node's JSON.parse reads it as is.
        [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding($false)))
    }
    Write-Host $json
}

# The "Apps & features" entry of ModelForge (per-user install: HKCU), or $null.
function Get-ModelForgeUninstallEntry {
    $roots = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
    )
    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        foreach ($key in Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue) {
            $name = $key.GetValue('DisplayName')
            if ($name -and ([string]$name) -like 'ModelForge*') {
                return [pscustomobject]@{
                    KeyPath              = $key.Name
                    DisplayName          = [string]$name
                    DisplayVersion       = [string]$key.GetValue('DisplayVersion')
                    Publisher            = [string]$key.GetValue('Publisher')
                    UninstallString      = [string]$key.GetValue('UninstallString')
                    QuietUninstallString = [string]$key.GetValue('QuietUninstallString')
                    InstallLocation      = [string]$key.GetValue('InstallLocation')
                }
            }
        }
    }
    return $null
}

# Shortcuts electron-builder creates for a per-user install (shortcutName "ModelForge").
function Get-ModelForgeShortcuts {
    $programs = [Environment]::GetFolderPath('Programs')
    $desktop = [Environment]::GetFolderPath('Desktop')
    return [pscustomobject]@{
        StartMenu = (Join-Path $programs 'ModelForge.lnk')
        Desktop   = (Join-Path $desktop 'ModelForge.lnk')
    }
}

# Stops ModelForge.exe / goose.exe started from the install directory, and uninstaller copies.
function Stop-ModelForgeProcesses {
    param([string] $InstallDir)
    $names = @('ModelForge.exe', 'goose.exe')
    $all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
    foreach ($proc in $all) {
        $path = [string]$proc.ExecutablePath
        if (-not $path) { continue }
        $inDir = $InstallDir -and $path.StartsWith($InstallDir, [System.StringComparison]::OrdinalIgnoreCase)
        if ($names -contains $proc.Name -and $inDir) {
            Write-Host ("stopping {0} {1}" -f $proc.Name, $proc.ProcessId)
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
}

# NSIS uninstaller processes: the installed "Uninstall ModelForge.exe" and the copy it starts
# from %TEMP% (Un_A.exe, or Au_.exe in older NSIS versions).
function Get-UninstallerProcesses {
    return @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
            $_.ProcessName -eq 'Uninstall ModelForge' -or $_.ProcessName -like 'Un_*' -or $_.ProcessName -eq 'Au_'
        })
}

# Splits `"C:\dir with space\app.exe" /arg` into the executable and the rest.
function Split-CommandLine {
    param([Parameter(Mandatory = $true)][string] $Line)
    $trimmed = $Line.Trim()
    if ($trimmed.StartsWith('"')) {
        $end = $trimmed.IndexOf('"', 1)
        if ($end -gt 0) {
            return [pscustomobject]@{
                Exe  = $trimmed.Substring(1, $end - 1)
                Args = $trimmed.Substring($end + 1).Trim()
            }
        }
    }
    $space = $trimmed.IndexOf(' ')
    if ($space -lt 0) {
        return [pscustomobject]@{ Exe = $trimmed; Args = '' }
    }
    return [pscustomobject]@{ Exe = $trimmed.Substring(0, $space); Args = $trimmed.Substring($space + 1).Trim() }
}

# Full-screen PNG; works in the interactive session of a GitHub-hosted Windows runner.
function Save-Screenshot {
    param([Parameter(Mandatory = $true)][string] $Path)
    try {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
        $bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size)
        $dir = Split-Path -Parent $Path
        if ($dir -and -not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Force -Path $dir | Out-Null
        }
        $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
        $graphics.Dispose()
        $bitmap.Dispose()
        return $true
    }
    catch {
        Write-Host ("screenshot failed: {0}" -f $_.Exception.Message)
        return $false
    }
}

# Waits for a process with a timeout; returns its exit code, or $null on timeout.
function Wait-ProcessExit {
    param(
        [Parameter(Mandatory = $true)][System.Diagnostics.Process] $Process,
        [int] $TimeoutSeconds = 600
    )
    # Touching Handle keeps the exit code readable after the process ends (a 5.1 quirk).
    $null = $Process.Handle
    if (-not $Process.WaitForExit($TimeoutSeconds * 1000)) {
        return $null
    }
    return $Process.ExitCode
}
