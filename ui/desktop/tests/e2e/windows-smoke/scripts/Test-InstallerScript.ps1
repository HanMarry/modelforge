<#
.SYNOPSIS
    Checks which per-user install-mode code an NSIS installer was built with (task 13.6).

.DESCRIPTION
    electron-builder 24.13.3 (app-builder-lib templates/nsis/multiUser.nsh) reads the folder
    SHGetKnownFolderPath returns with System::Call '*$2(&w${NSIS_MAX_STRLEN} .s)', a fixed-length
    copy past the end of the Shell's buffer that crashes fresh per-user installs at random
    (0xC0000005 in System.dll). build/modelforge-multiuser.nsh replaces that macro with the
    bounded lstrcpynW copy of the upstream fix. This script looks at what was actually compiled.

    Plug-in calls are compiled into the string table of the NSIS header, so the System::Call
    strings can be read back from it. electron-builder compresses its installers with
    "SetCompressor zlib" (not solid): the header is the first block after the NSIS first header
    (0xDEADBEEF "NullsoftInst", at a 512-byte boundary after the stub) and is a raw deflate
    stream. The script inflates it and searches the string table ("Unicode true": UTF-16LE),
    for the installer and for the uninstaller it carries (extracted with 7-Zip). 7-Zip itself
    rebuilt NSIS scripts as "[NSIS].nsi" only up to version 15.05, so it is not used for that.
    Counted in each header:

      unboundedRead   struct reads of a fixed-length wide string onto the stack, "(&w<n> .s)"
      boundedCopy     calls of KERNEL32::lstrcpynW
      knownFolder     calls of SHELL32::SHGetKnownFolderPath

    verdict: "fixed" when both headers call SHGetKnownFolderPath, copy with lstrcpynW and have
    no unbounded read; "vulnerable" when either has the unbounded read; "unknown" otherwise
    (for example when a header is LZMA-compressed and cannot be read here).

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

# Raw deflate (NSIS "zlib"); $skip 2 drops a zlib stream header.
function Expand-Deflate([byte[]] $data, [int] $skip) {
    $source = [System.IO.MemoryStream]::new($data, $skip, $data.Length - $skip)
    $inflate = [System.IO.Compression.DeflateStream]::new($source, [System.IO.Compression.CompressionMode]::Decompress)
    $output = [System.IO.MemoryStream]::new()
    try { $inflate.CopyTo($output) }
    finally { $inflate.Dispose() }
    # The comma keeps PowerShell from unrolling the byte array.
    return , $output.ToArray()
}

# The NSIS header of $path: the block that follows the first header (flags, 0xDEADBEEF,
# "NullsoftInst", header length, length of the rest), inflated when it is compressed.
function Read-NsisHeader([string] $path) {
    $info = [ordered]@{ offset = -1; flags = 0; headerLength = 0; compression = ''; bytes = $null }
    $magic = [byte[]](@(0xEF, 0xBE, 0xAD, 0xDE) + [System.Text.Encoding]::ASCII.GetBytes('NullsoftInst'))
    $block = $null
    $compressed = $false
    $stream = [System.IO.File]::OpenRead($path)
    try {
        $first = New-Object byte[] 28
        # The stub is a few hundred KB; do not walk a large file to its end.
        $limit = [Math]::Min($stream.Length, [long]32MB)
        for ($pos = [long]0; $pos + 32 -le $limit; $pos += 512) {
            $stream.Position = $pos
            if ($stream.Read($first, 0, 28) -ne 28) { break }
            $match = $true
            for ($i = 0; $i -lt 16; $i++) {
                if ($first[4 + $i] -ne $magic[$i]) { $match = $false; break }
            }
            if ($match) { $info.offset = $pos; break }
        }
        if ($info.offset -lt 0) { throw 'no NSIS first header (0xDEADBEEF "NullsoftInst") at a 512-byte boundary' }
        $info.flags = [BitConverter]::ToInt32($first, 0)
        $info.headerLength = [BitConverter]::ToInt32($first, 20)
        $lengthBytes = New-Object byte[] 4
        if ($stream.Read($lengthBytes, 0, 4) -ne 4) { throw 'the header block is cut off' }
        if ($lengthBytes[0] -eq 0x5D -and $lengthBytes[1] -eq 0 -and $lengthBytes[2] -eq 0) {
            throw 'solid LZMA installer; only zlib (deflate) and stored headers are read'
        }
        # Bit 31 of the block length marks a compressed block.
        $compressed = ($lengthBytes[3] -band 0x80) -ne 0
        $lengthBytes[3] = [byte]($lengthBytes[3] -band 0x7F)
        $size = [BitConverter]::ToInt32($lengthBytes, 0)
        if ($size -le 0 -or $size -gt 64MB) { throw ('implausible header block length {0}' -f $size) }
        $block = New-Object byte[] $size
        $read = 0
        while ($read -lt $size) {
            $n = $stream.Read($block, $read, $size - $read)
            if ($n -le 0) { break }
            $read += $n
        }
        if ($read -ne $size) { throw 'the header block is cut off' }
    }
    finally { $stream.Dispose() }

    if (-not $compressed) {
        $info.compression = 'stored'
        $info.bytes = $block
    }
    elseif ($block.Length -ge 3 -and $block[0] -eq 0x5D -and $block[1] -eq 0 -and $block[2] -eq 0) {
        throw 'LZMA-compressed header; only zlib (deflate) and stored headers are read'
    }
    else {
        $info.compression = 'deflate'
        try { $info.bytes = Expand-Deflate $block 0 }
        catch {
            $zlibHeader = $block.Length -ge 2 -and (($block[0] -band 0x0F) -eq 8) -and (((([int]$block[0]) * 256) + $block[1]) % 31 -eq 0)
            if (-not $zlibHeader) { throw ('cannot inflate the header: {0}' -f $_.Exception.Message) }
            $info.compression = 'zlib'
            $info.bytes = Expand-Deflate $block 2
        }
    }
    if ($info.bytes.Length -ne $info.headerLength) {
        throw ('the header has {0} bytes, the first header says {1}' -f $info.bytes.Length, $info.headerLength)
    }
    return $info
}

# A string-table entry for display. In a Unicode header a variable reference is NS_VAR_CODE (3)
# followed by its index packed into one character (low 7 bits, then the next 7 bits shifted by
# one): "*" 0x0003 0x8082 "(&w8192 .s)" is '*$2(&w8192 .s)'. Other codes show as "?".
function Format-NsisString([string] $value) {
    $evaluator = [System.Text.RegularExpressions.MatchEvaluator] {
        param($m)
        $packed = [int][char]$m.Value[1]
        $index = ($packed -band 0x7F) -bor (($packed -band 0x7F00) -shr 1)
        if ($index -lt 10) { return ('$' + $index) }
        if ($index -lt 20) { return ('$R' + ($index - 10)) }
        return ('$[var {0}]' -f $index)
    }
    $decoded = [regex]::Replace($value, '\x03[\u8080-\uFFFF]', $evaluator)
    return ($decoded -replace '[\x01-\x1F\uE000-\uF8FF]', '?')
}

# Counts in the string table of the NSIS header of $path (see the description).
function Measure-Header([string] $path, [string] $name) {
    $entry = [ordered]@{
        name             = $name
        decoded          = $false
        compression      = ''
        firstHeaderAt    = -1
        headerBytes      = 0
        unboundedRead    = 0
        boundedCopy      = 0
        knownFolder      = 0
        unboundedStrings = @()
        error            = $null
    }
    try {
        $header = Read-NsisHeader $path
        $entry.firstHeaderAt = $header.offset
        $entry.compression = $header.compression
        $entry.headerBytes = $header.bytes.Length
        # UTF-16LE for "Unicode true"; Latin-1 finds the strings of an ANSI build. A string
        # matches in one decoding only.
        $texts = @([System.Text.Encoding]::Unicode.GetString($header.bytes), [System.Text.Encoding]::GetEncoding(28591).GetString($header.bytes))
        foreach ($text in $texts) {
            $entry.unboundedRead += [regex]::Matches($text, '\(&w\d+\s*\.s\)').Count
            $entry.boundedCopy += [regex]::Matches($text, 'lstrcpynW', 'IgnoreCase').Count
            $entry.knownFolder += [regex]::Matches($text, 'SHGetKnownFolderPath', 'IgnoreCase').Count
            foreach ($m in [regex]::Matches($text, '[^\x00]{0,200}\(&w\d+\s*\.s\)[^\x00]{0,40}')) {
                if ($entry.unboundedStrings.Count -lt 5) { $entry.unboundedStrings += (Format-NsisString $m.Value) }
            }
        }
        $entry.decoded = $true
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

    $result.scripts += (Measure-Header $Installer 'installer')

    # The uninstaller electron-builder builds first and packs as a plain file.
    try {
        $sevenZip = Find-SevenZip
        $result.sevenZip = $sevenZip
        $entries = Get-ArchiveEntries $sevenZip $Installer
        $uninstallerEntry = $entries | Where-Object { (Split-Path -Leaf $_) -match '^Uninstall .+\.exe$' } | Select-Object -First 1
        if (-not $uninstallerEntry) { throw 'no "Uninstall *.exe" in the installer' }
        $result.uninstaller = $uninstallerEntry
        $uninstaller = Expand-Entry $sevenZip $Installer $uninstallerEntry (Join-Path $WorkDir 'uninstaller-exe')
        $result.scripts += (Measure-Header $uninstaller 'uninstaller')
    }
    catch {
        $result.scripts += [ordered]@{ name = 'uninstaller'; decoded = $false; error = $_.Exception.Message }
    }

    $scripts = @($result.scripts)
    $decoded = @($scripts | Where-Object { $_.decoded })
    if (@($decoded | Where-Object { $_.unboundedRead -gt 0 }).Count -gt 0) {
        $result.verdict = 'vulnerable'
    }
    elseif ($decoded.Count -eq 2 -and @($decoded | Where-Object { $_.boundedCopy -gt 0 -and $_.knownFolder -gt 0 }).Count -eq 2) {
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
