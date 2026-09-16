# P0-3 验证记录：compile_latex 假成功与残留

> 日期：2026-09-16 · 修复提交：`d0e56ec` · 状态：✅ 已修复并验证

## 一、修复内容

| 问题（审查结论） | 修法 |
|------|------|
| 编译前不清旧产物 → 旧 PDF 冒充成功 | 编译前 best-effort 删除目标 PDF，并记录 `started_at` 供校验 |
| 失败/超时残留半成品 | 校验失败与编译失败/超时路径均清除目标 PDF |
| 仅验 5 字节头 | `validate_pdf(path, started_at)` 四重校验：>1 KiB、mtime 不早于启动（2 s 容差容忍文件系统时间精度）、`%PDF-` 头、尾部 1 KiB 内含 `%%EOF` |
| 超时不杀孙进程（latexmk→pdflatex 存活持锁） | `tokio::select!`：超时分支在**直接子进程存活时**显式 `taskkill /F /T`（Windows）或 `kill -KILL -pgid`（Unix，spawn 时 `process_group(0)` 使子进程成为进程组组长）|

涉及文件：`crates/goose-mcp/src/modeling/mod.rs`（+`kill_process_tree` 辅助函数）、`crates/goose-mcp/src/subprocess.rs`（OnceLock import 按 cfg 收窄，消除 Windows 编译警告）。

> 设计说明：最初尝试用 `process-wrap` 的 JobObject/KillOnDrop 实现杀树，实测孙进程仍存活（直接子进程被杀、孙进程逃脱——分层诊断定位），改为显式杀树方案后一次通过。显式方案不依赖 drop 语义，且覆盖"父存活时杀树"的关键时序。

## 二、验证证据（goose-build，GNU 工具链）

### 常规测试（8 通过）

```
cargo test -p goose-mcp modeling::
test result: ok. 8 passed; 0 failed; 3 ignored
```

含新增用例 `missing_empty_or_non_pdf_output_is_not_success` 扩展：空文件/过小/截断（无 %%EOF）/陈旧 mtime 全部拒绝，完整形态通过。

### 手动验证测试（3 项全过）

```
cargo test -p goose-mcp modeling::tests -- --ignored
test result: ok. 3 passed; 0 failed
```

1. **`timeout_terminates_the_whole_process_tree`**：直接子进程（powershell）与孙进程（Start-Process 启动）均记录 pid；2 s 超时后断言 **两者都已终止**——此前仅在孙进程层面失败（`grandchild=true`），修复后通过。
2. **`failed_compilation_does_not_leave_a_stale_pdf_behind`**：先正常编译出 PDF → 改坏源文件重编译失败 → 断言旧 PDF **不存在**（核心防"假成功"场景）。
3. **`real_latex_compilation_resolves_inputs_and_writes_separate_output`**：TeX Live 2024 真实编译，四重校验对真实产物兼容（2.77 s）。

### 静态检查

`cargo check -p goose-mcp` ✅ 无警告（含 `subprocess.rs` cfg 收窄）。

## 三、遗留说明

- `latexmk` 硬编码 `-pdf`（模板需 xelatex 的引擎不匹配问题）属 P1-3.2，另行处理。
- Unix 分支（`process_group` + `kill -KILL -pgid`）在本机（Windows）无法运行验证，已按 std 稳定 API 实现并在编译期检查；首次在 Unix 环境使用时建议重跑 `timeout_terminates_the_whole_process_tree`。
