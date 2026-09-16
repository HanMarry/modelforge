# ModelForge 修复清单

## P0-1: API Key 保存静默失效修复方案

### 问题诊断
**根因链路**：
1. 用户配置 Custom Provider 时，`providerId` 可能为空字符串
2. `agentKernel.ts:272` → `status.providerId = goose.activeProvider`（空字符串）
3. UI `AgentKernelSection.tsx:224` → `if (!status?.providerId) return;` 静默拒绝
4. 结果：按钮可点但不保存，无任何提示

**复现路径**：
- 添加自定义 Provider 但未正确解析 ID
- 或首次启动未配置任何 Provider
- `settings.json` 中 `agentKernel.providerId: ""`

### 修复方案（三处协同）

#### 1. UI 层：禁用保存按钮并显示原因
**文件**：`ui/desktop/src/components/settings/app/AgentKernelSection.tsx`

**位置 A**：第 224-226 行（saveKey 函数）
```typescript
const saveKey = async () => {
  // 修复前：
  if (!apiKey.trim() || !status?.providerId) {
    return;  // 静默失败
  }
  
  // 修复后：
  if (!apiKey.trim()) {
    return;
  }
  if (!status?.providerId) {
    setNotice(intl.formatMessage(i18n.keyNotSavedNoProvider));
    return;
  }
```

**位置 B**：第 391-393 行（保存按钮）
```typescript
// 修复前：
<button
  type="button"
  disabled={isBusy || !apiKey.trim()}
  
// 修复后：
<button
  type="button"
  disabled={isBusy || !apiKey.trim() || !status?.providerId}
  title={!status?.providerId ? intl.formatMessage(i18n.keyButtonDisabledReason) : ''}
```

**位置 C**：添加 i18n 消息（第 13-172 行 defineMessages 块内）
```typescript
keyNotSavedNoProvider: {
  id: 'agentKernelSection.keyNotSavedNoProvider',
  defaultMessage: 'Provider not resolved — save the provider settings first.',
},
keyButtonDisabledReason: {
  id: 'agentKernelSection.keyButtonDisabledReason',
  defaultMessage: 'Save provider settings before adding a key',
},
```

#### 2. Provider 表单：编辑时要求重填密钥
**文件**：`ui/desktop/src/components/settings/providers/modal/subcomponents/forms/CustomProviderForm.tsx`

**问题**：第 456-458 行允许空密钥提交
```typescript
// 修复前：
const api_key = formData.get('api_key')?.toString() ?? '';
// 空串也能通过

// 修复后（需要查看完整逻辑后确定修复点）
```

#### 3. 增强测试：重启后密钥仍然可用
**文件**：`ui/desktop/src/utils/agentKernel.test.ts`

**新增测试用例**：
```typescript
it('persists kernel key across manager recreation', () => {
  const codec = createTestCodec();
  const store = createMemorySecretStore();
  const manager1 = createAgentKernelManager({ codec, secrets: store, ... });
  
  manager1.setKernelKey('custom_deepseek', 'sk-test-key');
  manager1.dispose();
  
  const manager2 = createAgentKernelManager({ codec, secrets: store, ... });
  const status = manager2.getStatus();
  
  expect(status.apiKeySource).toBe('kernel');  // 应该能读回来
});
```

---

## P0-2: LaTeX 编译假成功修复方案

### 问题
**文件**：`crates/goose-mcp/src/modeling/mod.rs`

**问题点**：
1. 第 84,88 行：`kill_on_drop(true)` 只杀直接子进程，孙进程残留
2. 编译前不清理旧 PDF，残留文件可能被误判为成功
3. 只校验 `%PDF-`（5字节），损坏 PDF 可能通过

### 修复方案

**位置 A**：编译前清理（第 235 行附近，`CallToolResult::content` 之前）
```rust
// 删除旧的目标 PDF，避免误判残留文件
let target_pdf = output_dir.join("paper.pdf");
if target_pdf.exists() {
    let _ = fs::remove_file(&target_pdf);
}
```

**位置 B**：进程组清理（Windows Job Object / Unix Process Group）
```rust
// Windows: 使用 Job Object
#[cfg(windows)]
fn kill_tree(child: &Child) {
    use std::os::windows::process::CommandExt;
    // 创建 Job Object 并分配子进程
}

// Unix: 使用 process group
#[cfg(unix)]
fn kill_tree(child: &Child) {
    use nix::sys::signal::{killpg, Signal};
    use nix::unistd::Pid;
    let _ = killpg(Pid::from_raw(child.id() as i32), Signal::SIGKILL);
}
```

**位置 C**：增强 PDF 校验（第 299-306 行）
```rust
// 修复前：
let first_bytes = fs::read(&pdf_path).ok()
    .and_then(|bytes| bytes.get(..5).map(|s| s.to_vec()))
    .unwrap_or_default();
if first_bytes != b"%PDF-" {
    return Err(anyhow!("..."));
}

// 修复后：
let pdf_bytes = fs::read(&pdf_path)?;
if pdf_bytes.len() < 1024 {  // 太小必然损坏
    return Err(anyhow!("PDF file too small: {} bytes", pdf_bytes.len()));
}
if !pdf_bytes.starts_with(b"%PDF-") {
    return Err(anyhow!("Invalid PDF header"));
}
// 检查 EOF 标记
if !pdf_bytes.windows(5).any(|w| w == b"%%EOF") {
    return Err(anyhow!("PDF file incomplete (no %%EOF marker)"));
}
```

---

## P1-2: LaTeX 引擎与模板不匹配

### 问题
内置中文模板需要 `xelatex`，但代码硬编码 `-pdf`（即 pdflatex）

### 修复方案
**文件**：`crates/goose-mcp/src/modeling/mod.rs`

**位置**：第 281 行
```rust
// 修复前：
"latexmk" => vec!["-pdf", "-interaction=nonstopmode", "-halt-on-error"],

// 修复后：
"latexmk" => vec![
    "-xelatex",  // 改用 xelatex 引擎以支持中文
    "-interaction=nonstopmode",
    "-halt-on-error",
],
```

**注意**：xelatex 单遍编译不会自动重跑处理交叉引用，需手动调用两次或依赖 latexmk 的自动检测。

---

## 工程修复清单

### 已完成 ✅
1. **R1**: Git 提交基线（commit `ba7678e`）
2. **R1**: 创建 `modelforge` 分支并打 tag `modelforge-baseline-2026-09-15`
3. **R1**: 远程仓库重命名为 `upstream`
4. **R2**: 补充 `.gitignore`（`output/`, `dist/`, `.playwright-cli/`）

### 待执行 🔧
1. **R2**: 给 `strip-unshippable.js` 添加安全检查
2. **R3**: 在 `build-kernel.ps1` 添加双树差异提醒
3. **3.1**: 创建 fork 专用 CI workflow
4. **3.4**: 修复 4 个失败测试（2 个路径大小写 + 2 个超时）
5. **4.1**: 首启添加国内推荐 Provider（DeepSeek/通义/智谱）
6. **4.2**: `.disabled-by-default` 标记实现或删除

---

## 优先级排序（按修复顺序）

| 顺序 | 任务 | 收益 | 预计时间 |
|-----|------|------|---------|
| 1️⃣ | **P0-1 API Key 保存修复** | 应用真正可用 | 2 小时 |
| 2️⃣ | **P0-2 LaTeX 假成功修复** | 编译结果可靠 | 3 小时 |
| 3️⃣ | **R2 strip 安全检查** | 防止数据丢失 | 1 小时 |
| 4️⃣ | **3.4 修复 4 个测试** | 恢复质量信号 | 1 小时 |
| 5️⃣ | **4.1 国内 Provider** | 首启体验提升 | 4 小时 |
| 6️⃣ | **P1-2 LaTeX 引擎对齐** | 中文模板可用 | 30 分钟 |
| 7️⃣ | **3.1 Fork CI** | 自动质量门 | 4 小时 |
| 8️⃣ | **R3 双树提醒** | 减少编译错误 | 1 小时 |

---

## 验收标准

### P0-1 验收
```powershell
# 1. 启动应用
.\start-modelforge.ps1

# 2. 设置 → Agent Kernel → 选择 Claude Code
# 3. 保存 API Key（应该成功且有提示）
# 4. 重启应用
# 5. 检查日志：不应再出现 "缺少 API Key"
```

### P0-2 验收
```rust
// 运行包含强制编译的测试
cargo test -p goose-mcp modeling::tests::real_latex_compilation_with_chinese_template -- --include-ignored
```

### 全量验收
```bash
# 前端
cd ui/desktop
pnpm test:run --no-file-parallelism  # 应该 0 失败

# Rust
cd ../../
cargo test -p goose-mcp
cargo test -p goose --lib acp::server::extensions::tests

# 质量门
pnpm run lint:check
pnpm run brand:check
pnpm run docs:check
```
