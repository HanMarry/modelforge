<#
.SYNOPSIS
    Checks which per-user install-mode code an NSIS installer was built with (task 13.6).

.DESCRIPTION
    electron-builder 24.13.3 (app-builder-lib templates/nsis/multiUser.nsh) reads the folder
    SHGetKnownFolderPath returns with System::Call '*$2(&w${NSIS_MAX_STRLEN} .s)', a fixed-length
    copy past the end of the Shell's buffer that crashes fresh per-user installs at random
    (0xC0000005 in System.dll). build/modelforge-multiuser.nsh replaces that macro with the
    bounded lstrcpynW copy of the upstream fix. This script looks at what was actually compiled:
    7-Zip rebuilds the script of an NSIS installer as "[NSIS].nsi", for the installer and for
    the uninstaller it carries, and the script counts in each

      unboundedRead   struct reads of a fixed-length wide string onto the stack, "(&w<n> .s)"
      boundedCopy     calls of KERNEL32::lstrcpynW
      knownFolder     calls of SHELL32::SHGetKnownFolderPath

    verdict: "fixed" when both scripts call SHGetKnownFolderPath, copy with lstrcpynW and have
    no unbounded read; "vulnerable" when either has the unbounded read; "unknown" otherwise
    (for example when 7-Zip cannot rebuild a script).

    Exit code 0, or 1 with -RequireFixed when the verdict is not "fixed".
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $Installer,
    [string] $Label = '',
    [string] $WorkDir = '',
    [string] $ResultFile = '',
    [switch] $RequireFixed
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'SmokeCommon.ps1')

$result = [ordered]@{
    ok          = $false
    label       = $Label
    installer   = $Installer
    sha256      = ''
    sevenZip    = ''
    uninstaller = ''
    scripts     = @()
    verdict     = 'unknown'
    error       = $null
}

function Find-SevenZip {
    $command = Get-Command 7z.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if (-not $root) { continue }
        $candidate = Join-Path $root '7-Zip\7z.exe'
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    throw '7z.exe not found (PATH, Program Files\7-Zip)'
}

# "Path = ..." entries of `7z l -slt`.
function Get-ArchiveEntries([string] $sevenZip, [string] $archive) {
    $lines = & $sevenZip l -slt -- $archive 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw ("7z l {0} exited with {1}: {2}" -f $archive, $LASTEXITCODE, (($lines | Select-Object -Last 5) -join ' '))
    }
    return @($lines | ForEach-Object { [string]$_ } | Where-Object { $_.StartsWith('Path = ') } |
        ForEach-Object { $_.Substring(7) } | Select-Object -Skip 1)
}

function Expand-Entry([string] $sevenZip, [string] $archive, [string] $entry, [string] $outDir) {
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null
    $output = & $sevenZip e -y ("-o{0}" -f $outDir) -- $archive $entry 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw ("7z e {0} {1} exited with {2}: {3}" -f $archive, $entry, $LASTEXITCODE, (($output | Select-Object -Last 5) -join ' '))
    }
    $file = Join-Path $outDir (Split-Path -Leaf $entry)
    if (-not (Test-Path -LiteralPath $file)) { throw ("7z did not write {0}" -f $file) }
    return $file
}

# Counts in the script 7-Zip rebuilt for $archive (see the description).
function Measure-Script([string] $sevenZip, [string] $archive, [string] $name, [string] $outDir) {
    $entry = [ordered]@{
        name           = $name
        decompiled     = $false
        bytes          = 0
        unboundedRead  = 0
        boundedCopy    = 0
        knownFolder    = 0
        unboundedLines = @()
        error          = $null
    }
    try {
        $entries = Get-ArchiveEntries $sevenZip $archive
        $scriptEntry = $entries | Where-Object { $_ -match '\[NSIS\]\.nsi$' } | Select-Object -First 1
        if (-not $scriptEntry) { throw ('7-Zip lists no [NSIS].nsi in {0}' -f $archive) }
        $file = Expand-Entry $sevenZip $archive $scriptEntry $outDir
        # 7-Zip writes the script with a BOM (UTF-16 or UTF-8); ReadAllText honours it.
        $text = [System.IO.File]::ReadAllText($file)
        $entry.decompiled = $true
        $entry.bytes = (Get-Item -LiteralPath $file).Length
        $unbounded = [regex]::Matches($text, '\(&w\d+\s*\.s\)')
        $entry.unboundedRead = $unbounded.Count
        $entry.boundedCopy = [regex]::Matches($text, 'lstrcpynW', 'IgnoreCase').Count
        $entry.knownFolder = [regex]::Matches($text, 'SHGetKnownFolderPath', 'IgnoreCase').Count
        foreach ($line in ($text -split "`r?`n")) {
            if ($line -match '\(&w\d+\s*\.s\)' -and $entry.unboundedLines.Count -lt 5) {
                $entry.unboundedLines += $line.Trim()
            }
        }
    }
    catch {
        $entry.error = $_.Exception.Message
    }
    return $entry
}

try {
    if (-not (Test-Path -LiteralPath $Installer)) { throw "installer not found: $Installer" }
    $result.sha256 = (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLowerInvariant()
    if (-not $WorkDir) { $WorkDir = Join-Path $env:TEMP ('mf-installer-script-' + [guid]::NewGuid().ToString('N').Substring(0, 8)) }
    New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
    $sevenZip = Find-SevenZip
    $result.sevenZip = $sevenZip

    $result.scripts += (Measure-Script $sevenZip $Installer 'installer' (Join-Path $WorkDir 'installer'))

    # The uninstaller electron-builder builds first and packs as a plain file.
    $entries = Get-ArchiveEntries $sevenZip $Installer
    $uninstallerEntry = $entries | Where-Object { (Split-Path -Leaf $_) -match '^Uninstall .+\.exe$' } | Select-Object -First 1
    if ($uninstallerEntry) {
        $result.uninstaller = $uninstallerEntry
        $uninstaller = Expand-Entry $sevenZip $Installer $uninstallerEntry (Join-Path $WorkDir 'uninstaller-exe')
        $result.scripts += (Measure-Script $sevenZip $uninstaller 'uninstaller' (Join-Path $WorkDir 'uninstaller'))
    }
    else {
        $result.scripts += [ordered]@{ name = 'uninstaller'; decompiled = $false; error = 'no "Uninstall *.exe" in the installer' }
    }

    $scripts = @($result.scripts)
    $decompiled = @($scripts | Where-Object { $_.decompiled })
    if (@($decompiled | Where-Object { $_.unboundedRead -gt 0 }).Count -gt 0) {
        $result.verdict = 'vulnerable'
    }
    elseif ($decompiled.Count -eq 2 -and @($decompiled | Where-Object { $_.boundedCopy -gt 0 -and $_.knownFolder -gt 0 }).Count -eq 2) {
        $result.verdict = 'fixed'
    }
    $result.ok = ($result.verdict -eq 'fixed') -or (-not $RequireFixed)
    if (-not $result.ok) {
        $result.error = ('the installer is not built with the bounded UserProgramFiles copy (verdict {0})' -f $result.verdict)
    }
}
catch {
    $result.error = $_.Exception.Message
    Write-Host ("installer script check failed: {0}" -f $result.error)
}

Write-SmokeResult -Result $result -Path $ResultFile
if ($result.ok) { exit 0 } else { exit 1 }
