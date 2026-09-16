# 错误处理策略分析

## 执行概览

**分析日期**: 2026-09-15  
**目标**: 统一 goose 代码库的错误处理策略（anyhow vs thiserror）  
**范围**: `crates/goose/src/` 目录

---

## 当前使用情况统计

### 库使用分布

| 错误处理库 | 使用文件数 | 占比 | 典型用途 |
|-----------|----------|------|---------|
| **anyhow** | 191 | 94.1% | 应用层错误传播、上下文添加 |
| **thiserror** | 12 | 5.9% | 库层自定义错误类型 |
| **总计** | 203 | 100% | - |

### thiserror 使用位置

完整的 12 个使用 thiserror 的文件：

1. `agents/extension.rs` - Extension 错误类型
2. `agents/platform_extensions/ext_manager.rs` - 扩展管理器错误
3. `config/base.rs` - 配置错误 (`ConfigError`)
4. `plugins/mod.rs` - 插件系统错误
5. `providers/azureauth.rs` - Azure 认证错误
6. `providers/formats/gcpvertexai.rs` - GCP Vertex AI 格式错误
7. `providers/gcpauth.rs` - GCP 认证错误
8. `providers/gcpvertexai.rs` - GCP Vertex AI 错误
9. `providers/oauth_device_flow.rs` - OAuth 设备流错误
10. `providers/provider_secrets.rs` - Provider 密钥管理错误
11. `recipe/build_recipe/mod.rs` - Recipe 构建错误
12. `recipe_deeplink.rs` - Recipe deeplink 错误

---

## 使用模式分析

### Pattern 1: anyhow 主导型（应用层）

**典型场景**: 
- Agent loop 主逻辑
- 工具执行流程
- 会话管理
- 状态机 operations

**示例**（来自 `acp/provider.rs`）:
```rust
use anyhow::{Context, Result};

fn acp_method_error(method: &str, error: agent_client_protocol::Error) -> anyhow::Error {
    let message = format!("ACP method `{method}` failed");
    anyhow::Error::new(error).context(message)
}

// 快速错误传播
let model = applied_model
    .lock()
    .map_err(|_| anyhow::anyhow!("applied_model lock poisoned"))?;
```

**优势**:
- ✅ 简洁的错误传播 (`?` 操作符)
- ✅ 灵活的上下文添加 (`.context()`)
- ✅ 适合应用层快速迭代
- ✅ 无需定义大量错误枚举

**劣势**:
- ⚠️ 类型信息丢失（运行时错误匹配）
- ⚠️ 调用者无法精确匹配错误类型

### Pattern 2: thiserror 精确型（库层）

**典型场景**:
- 公开 API 边界
- 需要精确错误分类的场景
- Provider 认证和配置
- 插件和扩展系统

**示例**（来自 `providers/provider_secrets.rs`）:
```rust
#[derive(Debug, thiserror::Error)]
pub enum DeleteProviderSecretError {
    #[error("Invalid provider secret id: '{0}'")]
    InvalidId(String),
    
    #[error(transparent)]
    Config(#[from] ConfigError),
    
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}
```

**优势**:
- ✅ 类型安全的错误分类
- ✅ 编译期错误检查
- ✅ 调用者可精确匹配和处理
- ✅ 自动实现 `Error` trait

**劣势**:
- ⚠️ 需要预定义所有错误变体
- ⚠️ 增加样板代码

### Pattern 3: 混合型（边界转换）

**常见模式**: thiserror 定义 + anyhow 传播

```rust
#[derive(Debug, thiserror::Error)]
pub enum MyLibError {
    #[error("Specific error: {0}")]
    Specific(String),
    
    #[error(transparent)]
    Other(#[from] anyhow::Error),  // ← 接受 anyhow 错误
}

// 在应用层转换为 anyhow
fn application_code() -> anyhow::Result<()> {
    my_lib_function()?;  // MyLibError 自动转换为 anyhow::Error
    Ok(())
}
```

---

## 架构分层分析

### 当前架构层次

```
┌─────────────────────────────────────────┐
│   应用层 (Agent Loop, Session, Tools)    │  ← anyhow 主导
│   - 快速迭代                             │
│   - 错误上下文丰富                        │
└─────────────────────────────────────────┘
                   ↓ anyhow::Error
┌─────────────────────────────────────────┐
│   领域层 (Providers, Plugins, Recipes)   │  ← 混合使用
│   - 部分使用 thiserror (认证、配置)       │
│   - 部分使用 anyhow (业务逻辑)           │
└─────────────────────────────────────────┘
                   ↓ 类型转换
┌─────────────────────────────────────────┐
│   基础设施层 (Config, Extensions)        │  ← thiserror 主导
│   - 公开 API                             │
│   - 精确错误分类                         │
└─────────────────────────────────────────┘
```

### 边界识别

**清晰边界**:
- ✅ Config 系统 (`ConfigError`) - 100% thiserror
- ✅ Provider 认证 (Azure/GCP auth) - 100% thiserror
- ✅ 插件系统 - 100% thiserror

**模糊边界**:
- ⚠️ Provider 实现 - 部分文件混用
- ⚠️ Recipe 系统 - 仅构建逻辑用 thiserror
- ⚠️ Extension 管理 - 错误定义与使用不一致

---

## 问题识别

### P1 - 高优先级

**Issue 1: 错误类型不一致导致匹配困难**

```rust
// 调用者无法精确匹配 anyhow 错误
match some_operation() {
    Ok(result) => handle_success(result),
    Err(e) => {
        // 只能通过字符串匹配，脆弱且易错
        if e.to_string().contains("auth_required") {
            handle_auth_error();
        } else {
            handle_generic_error(e);
        }
    }
}
```

**影响**: 
- 特定错误处理逻辑不可靠
- 测试难以精确验证错误类型

**示例位置**: `acp/mod.rs:is_auth_required()` 函数

**Issue 2: Provider 层错误处理不统一**

- `providers/azureauth.rs` - 使用 thiserror ✅
- `providers/gcpauth.rs` - 使用 thiserror ✅
- `providers/base.rs` - 使用 anyhow ⚠️
- `providers/openai.rs` - 使用 anyhow ⚠️

**影响**: 
- 不同 provider 的错误处理代码不可复用
- 统一的错误恢复策略难以实施

### P2 - 中优先级

**Issue 3: 缺少统一的错误分类层**

当前错误传播路径过于扁平：
```
Tool Execution Error → anyhow::Error → 直接展示给用户
```

理想分层结构：
```
Tool Execution Error 
  → ToolError (thiserror) 
    → 分类：PermissionDenied, Timeout, InvalidInput
      → UserFacingError (格式化) → 用户界面
      → TelemetryError (结构化) → 监控系统
```

**Issue 4: 错误上下文信息过载**

```rust
// 过度使用 .context() 导致错误消息冗长
some_call()
    .context("Failed to perform operation")?
    .context("Error in middle layer")?
    .context("Top level error")?;

// 输出: "Top level error: Error in middle layer: Failed to perform operation: actual error"
```

**建议**: 
- 上下文信息应该分层而非堆叠
- 考虑使用结构化日志而非错误消息

---

## 统一策略建议

### Option A: 保持现状 + 边界明确化（推荐）

**原则**:
1. **应用层**: 继续使用 anyhow（94.1% 文件保持不变）
2. **公开 API**: 强制使用 thiserror
3. **边界转换**: 统一模式

**优势**:
- ✅ 最小化代码变更
- ✅ 保留 anyhow 的灵活性
- ✅ 改进边界处的类型安全

**实施步骤**:
1. 定义清晰的"公开 API"边界（Week 2）
2. 为所有 provider 添加统一的 `ProviderError` 类型（Week 3）
3. 创建错误转换辅助函数（Week 3）
4. 更新贡献指南，明确各层使用规则（Week 2）

**代码示例**:
```rust
// 步骤1: 定义统一的 ProviderError
#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("Authentication required for provider {provider}")]
    AuthRequired { provider: String },
    
    #[error("Configuration error: {0}")]
    Config(#[from] ConfigError),
    
    #[error("Network error: {0}")]
    Network(String),
    
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

// 步骤2: 在 Provider trait 中使用
pub trait Provider {
    async fn complete(&self, messages: Vec<Message>) -> Result<Response, ProviderError>;
}

// 步骤3: 应用层自动转换
fn agent_logic() -> anyhow::Result<()> {
    let response = provider.complete(messages)?;  // ProviderError → anyhow::Error
    Ok(())
}
```

### Option B: 全面迁移到 thiserror（不推荐）

**原则**: 为所有模块定义精确的错误类型

**优势**:
- ✅ 最大化类型安全

**劣势**:
- ❌ 需要修改 191 个文件
- ❌ 增加 5000+ 行样板代码
- ❌ 降低应用层迭代速度
- ❌ 风险高，收益不明显

**结论**: 不适合 goose 的快速迭代需求

### Option C: 全面迁移到 anyhow（不推荐）

**原则**: 移除所有 thiserror，统一使用 anyhow

**优势**:
- ✅ 代码简洁统一

**劣势**:
- ❌ 丢失公开 API 的类型安全
- ❌ 破坏现有的 ConfigError, ProviderError 等契约
- ❌ 降级库的可用性

**结论**: 损害架构分层

---

## 推荐实施计划（Option A）

### Phase 1: 文档化与规范（Week 2，3天）

**任务**:
1. 在 `CONTRIBUTING.md` 中添加"错误处理指南"章节
2. 明确各层使用规则：
   ```
   - 应用层 (Agent, Session, Tools): anyhow::Result
   - 库层 (Providers, Config, Plugins): thiserror 自定义类型
   - 边界转换: 实现 From<CustomError> for anyhow::Error
   ```
3. 提供代码模板和反模式示例

**交付物**: 
- [ ] `docs/ERROR_HANDLING_GUIDE.md`
- [ ] `CONTRIBUTING.md` 更新

### Phase 2: 统一 Provider 错误类型（Week 3，5天）

**任务**:
1. 在 `providers/base.rs` 中定义 `ProviderError` 枚举
2. 更新所有 provider 实现使用统一错误类型
3. 添加错误分类：
   - `AuthRequired` - 需要重新认证
   - `RateLimited` - API 限流
   - `InvalidResponse` - 响应格式错误
   - `NetworkError` - 网络问题
   - `ConfigError` - 配置问题

**预计变更文件**: 20-30 个 provider 相关文件

**交付物**:
- [ ] `ProviderError` 定义
- [ ] 所有 provider 迁移完成
- [ ] 单元测试更新

### Phase 3: 改进错误上下文管理（Week 4，3天）

**任务**:
1. 创建 `crates/goose/src/error_context.rs` 模块
2. 实现结构化错误上下文：
   ```rust
   pub struct ErrorContext {
       pub operation: String,
       pub component: String,
       pub session_id: Option<String>,
       pub metadata: HashMap<String, String>,
   }
   
   pub trait WithContext {
       fn with_context(self, ctx: ErrorContext) -> Self;
   }
   ```
3. 集成到关键路径（agent loop, tool execution）

**交付物**:
- [ ] `error_context.rs` 模块
- [ ] 集成到 5-10 个关键函数

### Phase 4: 错误处理测试（Week 4，2天）

**任务**:
1. 为 `ProviderError` 添加完整测试
2. 验证错误转换链正确性
3. 测试用户可见错误消息格式

**交付物**:
- [ ] 错误类型测试套件
- [ ] 错误消息格式验证

---

## 成功标准

### 技术标准

- [ ] 所有公开 API 使用 thiserror 定义的错误类型
- [ ] Provider 层错误类型 100% 统一
- [ ] 错误处理指南文档完成
- [ ] 无 Clippy 警告（错误处理相关）

### 代码质量标准

- [ ] 错误匹配代码从字符串匹配迁移到类型匹配
- [ ] 关键错误路径有完整的单元测试
- [ ] 用户可见错误消息清晰且可操作

### 文档标准

- [ ] 贡献指南更新
- [ ] 所有新定义的错误类型有文档注释
- [ ] 提供正面和反面示例

---

## 风险评估

### 高风险

**R1: Provider 错误类型迁移影响稳定性**
- **缓解**: 分批次迁移，每批次完成后运行完整测试套件
- **回滚方案**: 保持向后兼容，添加 deprecated 标记

### 中风险

**R2: 错误消息格式变更影响用户体验**
- **缓解**: 在测试环境先验证所有错误消息
- **监控**: 收集用户反馈

### 低风险

**R3: 新开发者学习曲线**
- **缓解**: 完善文档和示例
- **支持**: 代码审查时强化指导

---

## 度量指标

### 迁移进度指标

| 指标 | 基线 | 目标 | 测量方式 |
|-----|------|------|---------|
| thiserror 使用文件占比 | 5.9% | 15% | `grep -r thiserror \| wc -l` |
| Provider 错误统一率 | 20% | 100% | 手动审查 |
| 字符串错误匹配数量 | TBD | 0 | `grep "to_string().contains"` |

### 质量指标

| 指标 | 目标 | 测量方式 |
|-----|------|---------|
| 错误类型测试覆盖率 | 90% | cargo-tarpaulin |
| 用户错误报告准确性 | 提升 30% | 用户反馈分析 |
| 错误恢复成功率 | 提升 20% | Telemetry 数据 |

---

## 附录

### A. 错误处理反模式

**反模式1: 过度使用 .unwrap()**
```rust
// ❌ 不好
let value = some_operation().unwrap();

// ✅ 好
let value = some_operation()
    .context("Failed to perform operation")?;
```

**反模式2: 吞噬错误信息**
```rust
// ❌ 不好
if let Err(_) = some_operation() {
    return Err(anyhow::anyhow!("Operation failed"));
}

// ✅ 好
some_operation()
    .context("Operation failed in component X")?;
```

**反模式3: 字符串错误匹配**
```rust
// ❌ 不好
if error.to_string().contains("auth") {
    handle_auth_error();
}

// ✅ 好
match error {
    ProviderError::AuthRequired { .. } => handle_auth_error(),
    other => handle_other(other),
}
```

### B. 参考资源

- [anyhow 文档](https://docs.rs/anyhow/)
- [thiserror 文档](https://docs.rs/thiserror/)
- [Rust Error Handling Survey](https://blog.burntsushi.net/rust-error-handling/)

---

**文档版本**: v1.0  
**创建日期**: 2026-09-15  
**下次审查**: Week 3 结束
