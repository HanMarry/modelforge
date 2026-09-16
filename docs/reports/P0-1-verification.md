# P0-1 验证记录：API Key 保存静默失效

> 日期：2026-09-16 · 修复提交：`52d60fc`（配套 e2e 基建修复 `17ddb51`）· 状态：✅ 已修复并验证

## 一、根因（实测链路）

保存 API Key 后仍报「内核未启动：缺少 API Key」、必须重启，由五个环节叠加：

1. 应用侧密钥副本 `%APPDATA%/ModelForge/agent-kernel-secrets.json` 不存在（本机实测），`resolveKey` 四级回退全部落空；
2. 回退链第 4 级读 `secrets.yaml` 在 Windows 默认配置下结构性失效——goose 密钥写入系统凭据管理器，该文件仅在 `GOOSE_DISABLE_KEYRING=1` 时存在；
3. 编辑 provider 流程允许密钥留空提交且空值静默丢弃（`agentKernelCapture`），副本可能永无捕获时机；
4. **保存后不自愈**（核心缺陷）：`refresh` 在 `active === null`（首次 provision 因缺 key 失败）时不重新 provision、不清 `status.error`，保存密钥只写存储不生效，必须重启应用；
5. 无「已有密钥副本」的可见性，用户无从知晓需要补录。

## 二、修复内容（提交 `52d60fc`）

| 文件 | 改动 |
|------|------|
| `utils/agentKernel.ts` | `refresh` 改 async；外部内核已选但未运行时重新完整 `apply`（自愈）；成功路径显式清 `error`；`resolveKey` 注释说明 secrets.yaml 结构性失效 |
| `components/settings/app/AgentKernelSection.tsx` | 挂载改走 `refreshAgentKernel`（重算而非读缓存）；缺密钥时显示一次性补录指引（新增 i18n `apiKeyCopyMissing`）；监听 `AGENT_KERNEL_CHANGED` |
| `utils/agentKernelCapture.ts` | 空值/失败输出告警日志，不再静默 |
| `components/Layout/NavigationPanel.tsx` | 恢复 `sidebar-settings-button` testid（白标重构时丢失，老 e2e 依赖） |
| i18n messages（16 文件） | 补齐 6 个缺失 key（1 个本次新增 + 5 个此前 extract 遗漏，含 zh-CN/zh-TW 翻译） |

## 三、验证证据

### 单元测试（26/26 通过）

```
npx vitest run src/utils/agentKernel.test.ts
Test Files  1 passed (1)   Tests  26 passed (26)
```

新增 4 例：
- 缺 key 启动失败后保存密钥 → 下次 refresh 重新 provision 并 Ready（自愈）
- 运行中轮换密钥 → 推送 `setApiKey` 且不重复 provision
- 切换内核 → 仍要求重启（restartRequired 回归）
- 内置内核 refresh 不受影响（回归）

### 端到端重放（真实应用，`tests/e2e/agent-kernel-key-recovery.spec.ts`）

真实故障环境重放（runtime=claude-code、无应用内副本、goose 密钥在系统凭据库）：

```
Connected to Electron app on attempt 10
ok 1 agent kernel starts as soon as a key is saved, no restart (P0-1)
1 passed (22.6s)
```

流程断言：① 面板显示「缺少 API Key」+ 补录指引；② 输入密钥保存后 **不重启** 状态变 Ready（shim URL 出现）；③ Forget 后副本清除（密钥来源回到"未设置"）。
测试自带恢复：结束后删除测试副本，`agent-kernel-secrets.json` 还原为 `{}`（行为等价于原状）。

### 静态检查

- `tsc --noEmit` ✅ · 改动文件 eslint ✅ · i18n check/validate/compile ✅

## 四、附带发现（已随 `17ddb51` 修复）

本机 e2e 基建此前实际不可用，一并修复：pnpm 引擎（npx pnpm@10.30.0）、Windows spawn shell、调试端口动态分配、`GOOSE_BINARY`/`GOOSE_TELEMETRY_OFF` 缺失、npx 链残留进程清扫、CDP 等待上限。

> 注：发现 `goose serve failed: Goose binary not found`——开发模式需 `GOOSE_BINARY` 指向 `E:\goose-build\target\debug\goose.exe`（与 `start-modelforge.ps1` 一致）；正式打包场景的运行时查找在交付链路（P1-3.4）中处理。
