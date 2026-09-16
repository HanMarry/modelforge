# 启动 ModelForge 桌面端（开发模式，使用自编译的 Rust 内核）
#
# 开发模式下桌面端按顺序找内核：
#   1. 环境变量 GOOSE_BINARY 指向的文件
#   2. ui/desktop/src/bin/goose.exe
#   3. ../../target/release/goose.exe
#   4. ../../target/debug/goose.exe
# 本机项目路径含中文，编译必须先复制到 ASCII 目录（见 build-kernel.ps1），
# 因此这里用 GOOSE_BINARY 显式指定那份产物。
#
# 用法：
#   .\start-modelforge.ps1                 # 用 debug 内核
#   .\start-modelforge.ps1 -Release        # 用 release 内核
#   .\start-modelforge.ps1 -Binary <path>  # 指定任意内核（例如官方发布版做对比）

[CmdletBinding()]
param(
    [switch]$Release,
    [string]$BuildDir = 'E:\goose-build',
    [string]$Binary
)

$ErrorActionPreference = 'Stop'

if (-not $Binary) {
    $profile = if ($Release) { 'release' } else { 'debug' }
    $Binary = Join-Path $BuildDir "target\$profile\goose.exe"
}
if (-not (Test-Path $Binary)) {
    throw "找不到内核: $Binary`n先运行 .\build-kernel.ps1$(
        if ($Release) { ' -Release' })"
}

$env:GOOSE_BINARY = $Binary
$env:GOOSE_TELEMETRY_OFF = '1'   # 白标双保险：即使配置里开了也不上报

Write-Host "内核: $Binary" -ForegroundColor Green
& $Binary --version

Write-Host '启动桌面端（Electron 开发模式）…' -ForegroundColor Cyan
Push-Location (Join-Path $PSScriptRoot 'ui\desktop')
try {
    # pnpm 需 >= 10.30（package.json 的 engines 会拒绝更低版本）
    npx --yes pnpm@10.30.0 exec electron-forge start
} finally {
    Pop-Location
}
