<#
.SYNOPSIS
    Installer crash check: repeated fresh per-user installs, before and after the fix (13.6).

.DESCRIPTION
    Installers built with electron-builder 24.13.3's multiUser.nsh crash at random on a fresh
    per-user install (0xC0000005 in System.dll, see build/modelforge-multiuser.nsh). This script,
    run as the runner's administrator by the crash-check job of modelforge-windows-smoke.yml,
    measures that for a candidate installer and, when given, a baseline installer:

      1. static: which install-mode code each installer was compiled with
         (Test-InstallerScript.ps1 reads the NSIS headers: unbounded "(&w<n> .s)" read or
         bounded lstrcpynW copy);
      2. natural: -Rounds fresh silent per-user installs of each installer, in turn, as a new
         local user whose profile path has Chinese characters and a space (Invoke-AsLocalUser.ps1
         with Run-InstallLoop.ps1); no crashed install is run again;
      3. pageheap: -PageHeapRounds more with full page heap on the installer processes
         (Image File Execution Options GlobalFlag 0x02000000, PageHeapFlags 0x3). Every heap
         block then ends at a page boundary followed by an inaccessible page, so a read past the
         end of the Shell's buffer faults every time instead of depending on the heap layout;
      4. crash evidence: Windows Error Reporting events (faulting module, offset, exception
         code) and LocalDumps of the installer processes, read with cdb.exe when the Windows SDK
         debuggers are installed;
      5. a test-runner probe (-NodeExe): Node's fs.cpSync / fs.rmSync and the harness's own copy
         on a directory whose path has Chinese characters and a space (harness.ts, "Files").

    The installers are copied to mf-setup-<label>.exe so the registry settings above apply to
    them only. Writes <WorkDir>\results\crash-check.json and summary.md.

    Exit code 0 when the candidate never crashed and its headers do not show the unbounded read
    (a header that cannot be read is reported, not failed), 1 otherwise (also when a phase
    could not run), 2 when the check itself failed.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $CandidateInstaller,
    [string] $BaselineInstaller = '',
    [Parameter(Mandatory = $true)][string] $UserName,
    # Writable directory with an ASCII path (the runner's temp directory).
    [Parameter(Mandatory = $true)][string] $WorkDir,
    [int] $Rounds = 20,
    [int] $PageHeapRounds = 5,
    [string] $NodeExe = '',
    [string] $ResultFile = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'SmokeCommon.ps1')

$startedAt = Get-Date
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$results = Join-Path $WorkDir 'results'
$dumps = Join-Path $results 'dumps'
$installersDir = Join-Path $WorkDir 'installers'
$scriptsDir = Join-Path $WorkDir 'scripts'
foreach ($dir in @($results, $dumps, $installersDir, $scriptsDir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

$check = [ordered]@{
    ok          = $false
    startedAt   = $startedAt.ToUniversalTime().ToString('o')
    userName    = $UserName
    installers  = @()
    static      = @()
    phases      = @()
    events      = @()
    dumps       = @()
    cpSyncProbe = $null
    werSettings = ''
    verdict     = ''
    errors      = @()
}

function Add-CheckError([string] $message) {
    Write-Host ("::warning::{0}" -f $message)
    $script:check.errors += $message
}

# Copies of the scripts the user runs (this directory), readable by that user.
Copy-Item -Path (Join-Path $PSScriptRoot '*.ps1') -Destination $scriptsDir -Force

$labels = @()
if ($BaselineInstaller) { $labels += , @('baseline', $BaselineInstaller) }
$labels += , @('candidate', $CandidateInstaller)
$installers = @()
foreach ($pair in $labels) {
    $label = $pair[0]
    $source = $pair[1]
    if (-not (Test-Path -LiteralPath $source)) { throw "installer not found: $source" }
    $copy = Join-Path $installersDir ("mf-setup-{0}.exe" -f $label)
    Copy-Item -LiteralPath $source -Destination $copy -Force
    $installers += [ordered]@{
        label  = $label
        path   = $copy
        name   = (Split-Path -Leaf $copy)
        source = $source
        sha256 = (Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}
$check.installers = $installers

# --- 1. static ---------------------------------------------------------------------------------
foreach ($installer in $installers) {
    $out = Join-Path $results ("static-{0}.json" -f $installer.label)
    & $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $scriptsDir 'Test-InstallerScript.ps1') `
        -Installer $installer.path -Label $installer.label -WorkDir (Join-Path $WorkDir ("static-" + $installer.label)) -ResultFile $out | Out-Null
    $static = $null
    try { $static = Get-Content -LiteralPath $out -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
    if ($static) {
        $check.static += [ordered]@{
            label   = $installer.label
            verdict = [string]$static.verdict
            scripts = @($static.scripts | ForEach-Object {
                    [ordered]@{
                        name          = [string]$_.name
                        decoded       = [bool]$_.decoded
                        compression   = [string]$_.compression
                        headerBytes   = $_.headerBytes
                        unboundedRead = $_.unboundedRead
                        boundedCopy   = $_.boundedCopy
                        knownFolder   = $_.knownFolder
                        sample        = (@($_.unboundedStrings) | Select-Object -First 1)
                        error         = $_.error
                    }
                })
            error   = $static.error
        }
    }
    else {
        Add-CheckError ("static check of {0} wrote no result" -f $installer.label)
    }
}

# --- crash dumps ---------------------------------------------------------------------------------
$werRoot = 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting'
try {
    $wer = Get-ItemProperty -LiteralPath $werRoot -ErrorAction SilentlyContinue
    $check.werSettings = ('Disabled={0}, DontShowUI={1}' -f $wer.Disabled, $wer.DontShowUI)
}
catch { }
$dumpKeys = @()
foreach ($installer in $installers) {
    foreach ($root in @('HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\Windows Error Reporting\LocalDumps')) {
        $key = Join-Path $root $installer.name
        try {
            if (-not (Test-Path -LiteralPath $root)) { New-Item -Path $root -Force | Out-Null }
            New-Item -Path $key -Force | Out-Null
            New-ItemProperty -Path $key -Name DumpFolder -PropertyType ExpandString -Value $dumps -Force | Out-Null
            # Full dumps (the heap is needed for !heap), about 100 MB each, at most 3 per folder;
            # each phase gets its own folder (Set-DumpFolder).
            New-ItemProperty -Path $key -Name DumpType -PropertyType DWord -Value 2 -Force | Out-Null
            New-ItemProperty -Path $key -Name DumpCount -PropertyType DWord -Value 3 -Force | Out-Null
            $dumpKeys += $key
        }
        catch {
            Add-CheckError ("cannot configure LocalDumps at {0}: {1}" -f $key, $_.Exception.Message)
        }
    }
}
try { Start-Service -Name WerSvc -ErrorAction Stop } catch { Add-CheckError ("WerSvc: {0}" -f $_.Exception.Message) }

# --- 2./3. install loops as the new local user --------------------------------------------------
$ifeoRoots = @('HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows NT\CurrentVersion\Image File Execution Options')

function Set-PageHeap([bool] $enabled) {
    foreach ($installer in $script:installers) {
        foreach ($root in $script:ifeoRoots) {
            $key = Join-Path $root $installer.name
            if ($enabled) {
                if (-not (Test-Path -LiteralPath $root)) { New-Item -Path $root -Force | Out-Null }
                New-Item -Path $key -Force | Out-Null
                New-ItemProperty -Path $key -Name GlobalFlag -PropertyType String -Value '0x02000000' -Force | Out-Null
                New-ItemProperty -Path $key -Name PageHeapFlags -PropertyType String -Value '0x3' -Force | Out-Null
            }
            elseif (Test-Path -LiteralPath $key) {
                Remove-Item -LiteralPath $key -Recurse -Force
            }
        }
    }
}

function Set-DumpFolder([string] $folder) {
    New-Item -ItemType Directory -Force -Path $folder | Out-Null
    foreach ($key in $script:dumpKeys) {
        try { Set-ItemProperty -LiteralPath $key -Name DumpFolder -Value $folder } catch { }
    }
}

function Invoke-Phase([string] $phase, [int] $rounds) {
    $dir = Join-Path $script:results $phase
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Set-DumpFolder (Join-Path $script:dumps $phase)
    $spec = [ordered]@{
        phase      = $phase
        rounds     = $rounds
        installers = @($script:installers | ForEach-Object { [ordered]@{ label = $_.label; path = $_.path } })
        resultsDir = $dir
    }
    $envFile = Join-Path $dir 'loop-env.json'
    [System.IO.File]::WriteAllText($envFile, ($spec | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
    $phaseStart = Get-Date
    $timeout = [Math]::Max(1800, $rounds * $script:installers.Count * 600)
    & $script:powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $script:scriptsDir 'Invoke-AsLocalUser.ps1') `
        -UserName $script:UserName -EnvFile $envFile -InnerScript 'Run-InstallLoop.ps1' `
        -GrantRead ("{0};{1}" -f $script:installersDir, $script:scriptsDir) -GrantModify $script:results `
        -ResultFile (Join-Path $dir 'invoke-result.json') -TimeoutSeconds $timeout | Out-Host
    $code = $LASTEXITCODE
    $loop = $null
    try { $loop = Get-Content -LiteralPath (Join-Path $dir 'inner-result.json') -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
    $runs = @()
    if ($loop) { $runs = @($loop.runs) }
    $phaseResult = [ordered]@{
        phase      = $phase
        rounds     = $rounds
        startedAt  = $phaseStart.ToUniversalTime().ToString('o')
        endedAt    = (Get-Date).ToUniversalTime().ToString('o')
        invokeExit = $code
        identity   = $(if ($loop) { [string]$loop.identity } else { '' })
        profile    = $(if ($loop) { [string]$loop.userProfile } else { '' })
        loopError  = $(if ($loop) { $loop.error } else { 'no loop result' })
        byLabel    = @()
    }
    foreach ($installer in $script:installers) {
        $mine = @($runs | Where-Object { $_.label -eq $installer.label })
        $phaseResult.byLabel += [ordered]@{
            label       = $installer.label
            runs        = $mine.Count
            ok          = @($mine | Where-Object { $_.exitCode -eq 0 -and $_.exePresent }).Count
            crashes     = @($mine | Where-Object { $_.crashed }).Count
            otherFailed = @($mine | Where-Object { -not $_.crashed -and -not ($_.exitCode -eq 0 -and $_.exePresent) }).Count
            notFresh    = @($mine | Where-Object { -not $_.freshBefore }).Count
            exitCodes   = (@($mine | ForEach-Object { $_.exitHex } | Group-Object | ForEach-Object { '{0} x{1}' -f $_.Name, $_.Count }) -join ', ')
            installDirs = (@($mine | Where-Object { $_.installDir } | ForEach-Object { $_.installDir } | Select-Object -Unique) -join '; ')
            medianMs    = $(if ($mine.Count) { @($mine | Sort-Object durationMs)[[int][Math]::Floor($mine.Count / 2)].durationMs } else { 0 })
            errors      = @($mine | Where-Object { $_.error } | ForEach-Object { 'round {0}: {1}' -f $_.round, $_.error } | Select-Object -First 5)
        }
    }
    $script:check.phases += $phaseResult
}

try {
    if ($Rounds -gt 0) { Invoke-Phase 'natural' $Rounds }
    if ($PageHeapRounds -gt 0) {
        Set-PageHeap $true
        try { Invoke-Phase 'pageheap' $PageHeapRounds }
        finally { Set-PageHeap $false }
    }
}
catch {
    Add-CheckError ("install loop: {0}" -f $_.Exception.Message)
}

# --- 5. test-runner probe -----------------------------------------------------------------------
if ($NodeExe -and (Test-Path -LiteralPath $NodeExe)) {
    try {
        $probeDir = Join-Path $WorkDir 'cpsync-probe'
        New-Item -ItemType Directory -Force -Path $probeDir | Out-Null
        # A profile-like directory name: Chinese characters and a space (U+6A21 U+578B U+6D4B U+8BD5).
        $cjk = -join ([char[]](0x6A21, 0x578B, 0x20, 0x6D4B, 0x8BD5))
        $source = Join-Path (Join-Path $probeDir $cjk) 'logs'
        New-Item -ItemType Directory -Force -Path (Join-Path $source 'startup') | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $source 'main.log'), "probe`n")
        [System.IO.File]::WriteAllText((Join-Path $source 'startup\a.json'), "{}`n")
        $probe = Join-Path $probeDir 'probe.cjs'
        $js = @(
            "'use strict';",
            "const fs = require('node:fs');",
            "const path = require('node:path');",
            "const [mode, a, b] = process.argv.slice(2);",
            "function copyTree(source, target) {",
            "  const stat = fs.lstatSync(source);",
            "  if (stat.isDirectory()) {",
            "    fs.mkdirSync(target, { recursive: true });",
            "    for (const entry of fs.readdirSync(source)) copyTree(path.join(source, entry), path.join(target, entry));",
            "  } else if (stat.isFile()) {",
            "    fs.copyFileSync(source, target);",
            "  }",
            "}",
            "if (mode === 'cpSync') fs.cpSync(a, b, { recursive: true });",
            "else if (mode === 'copyTree') copyTree(a, b);",
            "else if (mode === 'rmSync') fs.rmSync(a, { recursive: true, force: true });",
            "const probe = mode === 'rmSync' ? a : path.join(b, 'startup', 'a.json');",
            "process.stdout.write(JSON.stringify({ mode, node: process.version, exists: fs.existsSync(probe) }) + '\n');"
        ) -join "`n"
        [System.IO.File]::WriteAllText($probe, $js, (New-Object System.Text.UTF8Encoding($false)))
        $runProbe = {
            param([string] $mode, [string] $a, [string] $b)
            $probeArgs = @($probe, $mode, $a)
            if ($b) { $probeArgs += $b }
            $output = & $NodeExe @probeArgs 2>&1 | Out-String
            $code = $LASTEXITCODE
            return [ordered]@{ mode = $mode; exitCode = $code; exitHex = ('0x{0:X8}' -f [int]$code); output = $output.Trim() }
        }
        $check.cpSyncProbe = [ordered]@{
            source   = $source
            copyTree = (& $runProbe 'copyTree' $source (Join-Path $probeDir 'out-copytree'))
            cpSync   = (& $runProbe 'cpSync' $source (Join-Path $probeDir 'out-cpsync'))
            rmSync   = (& $runProbe 'rmSync' $source '')
            rmSyncLeftSource = (Test-Path -LiteralPath (Join-Path $source 'main.log'))
        }
    }
    catch {
        Add-CheckError ("cpSync probe: {0}" -f $_.Exception.Message)
    }
}

# --- 4. crash evidence ----------------------------------------------------------------------------
Start-Sleep -Seconds 5
try {
    $filter = @{ LogName = 'Application'; ProviderName = 'Application Error', 'Windows Error Reporting'; StartTime = $startedAt }
    # No event at all is a normal outcome (nothing crashed), not an error.
    $events = @(Get-WinEvent -FilterHashtable $filter -ErrorAction SilentlyContinue | Sort-Object TimeCreated)
    foreach ($evt in $events) {
        $text = [string]$evt.Message
        if ($text -notmatch 'mf-setup-|node\.exe') { continue }
        $field = {
            param($pattern)
            $m = [regex]::Match($text, $pattern)
            if ($m.Success) { return $m.Groups[1].Value.Trim() } else { return '' }
        }
        $check.events += [ordered]@{
            at          = $evt.TimeCreated.ToUniversalTime().ToString('o')
            provider    = $evt.ProviderName
            id          = $evt.Id
            application = (& $field 'Faulting application name:\s*([^,\r\n]+)')
            module      = (& $field 'Faulting module name:\s*([^,\r\n]+)')
            exception   = (& $field 'Exception code:\s*(\S+)')
            offset      = (& $field 'Fault offset:\s*(\S+)')
            modulePath  = (& $field 'Faulting module path:\s*([^\r\n]+)')
            summary     = $(if ($evt.ProviderName -eq 'Windows Error Reporting') { ($text -split "`r?`n" | Select-Object -First 6) -join ' ' } else { '' })
        }
    }
}
catch {
    Add-CheckError ("no Application events: {0}" -f $_.Exception.Message)
}

$cdb = $null
foreach ($candidate in @("${env:ProgramFiles(x86)}\Windows Kits\10\Debuggers\x64\cdb.exe", "$env:ProgramFiles\Windows Kits\10\Debuggers\x64\cdb.exe")) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { $cdb = $candidate; break }
}
$dumpFiles = @(Get-ChildItem -LiteralPath $dumps -Filter '*.dmp' -File -Recurse -ErrorAction SilentlyContinue | Sort-Object LastWriteTime)
# One command per line. cdb reads them from a script file (-cf) and, should that stop at a
# failing command, again from standard input, which ends with "q" and then end of file, so it
# never waits for input (run 36853323097: ".effmach x86; ..." on one -c line failed with
# "Extra character error", the rest including "q" never ran and cdb sat until the timeout).
# The dumps are of the 32-bit installer (WOW64); .effmach x86 makes sure cdb shows x86 frames.
# The fault at System.dll+0x1581 (System!Store+0x4a0, NSIS 3.0.4.1's System.dll) is the byte
# loop "mov al,[ecx+edx]; mov [edx],al; inc edx" with edi the start of the destination and ecx
# the distance to the source (run 36857451672), so ecx+edi is the Shell's buffer and
# ecx+edx-1 the last byte read. `!heap -p` lives in ext.dll in current debuggers.
$cdbCommands = @(
    '.effmach x86',
    '.exr -1',
    '.ecxr',
    'kv 12',
    'ub @eip L8',
    'u @eip L3',
    'lmv m System',
    '!gflag',
    '.echo MF-SOURCE',
    'du @ecx+@edi',
    '.echo MF-HEAP',
    '!ext.heap -p -a @ecx+@edi',
    '!ext.heap -p -a @ecx+@edx-1',
    'q'
)
$analysed = @{}
foreach ($dump in $dumpFiles) {
    $label = $(if ($dump.Name -match 'mf-setup-([a-z]+)\.exe') { $Matches[1] } else { 'other' })
    $phaseName = Split-Path -Leaf $dump.DirectoryName
    $entry = [ordered]@{ file = ('{0}/{1}' -f $phaseName, $dump.Name); bytes = $dump.Length; label = $label; phase = $phaseName; analysis = ''; facts = @() }
    $slot = '{0}|{1}' -f $phaseName, $label
    $count = 0
    if ($analysed.ContainsKey($slot)) { $count = $analysed[$slot] }
    if ($cdb -and $count -lt 2) {
        $analysed[$slot] = $count + 1
        $log = Join-Path $dump.DirectoryName ($dump.BaseName + '.cdb.txt')
        $symbols = Join-Path $WorkDir 'symbols'
        $cdbWork = Join-Path $WorkDir 'cdb'
        New-Item -ItemType Directory -Force -Path $cdbWork | Out-Null
        $scriptFile = Join-Path $cdbWork ($dump.BaseName + '.script.txt')
        $inputFile = Join-Path $cdbWork ($dump.BaseName + '.stdin.txt')
        $commandText = ($cdbCommands -join "`r`n") + "`r`n"
        [System.IO.File]::WriteAllText($scriptFile, $commandText, (New-Object System.Text.ASCIIEncoding))
        [System.IO.File]::WriteAllText($inputFile, $commandText, (New-Object System.Text.ASCIIEncoding))
        try {
            $env:_NT_SYMBOL_PATH = "srv*$symbols*https://msdl.microsoft.com/download/symbols"
            $process = Start-Process -FilePath $cdb -PassThru -NoNewWindow `
                -ArgumentList @('-z', ('"{0}"' -f $dump.FullName), '-logo', ('"{0}"' -f $log), '-cf', ('"{0}"' -f $scriptFile)) `
                -RedirectStandardInput $inputFile `
                -RedirectStandardOutput (Join-Path $cdbWork ($dump.BaseName + '.stdout.txt')) `
                -RedirectStandardError (Join-Path $cdbWork ($dump.BaseName + '.stderr.txt'))
            if (-not $process.WaitForExit(300000)) {
                Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
                Add-CheckError ("cdb timed out on {0}" -f $dump.Name)
            }
            if (Test-Path -LiteralPath $log) {
                $text = [System.IO.File]::ReadAllText($log)
                $entry.analysis = (Split-Path -Leaf $log)
                # The faulting instruction with its memory operand (".ecxr"), the heap block the
                # registers point into and its allocation stack (page heap): column headers
                # together with the line of values under them.
                foreach ($pattern in @('ExceptionCode:\s*\S+[^\r\n]*', 'Attempt to read from address \S+', 'Attempt to write to address \S+',
                        'ExceptionAddress:\s*[^\r\n]+', 'System\+0x[0-9a-f]+', '[^\r\n]*(?:ds|es):002b:[0-9a-f`]+=[^\r\n]*',
                        'Current NtGlobalFlag contents:[^\r\n]+', '(?m)^[0-9a-f`]{8}\s+"[A-Za-z]:\\[^"\r\n]*"', 'address [0-9a-f`]+ found in[^\r\n]*',
                        'in busy allocation[^\r\n]*\r?\n[^\r\n]+', 'HEAP_ENTRY Size[^\r\n]*\r?\n[^\r\n]+',
                        '[^\r\n]*SHGetKnownFolderPath[^\r\n]*', '[^\r\n]*CoTaskMemAlloc[^\r\n]*')) {
                    foreach ($m in [regex]::Matches($text, $pattern, 'IgnoreCase')) {
                        $fact = ($m.Value -replace '\s+', ' ').Trim()
                        if ($entry.facts.Count -lt 16 -and $entry.facts -notcontains $fact) { $entry.facts += $fact }
                    }
                }
            }
        }
        catch {
            Add-CheckError ("cdb on {0}: {1}" -f $dump.Name, $_.Exception.Message)
        }
    }
    $check.dumps += $entry
}
if (-not $cdb -and $dumpFiles.Count -gt 0) { Add-CheckError 'cdb.exe not found; dumps kept without analysis' }
foreach ($key in $dumpKeys) { Remove-Item -LiteralPath $key -Recurse -Force -ErrorAction SilentlyContinue }

# --- verdict ---------------------------------------------------------------------------------------
# One-sided Fisher exact test: probability of at least $a baseline crashes when $a + $c crashes are
# spread over $n1 baseline and $n2 candidate runs at random (no difference between the two).
function Get-FisherOneSided([int] $a, [int] $n1, [int] $c, [int] $n2) {
    $k = $a + $c
    $n = $n1 + $n2
    if ($k -eq 0) { return 1.0 }
    $lnC = {
        param([int] $nn, [int] $kk)
        $s = 0.0
        for ($i = 1; $i -le $kk; $i++) { $s += [Math]::Log($nn - $kk + $i) - [Math]::Log($i) }
        return $s
    }
    $p = 0.0
    for ($x = $a; $x -le [Math]::Min($k, $n1); $x++) {
        if (($k - $x) -gt $n2) { continue }
        $p += [Math]::Exp((& $lnC $n1 $x) + (& $lnC $n2 ($k - $x)) - (& $lnC $n $k))
    }
    return [Math]::Min(1.0, $p)
}

$candidateCrashes = 0
$candidateRuns = 0
foreach ($phase in $check.phases) {
    $base = @($phase.byLabel | Where-Object { $_.label -eq 'baseline' })[0]
    $cand = @($phase.byLabel | Where-Object { $_.label -eq 'candidate' })[0]
    if ($cand) {
        $candidateCrashes += [int]$cand.crashes
        $candidateRuns += [int]$cand.runs
        if ($cand.runs -lt $phase.rounds) { Add-CheckError ("{0}: the candidate ran {1} of {2} rounds" -f $phase.phase, $cand.runs, $phase.rounds) }
    }
    if ($base -and $cand) {
        $phase.fisherP = [Math]::Round((Get-FisherOneSided ([int]$base.crashes) ([int]$base.runs) ([int]$cand.crashes) ([int]$cand.runs)), 6)
    }
}
$candidateStatic = @($check.static | Where-Object { $_.label -eq 'candidate' })[0]
# The crash counts decide; the static check only fails the candidate when it finds the
# unbounded read. "unknown" (a header this script cannot read) is reported in the summary.
$staticVulnerable = $candidateStatic -and $candidateStatic.verdict -eq 'vulnerable'
$check.ok = ($candidateRuns -gt 0) -and ($candidateCrashes -eq 0) -and (-not $staticVulnerable) -and ($check.errors.Count -eq 0 -or $candidateRuns -ge ($Rounds + $PageHeapRounds))
$check.verdict = ('candidate: {0} crashes in {1} installs, compiled {2}' -f $candidateCrashes, $candidateRuns, $(if ($candidateStatic) { $candidateStatic.verdict } else { 'unchecked' }))

# --- summary ----------------------------------------------------------------------------------------
$lines = @()
$lines += '## ModelForge installer crash check'
$lines += ''
$lines += ('User `{0}`; {1}.' -f $UserName, $check.verdict)
$lines += ''
$lines += '| Installer | sha256 | Compiled install-mode code |'
$lines += '|---|---|---|'
foreach ($installer in $installers) {
    $static = @($check.static | Where-Object { $_.label -eq $installer.label })[0]
    $detail = '(not checked)'
    if ($static) {
        $detail = ($static.verdict + ': ' + ((@($static.scripts) | ForEach-Object {
                        if ($_.decoded) {
                            $sample = $(if ($_.sample) { ' `{0}`' -f ($_.sample -replace '[`|]', '') } else { '' })
                            '{0} header ({1}, {2:N0} bytes): unbounded (&w<n> .s) {3}{4}, lstrcpynW {5}, SHGetKnownFolderPath {6}' -f $_.name, $_.compression,
                                [int]$_.headerBytes, $_.unboundedRead, $sample, $_.boundedCopy, $_.knownFolder
                        }
                        else { '{0} header not read ({1})' -f $_.name, $_.error }
                    }) -join '; '))
    }
    $lines += ('| {0} | `{1}` | {2} |' -f $installer.label, $installer.sha256.Substring(0, 12), $detail)
}
$lines += ''
$lines += '| Phase | Installer | Installs | OK | Crashed | Other failures | Not fresh | Exit codes | Median | Fisher p (one-sided) |'
$lines += '|---|---|---:|---:|---:|---:|---:|---|---:|---:|'
foreach ($phase in $check.phases) {
    foreach ($row in $phase.byLabel) {
        $p = ''
        if ($row.label -eq 'baseline' -and $phase.Contains('fisherP')) { $p = [string]$phase.fisherP }
        $lines += ('| {0} | {1} | {2} | {3} | {4} | {5} | {6} | {7} | {8:N1} s | {9} |' -f $phase.phase, $row.label, $row.runs, $row.ok,
            $row.crashes, $row.otherFailed, $row.notFresh, $row.exitCodes, ($row.medianMs / 1000.0), $p)
    }
}
$lines += ''
if ($check.phases.Count -gt 0) {
    $dirs = @()
    foreach ($installer in $installers) {
        $mine = @($check.phases | ForEach-Object { $_.byLabel } | Where-Object { $_.label -eq $installer.label } |
            ForEach-Object { @($_.installDirs -split '; ') } | Where-Object { $_ } | Select-Object -Unique)
        $dirs += ('{0}: {1}' -f $installer.label, $(if ($mine.Count) { $mine -join '; ' } else { '(none installed)' }))
    }
    $lines += ('Default per-user directories chosen by the installers: {0}' -f ($dirs -join ' | '))
    $lines += ''
}
if ($check.events.Count -gt 0) {
    $lines += '| Time (UTC) | Application | Module | Exception | Offset |'
    $lines += '|---|---|---|---|---|'
    foreach ($evt in ($check.events | Where-Object { $_.provider -eq 'Application Error' })) {
        $lines += ('| {0} | {1} | {2} | {3} | {4} |' -f $evt.at, $evt.application, $evt.module, $evt.exception, $evt.offset)
    }
    $lines += ''
}
foreach ($dump in ($check.dumps | Where-Object { $_.facts.Count -gt 0 })) {
    $lines += ('- dump `{0}` ({1}): {2}' -f $dump.file, $dump.label, (($dump.facts | ForEach-Object { $_ -replace '\|', '/' }) -join ' / '))
}
if ($check.cpSyncProbe) {
    $probe = $check.cpSyncProbe
    $lines += ''
    $lines += ('Test-runner probe on a directory with Chinese characters and a space: harness copy exit {0} ({1}); fs.cpSync exit {2}; fs.rmSync exit {3}, source left in place: {4}' -f
        $probe.copyTree.exitHex, $probe.copyTree.output, $probe.cpSync.exitHex, $probe.rmSync.exitHex, $probe.rmSyncLeftSource)
}
if ($check.errors.Count -gt 0) {
    $lines += ''
    $lines += 'Problems while checking:'
    foreach ($message in $check.errors) { $lines += ('- {0}' -f $message) }
}
$summary = ($lines -join "`n") + "`n"
[System.IO.File]::WriteAllText((Join-Path $results 'summary.md'), $summary, (New-Object System.Text.UTF8Encoding($false)))
if (-not $ResultFile) { $ResultFile = Join-Path $results 'crash-check.json' }
Write-SmokeResult -Result $check -Path $ResultFile | Out-Null
Write-Host $summary
if ($check.ok) { exit 0 } else { exit 1 }
