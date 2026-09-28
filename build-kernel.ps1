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
# 构建来源（需求 3.3、3.4）：
#   - 同步用 robocopy /MIR：源码树里删掉的文件也会从 ASCII 目录删掉，不留残留；
#     target、node_modules 等排除项不受影响，增量编译缓存保留
#   - 同步前用 git status --porcelain --untracked-files=normal 判定 dirty（有已修改、
#     已暂存或未跟踪的文件即为 true），连同 HEAD 经 GOOSE_BUILD_COMMIT / GOOSE_BUILD_DIRTY
#     交给 crates/goose-cli/build.rs 编进二进制（ASCII 目录里没有 .git）
#   - 编译后在 goose.exe 同目录写 build-manifest.json（buildType "dev"）
#   这两步由 ui/desktop/scripts/release/dev-manifest.mts 完成，需要 Node 24.10 以上。
#
# 编译产物：<ASCII 源码目录>\target\debug\goose.exe 与 build-manifest.json
# 启动应用：.\start-modelforge.ps1
#
# 用法：
#   .\build-kernel.ps1                # 增量编译
#   .\build-kernel.ps1 -Release       # release 编译（更慢，二进制更小更快）
#   .\build-kernel.ps1 -SyncOnly      # 只同步源码到 ASCII 目录
#   .\build-kernel.ps1 -ToolchainOnly # 只检查 Node、设置工具链环境变量，并输出 Kernel 的
#                                     # features 列表（build-release.ps1 用它复用同一套环境）
[CmdletBinding()]
param(
    [switch]$Release,
    [switch]$SyncOnly,
    [switch]$ToolchainOnly,
    [string]$BuildDir = 'E:\goose-build',
    [string]$CargoHome = 'E:\cargo',
    [string]$RustupHome = 'E:\rustup'
)
$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
$devManifest = Join-Path $repo 'ui\desktop\scripts\release\dev-manifest.mts'
# 特性取舍（见 REPLICATION_PLAN.md）：不带 code-mode（它拉进的 v8-goose 在 GNU 目标上
# 没有预编译包，会去源码构建 V8）与 local-inference（要编译 llama.cpp）。
$features = 'rustls-tls,system-keyring,telemetry,otel,aws-providers,update,nostr'

# 发布脚本与构建清单都由 Node 直接运行 TypeScript（类型擦除），要求与 ui/desktop 的
# engines 一致：Node 24.10 以上。
function Assert-Node {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        throw '找不到 node。生成 build-manifest.json 需要 Node 24.10 以上，请先安装并加入 PATH'
    }
    $text = (& node --version).Trim()
    $version = [version]($text.TrimStart('v'))
    if ($version -lt [version]'24.10.0') {
        throw "node $text 太旧：生成 build-manifest.json 需要 Node 24.10 以上"
    }
    Write-Host "  node $text ($($node.Source))"
}

function Initialize-KernelToolchain {
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
}

# 调用 dev-manifest.mts，失败时抛出（失败阶段与原因已由脚本打印到 stderr）
function Invoke-DevManifest {
    param([string[]]$Arguments)
    $output = & node $devManifest @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "dev-manifest.mts $($Arguments[0]) 失败，退出码 $LASTEXITCODE"
    }
    return $output
}

if ($ToolchainOnly) {
    Assert-Node
    Initialize-KernelToolchain
    return $features
}

# /MIR 会删除目标目录里源码树没有的文件，目标目录必须是专用的编译目录
$buildFull = [IO.Path]::GetFullPath($BuildDir).TrimEnd('\')
$repoFull = [IO.Path]::GetFullPath($repo).TrimEnd('\')
$isDriveRoot = $buildFull.Length -le 2
$overlaps = (
    ($buildFull -ieq $repoFull) -or
    $repoFull.StartsWith("$buildFull\", [StringComparison]::OrdinalIgnoreCase) -or
    $buildFull.StartsWith("$repoFull\", [StringComparison]::OrdinalIgnoreCase)
)
if ($isDriveRoot -or $overlaps) {
    throw "BuildDir 必须是与源码树互不包含的专用目录（robocopy /MIR 会清掉其中多余的文件）：$BuildDir"
}

if (-not $SyncOnly) {
    Write-Host '=== 1. 记录源码状态 ===' -ForegroundColor Cyan
    Assert-Node
    $state = Invoke-DevManifest @('source-state', '--repo', $repo) | ConvertFrom-Json
    $dirtyText = if ($state.dirty) { 'true' } else { 'false' }
    Write-Host "  commit: $($state.commit)"
    Write-Host "  dirty:  $dirtyText"
    foreach ($change in @($state.changes | Select-Object -First 10)) { Write-Host "    $change" }
    if (@($state.changes).Count -gt 10) { Write-Host "    ……共 $(@($state.changes).Count) 项" }
}

Write-Host '=== 2. 同步源码到 ASCII 目录 ===' -ForegroundColor Cyan
Write-Host "  $repo  ->  $BuildDir"
New-Item -ItemType Directory -Path $BuildDir -Force | Out-Null
# 排除编译产物与依赖目录；.git 不需要（编译不读历史，worktree 里的 .git 是文件）
robocopy $repo $BuildDir /MIR /XD target node_modules .git .vite dist `
    /XF '*.log' .git /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy 失败，退出码 $LASTEXITCODE" }
Write-Host '  完成' -ForegroundColor Green
if ($SyncOnly) { return }

Write-Host '=== 3. 准备 ASCII 工具链环境 ===' -ForegroundColor Cyan
Initialize-KernelToolchain

Write-Host '=== 4. 编译 ===' -ForegroundColor Cyan
$cargoArgs = @('build', '-p', 'goose-cli', '--bin', 'goose', '--no-default-features', '--features', $features)
if ($Release) { $cargoArgs += '--release' }
$env:GOOSE_BUILD_COMMIT = $state.commit
$env:GOOSE_BUILD_DIRTY = $dirtyText
Push-Location $BuildDir
try {
    & cargo @cargoArgs
    if ($LASTEXITCODE -ne 0) { throw "cargo build 失败，退出码 $LASTEXITCODE" }
} finally {
    Pop-Location
    # 不留在当前会话里，免得之后在仓库里直接 cargo build 记下过时的 commit
    Remove-Item Env:GOOSE_BUILD_COMMIT, Env:GOOSE_BUILD_DIRTY -ErrorAction SilentlyContinue
}
$profileName = if ($Release) { 'release' } else { 'debug' }
$binary = Join-Path $BuildDir "target\$profileName\goose.exe"
if (-not (Test-Path $binary)) { throw "没有产出 $binary" }

Write-Host '=== 5. 验证产物 ===' -ForegroundColor Cyan
& $binary --version
$builtinCount = (& $binary skills list 2>&1 | Select-String -Pattern 'builtin://' | Measure-Object).Count
Write-Host "  内置技能: $builtinCount 个（应为 47）"

Write-Host '=== 6. 生成 build-manifest.json ===' -ForegroundColor Cyan
Invoke-DevManifest @(
    'write', '--binary', $binary, '--commit', $state.commit, '--dirty', $dirtyText,
    '--source-root', $BuildDir
) | ForEach-Object { Write-Host "  $_" }
Write-Host ""
Write-Host "内核已就绪: $binary" -ForegroundColor Green
Write-Host "启动应用:   .\start-modelforge.ps1$(if ($Release) { ' -Release' })"
