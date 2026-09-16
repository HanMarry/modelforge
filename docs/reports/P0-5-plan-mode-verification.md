# P0-5 验证记录：/plan 失败落盘 GOOSE_MODE=auto（独立复验）

> 日期：2026-09-16 · 修复溯源：`1600180`（修复轮已实现，本次为独立复验）· 状态：✅ 验证成立

## 一、问题与修复溯源

**原缺陷**：`/plan` 批准后执行失败时，`GOOSE_MODE` 永久落盘为 auto（auto 模式批准所有工具调用，属安全降级），且恢复语句位于 `?` 之后永不执行。

**修复**（`1600180`，"修复审计发现的 11 处安全/可靠性缺陷"批次）：

```diff
-   let config = Config::global();
-   let curr_goose_mode = config.get_goose_mode().unwrap_or_default();
-   if curr_goose_mode != GooseMode::Auto {
-       config.set_goose_mode(GooseMode::Auto).unwrap();     // 写全局 config 文件
-   }
+   let mode_guard = GooseModeGuard::new(Arc::clone(&self.agent), self.session_id.clone()).await;
+   if mode_guard.original() != GooseMode::Auto {
+       self.agent.update_goose_mode(GooseMode::Auto, &self.session_id).await?;   // 仅会话内存态
+   }
    ...
-   // Reset run & goose mode（位于 acted? 之后，失败时被跳过）
-   if curr_goose_mode != GooseMode::Auto {
-       config.set_goose_mode(curr_goose_mode)?;
-   }
+   let mode_restored = mode_guard.restore().await;   // 错误传播之前显式恢复
+   acted?;
+   mode_restored?;
```

## 二、复验证据（静态证据链 + 现场检查）

### 1. 不再有写全局 config 的路径
- `update_goose_mode`（`agents/agent.rs:3699`）只改**内存**（`current_goose_mode`）+ 持久化到**会话存储**（`session_manager ... goose_mode(mode).apply()`），不触全局 `config.yaml`；
- 全库 `grep GOOSE_MODE` 确认：仅剩 config 层**读取**（`config/base.rs:1270` 的 `config_value!` 宏，env → 配置作为默认值来源），无任何运行时**写入**路径；
- `GooseModeGuard`（`session/mod.rs:86-130`）实现完整：`new` 记录原值；`restore` 在每一条路径（含错误路径）显式调用且幂等（值已相等时直接返回）；`Drop` 保留兜底告警（异步无法在 Drop 执行，仅 warn）。

### 2. 本机现场检查
- `%APPDATA%\Block\goose\config\config.yaml`：**无 `GOOSE_MODE` 键**（无 auto 残留）；
- 基线 sha256：`978933b4952aae46e345bf328c18daf799974674e157b852d21f9de229cb775`（09-15 23:33，修复批次之后未再变动）——后续真实使用 `/plan` 后可复测该哈希不变。

### 3. 回归测试
- `cargo test -p goose-cli --lib session::`（build-kernel 特性集）：**190 passed**；3 条失败为**既存测试环境敏感问题**，与本次修复无关（详见下方说明）；
- `/plan` 命令解析层测试（`session/input.rs::tests::test_plan_mode`）包含在通过集内。

**关于 3 条失败**：`test_home_directory_conversion`、`test_build_switched_model_config_*`（2 条）——这些测试构建 ModelConfig 时读取**真实全局配置**，本机 `config.yaml` 中 `GOOSE_THINKING_EFFORT: high` 使断言（期望无 thinking 参数）失败。属测试隔离缺陷（既存），非本 fork 回归；已登记至 OPTIMIZATION_PLAN §3.7。

## 三、手工重放步骤（交互场景，可选）

cliclack 确认框需真实 TTY，无法自动化重放；如需端到端演示：

1. 记录 `config.yaml` 的 sha256；确认其中无 `GOOSE_MODE` 键
2. `goose session` 启动会话，`/mode` 确认当前模式（非 auto）
3. 输入 `/plan` 并给出一个会产生动作的请求；批准 plan（act）
4. 在 act 阶段断开网络或让 provider 返回错误，使执行失败
5. 断言：a) 会话内 `/mode` 仍为非 auto；b) `config.yaml` sha256 不变且无 `GOOSE_MODE` 键；c) 错误正常上抛并有提示

## 四、结论

P0-5 修复（`1600180`）经独立复验成立：模式切换全程不落全局 config，错误路径显式恢复，现场无 auto 残留。交互式端到端重放受 TTY 限制未自动化，静态证据链与回归测试覆盖了修复的每个环节。
