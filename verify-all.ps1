# ModelForge 一键验收脚本
#
# 用途：固化仓库验收基线，逐项跑通并输出 PASS/FAIL + 耗时，末尾打印汇总表。
#       任一检查 FAIL 则脚本以非零退出码结束，可用于 CI / 提交前自检。
#
# 用法：
#   .\verify-all.ps1                    # 跑全部验收项
#   .\verify-all.ps1 -SkipRust          # 跳过 Rust 部分（快检，只跑桌面 + git 基线）
#   .\verify-all.ps1 -SkipUi            # 跳过桌面部分
#   pwsh -NoProfile -File verify-all.ps1 -SkipRust   # 非交互式调用
#
# 环境前提：
#   - Windows PowerShell 5.1 或 PowerShell 7+
#   - Git for Windows（git 在 PATH 中）
#   - Node.js + pnpm（桌面端依赖已在 ui/node_modules 装好）
#   - Rust 工具链：RUSTUP_TOOLCHAIN=1.96.1-x86_64-pc-windows-gnu
#     CARGO_HOME=E:\cargo  RUSTUP_HOME=E:\rustup
#   - 源码 ASCII junction：E:\goose-en  指向本仓库（中文路径下 Rust 必须走这条）
#   - NASM：PATH 含 E:\nasm\nasm-2.16.03（ring crate 编译依赖）
#   - 临时目录：E:\mftmp（hints 测试用，避免 bash TMP 含 .git 误判 git root）
#
# 验收基线（2026-09-16 安静环境实测值，提交 9f5af7f）：
#   git status           空（工作区干净）
#   tsc --noEmit         0 error
#   vitest run           948 passed / 0 failed / 17 skipped
#   i18n-check           全绿
#   i18n-validate-locale 15 locale 全绿
#   cargo fmt --check    0
#   clippy goose-mcp     0 warning (-D warnings)
#   goose-mcp modeling   11 passed
#   goose hints          44/44

[CmdletBinding()]
param(
    [switch]$SkipRust,
    [switch]$SkipUi
)

$ErrorActionPreference = 'Stop'

# ========== 路径配置 ==========
$RepoRoot     = $PSScriptRoot
$UiDesktopDir = Join-Path $RepoRoot 'ui\desktop'
$RustJunction = 'E:\goose-en'
$TmpDir       = 'E:\mftmp'
$CargoHome    = 'E:\cargo'
$RustupHome   = 'E:\rustup'
$Toolchain    = '1.96.1-x86_64-pc-windows-gnu'
$NasmPath     = 'E:\nasm\nasm-2.16.03'

# ========== 结果收集 ==========
$results = @()

function Add-Result {
    param(
        [string]$Name,
        [string]$Status,
        [double]$Seconds,
        [string]$Detail = ''
    )
    $global:results += [pscustomobject]@{
        Name    = $Name
        Status  = $Status
        Seconds = [math]::Round($Seconds, 1)
        Detail  = $Detail
    }
}

function Invoke-Check {
    param(
        [string]$Name,
        [scriptblock]$ScriptBlock,
        [string]$WorkingDir = $RepoRoot
    )
    Write-Host "`n=== $Name ===" -ForegroundColor Cyan
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $output = @()
    try {
        Push-Location $WorkingDir
        # 脚本块返回值：$null 或 0 = PASS，非零整数 = FAIL（作为退出码）
        # 脚本块内通过 $output = ... 收集输出；我们也捕获 2>&1 输出
        $script:checkExitCode = 0
        $output = & $ScriptBlock 2>&1
        # 如果脚本块显式设置了 $script:checkExitCode，用它
        # 否则用 $LASTEXITCODE（由脚本块内最后一条外部命令设置）
        if ($script:checkExitCode -ne 0) {
            $exitCode = $script:checkExitCode
        } else {
            $exitCode = $LASTEXITCODE
        }
    } catch {
        $exitCode = 999
        $output = "异常: $($_.Exception.Message)"
    } finally {
        Pop-Location
    }
    $sw.Stop()

    # 提取关键信息作为 detail（取最后 3 条非空字符串行）
    $textLines = @()
    foreach ($line in $output) {
        if ($line -is [string] -and $line.Trim() -ne '') {
            $textLines += $line.Trim()
        } elseif ($line -and $line.ToString().Trim() -ne '') {
            $textLines += $line.ToString().Trim()
        }
    }
    $lastLines = ($textLines | Select-Object -Last 3) -join " | "
    if ($lastLines.Length -gt 180) { $lastLines = $lastLines.Substring(0, 180) + '...' }

    if ($exitCode -eq 0) {
        Write-Host "PASS  $($sw.Elapsed.ToString('s\.f'))s" -ForegroundColor Green
        if ($lastLines) { Write-Host "  $lastLines" -ForegroundColor DarkGray }
        Add-Result -Name $Name -Status 'PASS' -Seconds $sw.Elapsed.TotalSeconds -Detail $lastLines
    } else {
        Write-Host "FAIL  $($sw.Elapsed.ToString('s\.f'))s  (exit=$exitCode)" -ForegroundColor Red
        if ($lastLines) { Write-Host "  $lastLines" -ForegroundColor DarkYellow }
        Add-Result -Name $Name -Status 'FAIL' -Seconds $sw.Elapsed.TotalSeconds -Detail "exit=$exitCode; $lastLines"
    }
}

# ========== 0. 环境预检 ==========
Write-Host "ModelForge 一键验收" -ForegroundColor Cyan
Write-Host "仓库: $RepoRoot"
Write-Host "日期: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host "跳过: $(if ($SkipRust) { 'Rust ' })$(if ($SkipUi) { 'UI ' })$(if (-not $SkipRust -and -not $SkipUi) { '无' })"

# ========== 1. Git 基线 ==========
Invoke-Check -Name 'git status (工作区干净)' -ScriptBlock {
    $out = git status --porcelain 2>&1
    if ($out) {
        Write-Host "工作区有未提交改动：" -ForegroundColor Yellow
        $out | ForEach-Object { Write-Host "  $_" }
        $script:checkExitCode = 1
    }
}

# ========== 2. 桌面验收 ==========
if (-not $SkipUi) {
    if (-not (Test-Path $UiDesktopDir)) {
        Write-Host "SKIP  桌面目录不存在: $UiDesktopDir" -ForegroundColor Yellow
        Add-Result -Name '桌面 (目录缺失)' -Status 'SKIP' -Seconds 0 -Detail "$UiDesktopDir 不存在"
    } else {
        # 2a. tsc --noEmit
        Invoke-Check -Name 'tsc --noEmit' -WorkingDir $UiDesktopDir -ScriptBlock {
            pnpm exec tsc --noEmit 2>&1
        }

        # 2b. vitest run
        Invoke-Check -Name 'vitest run (桌面单测)' -WorkingDir $UiDesktopDir -ScriptBlock {
            pnpm exec vitest run 2>&1
        }

        # 2c. i18n-check
        Invoke-Check -Name 'i18n-check' -WorkingDir $UiDesktopDir -ScriptBlock {
            node scripts/i18n-check.js 2>&1
        }

        # 2d. i18n-validate-locale
        Invoke-Check -Name 'i18n-validate-locale' -WorkingDir $UiDesktopDir -ScriptBlock {
            node scripts/i18n-validate-locale.js 2>&1
        }
    }
}

# ========== 3. Rust 验收 ==========
if (-not $SkipRust) {
    if (-not (Test-Path $RustJunction)) {
        Write-Host "SKIP  Rust junction 不存在: $RustJunction" -ForegroundColor Yellow
        Add-Result -Name 'Rust (junction 缺失)' -Status 'SKIP' -Seconds 0 -Detail "$RustJunction 不存在"
    } else {
        # 设置 Rust 环境变量
        $env:CARGO_HOME      = $CargoHome
        $env:RUSTUP_HOME     = $RustupHome
        $env:RUSTUP_TOOLCHAIN = $Toolchain
        $env:CARGO_TARGET_DIR = 'E:\goose-en-target'
        # 加 NASM 到 PATH（ring 等 crate 编译需要）
        if ($env:PATH -notlike "*$NasmPath*") {
            $env:PATH = "$NasmPath;$env:PATH"
        }

        # 确认 cargo 可用
        $cargoBin = Join-Path $CargoHome 'bin\cargo.exe'
        if (-not (Test-Path $cargoBin)) {
            Write-Host "SKIP  找不到 cargo: $cargoBin" -ForegroundColor Yellow
            Add-Result -Name 'Rust (cargo 缺失)' -Status 'SKIP' -Seconds 0 -Detail "$cargoBin 不存在"
        } else {
            $cargo = $cargoBin

            # 3a. cargo fmt --all --check
            Invoke-Check -Name 'cargo fmt --all --check' -WorkingDir $RustJunction -ScriptBlock {
                & $cargo fmt --all --check 2>&1
            }

            # 3b. cargo clippy -p goose-mcp --lib -- -D warnings
            Invoke-Check -Name 'cargo clippy -p goose-mcp --lib -D warnings' -WorkingDir $RustJunction -ScriptBlock {
                & $cargo clippy -p goose-mcp --lib -- -D warnings 2>&1
            }

            # 3c. cargo test -p goose-mcp modeling --lib
            Invoke-Check -Name 'cargo test -p goose-mcp modeling --lib' -WorkingDir $RustJunction -ScriptBlock {
                & $cargo test -p goose-mcp modeling --lib 2>&1
            }

            # 3d. hints 测试（必须自定义 TMP/TEMP，否则 bash TMP 祖先含 .git 会误判 git root）
            #     确保 E:\mftmp 存在
            if (-not (Test-Path $TmpDir)) {
                New-Item -ItemType Directory -Path $TmpDir -Force | Out-Null
            }
            Invoke-Check -Name 'cargo test -p goose hints --lib (TMP=mftmp)' -WorkingDir $RustJunction -ScriptBlock {
                $env:TMP  = $script:TmpDir
                $env:TEMP = $script:TmpDir
                & $cargo test -p goose hints --lib 2>&1
            }
        }
    }
}

# ========== 汇总表 ==========
Write-Host "`n`n==================== 验收汇总 ====================" -ForegroundColor Cyan
$totalSeconds = 0
$passCount = 0
$failCount = 0
$skipCount = 0

foreach ($r in $results) {
    $totalSeconds += $r.Seconds
    switch ($r.Status) {
        'PASS' { $passCount++ }
        'FAIL' { $failCount++ }
        'SKIP' { $skipCount++ }
    }
    $color = switch ($r.Status) { 'PASS' { 'Green' } 'FAIL' { 'Red' } default { 'Yellow' } }
    Write-Host ("  {0,-5} {1,-45} {2,6}s" -f $r.Status, $r.Name, $r.Seconds) -ForegroundColor $color
    if ($r.Detail) {
        Write-Host ("         {0}" -f $r.Detail) -ForegroundColor DarkGray
    }
}

Write-Host "`n  总计: PASS=$passCount  FAIL=$failCount  SKIP=$skipCount  总耗时 $([math]::Round($totalSeconds, 1))s" -ForegroundColor Cyan

if ($failCount -gt 0) {
    Write-Host "  结果: FAIL（有 $failCount 项未通过）" -ForegroundColor Red
    $host.SetShouldExit(1)
    exit 1
} else {
    Write-Host "  结果: 全部通过" -ForegroundColor Green
    $host.SetShouldExit(0)
    exit 0
}
