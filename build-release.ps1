# 在 Windows 上做 ModelForge 内核的发布构建（需求 3.1、3.2、3.3、3.5、3.7、3.8）
#
# 流程在 ui/desktop/scripts/release/build-release.mts（pnpm run release:build 也是它）：
#   resolve   校验完整 40 位 commit 存在（git rev-parse --verify <sha>^{commit}）
#   snapshot  git archive 导出到 ASCII 工作目录下的空目录，只含该 commit 受版本控制的文件
#   dirty     导出后、编译后各比对一次快照与 commit，有差异即终止
#   build     在快照中 cargo build --release --locked，经 GOOSE_BUILD_COMMIT / GOOSE_BUILD_DIRTY
#             把来源编进二进制
#   manifest  写 build-manifest.json（工具链、features、target、content、每个二进制的 SHA256）
#   verify    重新读取清单、重算 SHA256；dirty 为 true 或 SHA256 不一致即终止，列出文件名、
#             记录值与实际值
#   publish   全部通过后才放到输出目录
# 任一阶段失败都以非零退出码结束，并输出阶段名与原因，输出目录保持原样。
#
# 本脚本只做 Windows 上的准备，与 build-kernel.ps1 用同一套环境：MinGW-w64 GNU 工具链、
# ASCII 路径的 CARGO_HOME / RUSTUP_HOME（经 build-kernel.ps1 -ToolchainOnly 设置），
# 快照与编译目录放在 ASCII 路径的 -WorkDir 下，features 也与开发构建相同。
#
# 用法：
#   .\build-release.ps1 -Sha <完整 40 位 commit>
#   .\build-release.ps1 -Sha (git rev-parse HEAD) -WorkDir E:\goose-release -KeepSnapshot
#
# 产物：<WorkDir>\dist\<commit>\goose.exe 与 build-manifest.json（-OutDir 可改）
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Sha,
    [string]$WorkDir = 'E:\goose-release',
    [string]$OutDir,
    [string]$CargoHome = 'E:\cargo',
    [string]$RustupHome = 'E:\rustup',
    [switch]$KeepSnapshot
)
$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
$pipeline = Join-Path $repo 'ui\desktop\scripts\release\build-release.mts'

# MinGW 的 ld/dlltool 打不开中文路径，快照与 target 目录都在 WorkDir 下
if ($WorkDir -notmatch '^[\x20-\x7e]+$') {
    throw "WorkDir 必须是纯 ASCII 路径：$WorkDir"
}

Write-Host '=== 1. 准备 ASCII 工具链环境（同 build-kernel.ps1） ===' -ForegroundColor Cyan
$features = & (Join-Path $repo 'build-kernel.ps1') -ToolchainOnly -CargoHome $CargoHome -RustupHome $RustupHome
Write-Host "  features: $features"

Write-Host '=== 2. 发布构建 ===' -ForegroundColor Cyan
$pipelineArgs = @(
    $pipeline, '--sha', $Sha, '--repo', $repo, '--work-dir', $WorkDir,
    '--no-default-features', '--features', $features
)
if ($OutDir) { $pipelineArgs += @('--out-dir', $OutDir) }
if ($KeepSnapshot) { $pipelineArgs += '--keep-snapshot' }
& node @pipelineArgs
if ($LASTEXITCODE -ne 0) {
    throw "发布构建失败，退出码 $LASTEXITCODE（失败阶段与原因见上方输出）"
}
