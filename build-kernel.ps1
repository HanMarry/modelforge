# 编译 ModelForge 的 Rust 内核（goose CLI）
#
# 为什么需要这个脚本：这台机器上没有 Visual Studio 的 MSVC 工具链，但有完整的
# MinGW-w64 gcc，所以走 GNU 目标（x86_64-pc-windows-gnu）。而 MinGW 的 ld/dlltool
# 是 ANSI 路径 API，遇到中文路径会报 "cannot find ... .rlib" 或
# "dlltool: Can't create .lib file"。本机恰好项目路径（E:\桌面\智能体）和用户名
# （韩正阳）都含中文，因此必须：
#
#   1. 把源码复制到纯 ASCII 目录再编译（不能用 junction：cargo 会 canonicalize 回真实路径）
#   2. CARGO_HOME / RUSTUP_HOME 也指向 ASCII 路径
#
# 编译产物：<ASCII 源码目录>\target\debug\goose.exe
# 启动应用：.\start-modelforge.ps1
#
# 用法：
#   .\build-kernel.ps1                # 增量编译
#   .\build-kernel.ps1 -Release       # release 编译（更慢，二进制更小更快）
#   .\build-kernel.ps1 -SyncOnly      # 只同步源码到 ASCII 目录

[CmdletBinding()]
param(
    [switch]$Release,
    [switch]$SyncOnly,
    [string]$BuildDir = 'E:\goose-build',
    [string]$CargoHome = 'E:\cargo',
    [string]$RustupHome = 'E:\rustup'
)

$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot

Write-Host '=== 1. 同步源码到 ASCII 目录 ===' -ForegroundColor Cyan
Write-Host "  $repo  ->  $BuildDir"
New-Item -ItemType Directory -Path $BuildDir -Force | Out-Null
# 排除编译产物与依赖目录；.git 不需要（编译不读历史）
robocopy $repo $BuildDir /E /XD target node_modules .git .vite dist `
    /XF '*.log' /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy 失败，退出码 $LASTEXITCODE" }
Write-Host '  完成' -ForegroundColor Green

if ($SyncOnly) { return }

Write-Host '=== 2. 准备 ASCII 工具链环境 ===' -ForegroundColor Cyan
foreach ($dir in @($CargoHome, $RustupHome)) {
    if (-not (Test-Path $dir)) {
        throw "缺少 $dir。首次使用请先安装 rustup（见 REPLICATION_PLAN.md 的 §编译内核）"
    }
}
$env:CARGO_HOME = $CargoHome
$env:RUSTUP_HOME = $RustupHome
$env:RUSTUP_TOOLCHAIN = '1.96.1-x86_64-pc-windows-gnu'   # 与 rust-toolchain.toml 同版本，GNU host
$env:RUSTFLAGS = '-C target-feature=+crt-static'          # 静态链接 MinGW 运行时，免 DLL 依赖
$env:CARGO_TERM_COLOR = 'never'

# gcc / ar / dlltool / cmake / nasm 来自 Strawberry Perl 自带的 MinGW-w64
$mingw = 'C:\Strawberry\c\bin'
if (Test-Path $mingw) { $env:PATH = "$CargoHome\bin;$mingw;$env:PATH" }
else { $env:PATH = "$CargoHome\bin;$env:PATH" }

Write-Host "  CARGO_HOME=$CargoHome"
Write-Host "  RUSTUP_HOME=$RustupHome"
Write-Host "  RUSTUP_TOOLCHAIN=$env:RUSTUP_TOOLCHAIN"
Write-Host "  RUSTFLAGS=$env:RUSTFLAGS"

Write-Host '=== 3. 编译 ===' -ForegroundColor Cyan
# 特性取舍（见 REPLICATION_PLAN.md）：不带 code-mode（它拉进的 v8-goose 在 GNU 目标上
# 没有预编译包，会去源码构建 V8）与 local-inference（要编译 llama.cpp）。
$features = 'rustls-tls,system-keyring,telemetry,otel,aws-providers,update,nostr'
$args = @('build', '-p', 'goose-cli', '--bin', 'goose', '--no-default-features', '--features', $features)
if ($Release) { $args += '--release' }

Push-Location $BuildDir
try {
    & cargo @args
    if ($LASTEXITCODE -ne 0) { throw "cargo build 失败，退出码 $LASTEXITCODE" }
} finally {
    Pop-Location
}

$profile = if ($Release) { 'release' } else { 'debug' }
$binary = Join-Path $BuildDir "target\$profile\goose.exe"
if (-not (Test-Path $binary)) { throw "没有产出 $binary" }

Write-Host '=== 4. 验证产物 ===' -ForegroundColor Cyan
& $binary --version
$builtinCount = (& $binary skills list 2>&1 | Select-String -Pattern 'builtin://' | Measure-Object).Count
Write-Host "  内置技能: $builtinCount 个（应为 47）"
Write-Host ""
Write-Host "内核已就绪: $binary" -ForegroundColor Green
Write-Host "启动应用:   .\start-modelforge.ps1$(if ($Release) { ' -Release' })"
