# P0-4 验证记录：HTTP 凭据明文（剩余两处）

> 日期：2026-09-16 · 修复提交：`072f711` · 状态：✅ 已修复并验证

## 一、修复内容

| 位置（审查结论） | 修法 |
|------|------|
| `acp/server/extensions.rs`：敏感判定仅认 `env_keys` + 6 个硬编码头名，`X-DeepSeek-Token` / `Private-Token` 等自定义认证头明文写 config | 新增 `goose::utils::is_sensitive_header_name`（已知名 + `token/key/secret/auth/password/credential/session` 子串识别），命中后沿用既有 `MODELFORGE_MCP_HEADER_<sha256>` 密钥迁移机制 |
| `cli/commands/configure.rs:1147`：`collect_headers` 明文回显收集并直写 config | 敏感头改 `cliclack::password` 遮蔽输入；值经 `try_store_secret` 存系统密钥库；config 仅保留 `${MODELFORGE_MCP_HEADER_<NAME>}` 引用并注册 `env_keys`（运行时 `merge_environments` 从密钥库解析回填，与 ACP 侧同一机制）；存储失败时跳过该头并告警，**不回退明文** |
| 微项：`extensions.rs` 引用正则每次调用重新编译 | 改为 `OnceLock` 缓存 |

## 二、验证证据（goose-build，GNU 工具链）

- **单元测试**：`cargo test -p goose --lib utils::` → 37 passed（含新增 `test_is_sensitive_header_name`：11 个敏感头名——Authorization/Proxy-Authorization/X-API-Key/API-Key/X-Auth-Token/Cookie/Private-Token/X-DeepSeek-Token/X-Subscription-Key/X-Secret/X-Session-Id；4 个普通头名——Content-Type/Accept/User-Agent/X-Origin-Client-Id）
- **ACP 回归**：`cargo test -p goose --lib acp::` → 334 passed
- **CLI 编译**：`cargo check -p goose-cli --no-default-features --features 'rustls-tls,system-keyring,...'`（build-kernel 同款特性集）✅

## 三、验证边界与手工步骤

`collect_headers` 走 cliclack 交互（需要 TTY），无法自动化测试；其安全性依赖已单测的判定函数 + 修复轮已验证的密钥引用机制（`http_secret_keys_are_scoped_to_each_connector` 等）。手工验收步骤（可选）：

1. `goose configure` → 添加 streamable_http 扩展 → 加一个 `X-DeepSeek-Token` 头（输入值应被遮蔽）
2. 检查 `%APPDATA%\Block\goose\config\config.yaml`：该头值为 `${MODELFORGE_MCP_HEADER_X_DEEPSEEK_TOKEN}`，无明文
3. Windows 凭据管理器中可查到该 key

## 四、遗留（已登记 OPTIMIZATION_PLAN §4.7）

- `configure.rs` 的 `collect_custom_headers`（provider 自定义头 → `custom_providers.json`）同样为明文存储，不在本次点名范围；其机制（provider 配置的 header 引用）需对齐后再改，建议随后排期。
