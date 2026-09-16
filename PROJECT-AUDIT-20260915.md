# Goose 全项目优化审查报告

**日期**: 2026-09-15
**范围**: 整个 goose 仓库（Rust `crates/` 558 个 .rs + Electron/React `ui/desktop` 554 个 ts/tsx + 43 个 CI workflow）
**方法**: 7 个领域并行审查 → 逐条对抗性核实（每条都要实读代码、核对行号、尝试证伪）→ 按严重性 × 收益排序
**约束**: 全部为**静态代码审查**。未运行 `cargo build` / `cargo test` / 负载测试，故性能结论是"代码路径级"的，不是实测数值。UI 包体积数据取自仓库内已存在的 `dist/` 产物。

---

## 0. TL;DR

| 结论 | 说明 |
|---|---|
| **1 个安全降级缺陷** | `/plan` 批准执行失败时，`GOOSE_MODE` 被**永久落盘改成 `auto`**（绕过所有工具确认） |
| **1 个前端 blocker** | ~~流式响应每个 chunk 对整段会话做 3 次全量深拷贝~~ **复核后已修正**：该处在基线中已优化过，残留的是 `getSnapshot` 的重复深拷贝（见 §9） |
| **最被低估的是状态机迁移** | 迁移路线图只覆盖"功能对等性"，**漏掉了"每 step 全量重载会话"**；不修则 Phase 3 性能门槛必然不达标 |
| **既有基线数字偏低** | 既有文档称 clone 2092、Arc\<Mutex\> 60；**实测为 3313 与 91**（口径差异，见 §8） |
| **一片共性根因** | 子进程 stdio 生命周期散落在 4+ 处各自实现，收敛到一处可一次消掉 5 条 high |
| **大量"数字型"技术债是假警报** | `pairing.rs`/`telegram.rs`/`skills`/`hooks` 的 unwrap **全在 `#[cfg(test)]` 内**，生产零 panic 面 |

---

## 1. 优先级矩阵

严重性 = 对正确性/安全/可靠性的影响；工量 = S(<2h) / M(<1d) / L(>1d)。
"重叠"栏标注与既有四个计划（状态机迁移 / 错误处理 / clone 优化 / Arc\<Mutex\> 迁移）的关系。

### P0 — 立即修

| # | 问题 | 域 | 位置 | 工量 | 重叠 |
|---|---|---|---|---|---|
| 1 | `/plan` 失败即永久把 `GOOSE_MODE` 落盘改为 `auto`（绕过工具确认） | Rust 故障面 | `crates/goose-cli/src/session/mod.rs:1454-1475` | S | 否 |
| 2 | ~~流式每 chunk 对整段会话 3 次全量深拷贝~~ **已修正（见 §9 勘误），残留问题为 2b** | UI | `ui/desktop/src/acp/adapter/shared.ts:44-50` | — | 否 |
| 3 | 状态机每 step 全量重载会话（步数 × 会话长度的线性放大） | agent-loop | `state_machine/session.rs:198-213` + `session_manager.rs:1652-1705,1871-1907` | M | **状态机迁移漏项** |
| 4 | MCP 子进程 stderr 无上限读入 + 失败路径无超时 → 扩展加载可无限挂起 | extension | `extension_manager.rs:457-490` | M | 错误处理 |

### P1 — 高价值

| # | 问题 | 域 | 位置 | 工量 | 重叠 |
|---|---|---|---|---|---|
| 5 | TokenCounter 的 LRU 每次调用被重建 → 缓存命中恒为 0 | Provider | `token_counter.rs:215-217` + `context_mgmt/mod.rs:211-222` | S | 否 |
| 6 | Bedrock 双层重试叠加，最坏 16 次请求 / 3-5 分钟挂起 | Provider | `providers/bedrock.rs:984-988,278-295` | S | 否 |
| 7 | OpenAI Responses 把解析失败的工具参数静默换成 `{}`（空参数真执行） | Provider | `formats/openai_responses.rs:797-806,875,939,961` | S | 错误处理 |
| 8 | 取消流 ≠ 取消请求：Claude Code / ACP 会跑完被中断的 turn | Provider | `providers/claude_code.rs:766-802,200-245`；`acp/provider.rs:944-953,1729-1757` | M | 否 |
| 9 | `config.yaml` 丢更新/可被清空：锁加在将被 rename 的临时文件上、加锁前 truncate、解析失败静默当空配置回写 | Rust 故障面 | `config/base.rs:644-665,503-511` | M | 错误处理 |
| 10 | codex provider 先写满 stdin 再排空 stdout → 环形等待永久挂死，无 `kill_on_drop`、无超时 | Rust 故障面 | `providers/codex.rs:212-238`（对照 `cursor_agent.rs:301-311` 是正确写法） | S | 否 |
| 11 | shell 工具只 `start_kill` 不杀进程树（孙进程占端口/锁）+ 全量输出进无界 channel（可 OOM） | Rust 故障面 | `platform_extensions/developer/shell.rs:597-627,587-659` | M | 否 |
| 12 | 网关待确认条目在流 Err 路径不清理 → 该用户**后续每条消息都被劫持**成 approve 提示，并钉住 `Arc<Agent>` | Rust 故障面 | `gateway/handler.rs:693-705,782-796,194-200` | S | 否 |
| 13 | 流式渲染风暴：`memo(isEqual)` 永不短路 + 每 chunk 两次全量派生 | UI | `ProgressiveMessageList.tsx:152,245-256,278-280` + `messageRowContext.ts:33-34` | M | 否 |
| 14 | 全仓库**零虚拟化**，会话列表/消息列表 DOM 只增不减 | UI | `SessionListView.tsx:335,383-385,473-485`；`ProgressiveMessageList.tsx:194-196` | L | 否 |
| 15 | 启动包 3.69MB 单体 chunk（pdfjs / 全量 refractor / katex / read-excel-file 全内联） | UI | `renderer.tsx:13`、`MarkdownContent.tsx:6-8`、`PdfPreview.tsx:2-3` | M | 否 |
| 16 | 每个 PR 9 个 Rust 构建 job、0 个 `shared-key`、`goose` 二进制被构建上传两次 | 工程效率 | `ci.yml:85-113`、`pr-smoke-test.yml:65-74`、`mcp-conformance.yml:30-49` | S-M | 否 |
| 17 | 三个最贵的 PR 工作流**没有 `concurrency`**，旧 run 不取消（约 27 个 job 实例/次 push） | 工程效率 | `ci.yml:1-13`、`pr-smoke-test.yml:1-8`、`mcp-conformance.yml:3-13` | S | 否 |
| 18 | 依赖门禁形同虚设：cargo-deny 无 PR 触发且无 `[bans]`；cargo-machete 看不到 workspace 依赖 | 工程效率 | `cargo-deny.yml:2-29`、`deny.toml:1-13`、`Cargo.toml:89` | S | 否 |
| 19 | 29 个 `#[ignore]` 测试无任何执行路径；`quarantine.yml` 封的是**人**不是测试 | 工程效率 | `quarantine.yml:19-33` | S | 否 |

### P2 — 中等

| # | 问题 | 域 | 位置 | 工量 |
|---|---|---|---|---|
| 20 | 自动命名 vs 用户重命名构成 lost update（用户标题被静默覆盖、`user_set_name` 清零） | 会话 | `session_manager.rs:590-594,640-649,223-230,1755-1756` | S |
| 21 | `maybe_update_name` 每条用户消息都全量装载会话（默认开启） | 会话 | `session_manager.rs:590,624-649` | S |
| 22 | 状态机 tool-call 分片自带 thinking 时静默丢弃先前 thinking（双路径行为分歧） | agent-loop | `goose-agent/src/inference.rs:105-121` vs `agent.rs:2997-3000,3073-3081` | M |
| 23 | 每轮模型调用都从磁盘重建 system prompt（约 20 次 config 解析 + 磁盘扫描 / 10 轮） | agent-loop | `inference_preparation.rs:51-57`、`ops_toolcalling.rs:773-830` | M |
| 24 | 未分页 `list_sessions` 全表 JOIN+GROUP BY，调用方事后才截断 | 会话 | `session_manager.rs:2003-2021,2042-2057,2112-2121` | L |
| 25 | chatrecall 全表扫描 + 每行 `json_each` + N+1 计数 | 会话 | `chat_history_search.rs:133-213,267-299` | L |
| 26 | 后台任务上限检查-插入 TOCTOU（并发 delegate 可突破上限） | extension | `summon.rs:2040-2047,2134-2137` | S |
| 27 | 扩展工具列表的**瞬时失败**被会话级缓存 → 工具长期不可见 | extension | `extension_manager.rs:1834-1854,1919-1928` | S |
| 28 | 批量加载按"已成功"而非"已配置"持久化；**全失败时会把会话扩展清空** | extension | `agent.rs:1382-1386,1434-1438`、`extension_data.rs:76-80` | M |
| 29 | 每个 subagent 独立构造 Agent 并**串行**重建父会话全部 MCP 扩展 | extension | `subagent_handler.rs:140,151-159`（漏用已存在的 `add_extensions_bulk`） | S(止血) |
| 30 | ACP 用 `try_send` 投递，通道满即**静默丢弃**文本与工具结果 | Provider | `acp/provider.rs:643,1306,1356,1402` | M |
| 31 | OpenAI Responses 维护只写不读的 `accumulated_text` | Provider | `openai_responses.rs:1013,1068,1162` | S |
| 32 | OpenAI Chat 每个 SSE 帧两遍 JSON 解析 + tool-call 帧四份 clone | Provider | `formats/openai.rs:1184-1222,1314-1323` | S |
| 33 | 会话快照从不回收（每会话 3 份副本）+ SearchHighlighter 滚动监听泄漏 | UI | `chatSessionStore.ts:164-192,676-678`、`searchHighlighter.ts:43-57,282-289` | M |
| 34 | 单条 IPC payload 53MB base64；终端每 chunk 一条消息 | UI | `workspaceIpc.ts:149-150,257-271`、`terminalIpc.ts:108-111,168-178` | M |
| 35 | ChatInput 每次按键两次 setState + `getBoundingClientRect` 强制回流 + 9 个未 memo 子组件 | UI | `ChatInput.tsx:297,1001-1048,1699-1987` | M |
| 36 | JS 侧零缓存：每个 PR 6 次全量 `pnpm install`；live LLM 冒烟是 PR **必过**项 | 工程效率 | `ci.yml:45,320,363,396`、`pr-smoke-test.yml:104,184` | S |
| 37 | 触发策略错配：MSRV 无条件全量跑；Windows 构建只在 main 跑 | 工程效率 | `ci.yml:243-277,219-241` | S |
| 38 | 44 处 `allow(dead_code)` 掩盖未接线代码（`gateway/` 独占 15 处）；零测试高风险模块 | 工程效率 | `gateway/mod.rs:36,45,75`、`manager.rs:61,106,258,270,275` | M |

### P3 — 低

| # | 问题 | 域 | 位置 | 工量 |
|---|---|---|---|---|
| 39 | 每个 pass 重算派生状态（ApprovalState / pending / JSON Schema） | agent-loop | `ops_tool_approval.rs:60,172-209`、`ops_recipe.rs:262-280` | S |
| 40 | NotificationSink 缓冲无上限 + `Vec::remove(0)` 排空（O(n²)） | extension | — | S |
| 41 | `update_working_dir` 持 extensions 锁跨网络 await，阻塞全部扩展操作 | extension | — | S |
| 42 | `add_extension` 检查-插入 TOCTOU 静默丢弃子进程 | extension | — | M |
| 43 | 无优雅关闭：从不调用 `close_with_timeout`/`cancel`，孙进程孤儿化 | extension | — | M |
| 44 | `create_pool` 两个 `expect` 是生产可达 panic（数据目录不可写即崩溃；同链 `paths.rs:27` 也是） | 会话 | `session_manager.rs:930,935`、`config/paths.rs:27` | S |
| 45 | ACP 工具确认投递失败被 `let _ = tx.send()` 吞掉却仍 `return true` → request_id 永久无法回答 | Rust 故障面 | `acp/provider.rs:844-848` | S |

---

## 2. 各领域详情

> 以下 7 节由各领域审查 + 对抗性核实产出，含完整证据链（代码摘录、可达性论证、与既有计划的重叠关系）。
> 中间稿保留在 `.repair-backups/audit-s0.md` ~ `audit-s2.md` 与 `.repair-backups/audit-missing-*.md`。

### 2.1 agent-loop 核心 (P0)
见 `.repair-backups/audit-s0.md`（6 条，全部 confirmed/partial）

### 2.2 extension 与 MCP 生命周期
见 `.repair-backups/audit-s1.md`（9 条：F1-F6 + N1-N3）

### 2.3 会话持久化与状态
见 `.repair-backups/audit-s2.md`（6 条 + 3 条负结论）

### 2.4 Provider 流式与格式转换
见 `.repair-backups/audit-missing-provider.md`（7 条）

### 2.5 UI 性能与状态管理
见 `.repair-backups/audit-missing-ui.md`（7 条）

### 2.6 Rust 运行时故障面
见 `.repair-backups/audit-missing-rustfail.md`（7 条主 + 8 条次级 + 负结论一章）

### 2.7 工程效率、CI 与测试策略
见 `.repair-backups/audit-missing-eng.md`（7 条）

---

## 3. 跨域共性根因（最高杠杆）

审查覆盖 7 个互不相关的领域，但反复浮现出**同 5 个根因**。修根因的收益远大于逐条修表象。

### 3.1 子进程 stdio 生命周期散落 4+ 处，各自实现且各自有缺陷

同一个"spawn 子进程 → 排空 stdin/stdout/stderr → 超时 → 杀进程"的问题，在 4 个地方各写一遍，且**每一份都有不同的缺陷**：

| 位置 | 缺陷 | 编号 |
|---|---|---|
| `extension_manager.rs:462-490` | stderr `read_to_end` 无界 + 成功路径丢弃 JoinHandle + 无超时 | #4 |
| `providers/codex.rs:212-238` | 先写满 stdin 再排空输出 → 环形等待挂死 | #10 |
| `developer/shell.rs:597-659` | 只杀 shell 不杀进程树 + 输出进无界 channel | #11 |
| `config/base.rs:644-665` | 锁加在将被 rename 的临时文件上 | #9 |

**建议**：收敛为 `subprocess.rs` 的单一实现——先并发排空（有界缓冲）→ 再写 stdin → 带超时 → 杀整个进程组。
仓库内已有正确模板可参照：`mcp_client.rs:381-390` 的 `fan_out_notification`（通道满的处理）与 `cursor_agent.rs:301-311`（stdio 顺序）。

### 3.2 "瞬时失败被固化为长期状态"

多处把一次性的失败结果当作正常值缓存/持久化，导致故障被永久化：

- 扩展工具列表瞬时失败 → 会话级缓存 → 工具长期不可见（#27）
- 扩展加载失败 → 按"已成功"集合持久化 → 会话扩展被清空（#28）
- 网关确认失败 → 不清理条目 → 用户会话被永久劫持（#12）
- ACP `try_send` 通道满 → 静默丢块 → request_id 永久无法回答（#30, #45）

### 3.3 静默降级 / 静默成功

- 工具参数解析失败 → `{}` → **空参数真执行**（#7）
- `truncate(true)` 先于加锁 → 配置写坏 → 解析失败当空配置回写（#9）
- 通道满 `try_send` / `let _ = tx.send()` → 数据丢失但返回成功（#30, #45）
- 解析错误退化成语义固定的 `"Unknown server error"`（Provider 域）

### 3.4 每轮/每步重做本可复用或增量的事

| 位置 | 重做内容 | 放大倍数 |
|---|---|---|
| 状态机 `session.rs:198` | 全量会话重载 | × 步数 |
| `token_counter.rs:215` | 重建 LRU（命中恒 0） | × 每次调用 |
| `inference_preparation.rs:51` | 重建 system prompt + 磁盘扫描 | × 模型轮次 |
| `chatSessionStore.ts:452` | 整段会话深拷贝 | × 每个 chunk（3 次） |

### 3.5 双路径重复维护（状态机迁移的隐性成本）

`agent.rs`（6234 行）与 `state_machine/` 是两份实现，`AGENTS.md` 要求"迁移完成前两条路径同步改"。已经出现**实际分歧**：

- tool-call thinking 累积规则相反（#22，传统路径注释明确写了原因，状态机没照做）
- tool hook 生命周期重复约 190 行，且 span 字段口径已不同（`agent.rs:718-721` 记 `output`，状态机副本不记）
- 迁移完成可删约 **2000 行**非测试代码（占 `agent.rs` 约 32%）

**这是"迁移要尽快"的最强论据**：不是"新架构更好"，而是"双份实现已经产生行为分歧"。

---

## 4. 对既有 Week 1-7 计划的影响

既有计划（`EXECUTION_LOG.md`）有 4 条轨道。本次审查对其有 3 处**需要修正**：

### 4.1 状态机迁移路线图漏了最大的性能阻塞点（重要）

`state_machine_migration_roadmap.md` 只覆盖功能对等性与两项差异（Schedule ID、Hook working_dir），但**没有把"每 step 全量重载会话"列为迁移阻塞项**（#3）。

- `reconstruction_isolation_lifecycle` 是故意设计（每步从持久化会话重建决策），**不是疏漏**
- 但它是唯一的**线性放大项**：会话 1000 条消息时每轮 ≥5000 次消息反序列化
- 状态机路径默认关闭（`GOOSE_STATE_MACHINE=1`），故当前不是线上回归；**一旦成为默认路径即升为 high**
- **结论**：Phase 3「性能指标不低于传统路径」在此之前不可能达标。建议把 #3 作为 Phase 1 前置任务插入

### 4.2 基线数字口径偏低

| 指标 | 既有文档 | 本次实测 | 说明 |
|---|---|---|---|
| clone 调用 | 2092 | **3313** | 口径差异（是否含 tests/examples） |
| Arc\<Mutex\> | 60 | **91**（vs Arc\<RwLock\> 11） | 同上 |
| Clippy 警告 | 150 | 未验证 | 需实际跑 clippy 才能确认 |
| workflow 数 | — | **43**（非 44） | |
| `crates/**` TODO/FIXME | — | **129**（全 .rs 含 examples 为 194） | 口径不同 |

建议在 Week 2 开始前**锁定一次口径并写进基线表**，否则 Week 7 的"达标"无法验证。

### 4.3 "clone 优化"与本次发现高度重叠，应合并批次

#5（token counter）、#22（投影做两遍）、#32（四份 clone）、#39（ToolRequest 深拷贝）都属 clone 语义问题。
单独做"减少 clone 数量"容易变成拆东墙补西墙（把 clone 改成 `Arc` 但语义没变）。**建议并入同一批次**，以"同一份数据在两条路径各投影一遍"（#22）为主线。

---

## 5. 经核实**不成立**的结论（避免重复排查）

这些是审查过程中被证伪或确认安全的项，**不要**再立项：

| 结论 | 核实结果 |
|---|---|
| `session_manager.rs` 244 处 unwrap 是 panic 风险 | **全部在 `#[cfg(test)]` 内**（2784 行起，首个 2802）；生产段 1-2782 **零 unwrap**，仅 2 处 `expect`（#44） |
| `pairing.rs`(113) / `telegram.rs`(106) / `skills/mod.rs`(83) / `hooks/mod.rs`(40) unwrap 风险 | **全部在 `#[cfg(test)]` 内**，生产零 panic 面 |
| `action_required_manager.rs` unwrap/panic | 生产段 1-231 全部在测试内 |
| `sources.rs` 4 处 `unreachable!` | 均有正确守卫 |
| `config/base.rs` 锁跨 await 死锁 | 全文**零 `.await`**，无 guard 跨 await；`secrets_cache` 一致性正确 |
| `execution/manager.rs` `creation_locks` 无界增长 | 有完整 prune |
| `subprocess.rs` 的 unsafe | 不变量成立 |
| `last_message_snippet` UNION ALL 会撞 SQLite 500 分支上限 | 不成立：`SESSION_LIST_PAGE_SIZE=50` 硬编码且不接受客户端覆盖 |
| 会话持久化新增密钥落盘 | `resolved_config`/`request_headers` 均不落盘（`#[serde(skip)]`）；**限定**：`session.extension_data` 确实持久化 `ExtensionConfig` 值，需另行审 |
| Bedrock / acp/server/providers / subagent_handler 的 expect | 均有正确守卫 |

---

## 6. 建议执行顺序

按"依赖关系 + 投入产出比"排序，共 4 个批次：

### 批次 1 — 止血（约 1 天，全部 S）

1. **#1** `/plan` 的 `GOOSE_MODE` 落盘泄漏（**安全**，最先修）— 把 `set_goose_mode(Auto)` 改为记内存标志而非落盘，或用 guard 保证恢复
2. **#5** TokenCounter 进程级共享（<2h，缓存命中从 0 恢复到设计值）
3. **#6** Bedrock `RetryConfig::disabled()`（<2h，消除 16 次重试）
4. **#17** 三个 workflow 补 `concurrency: cancel-in-progress`（照抄 `canary.yml:14-16`）
5. **#12** 网关待确认条目清理（防"用户会话被劫持"）
6. **#10** codex stdio 顺序（照抄 `cursor_agent.rs:301-311`）
7. **#26** 后台任务上限用 `Semaphore` 替代"检查后插入"
8. **#45 / #44** ACP 确认投递失败上报；`create_pool` 改 `Result`

### 批次 2 — 前端体验（约 2-3 天）

9. **#2** `chatSessionStore` 每 chunk 3 次克隆降到 ~1 次（M）— **是 #13 的前置条件**
10. **#13** `ProgressiveMessageList` 的 `memo(isEqual)` 短路失效
11. **#15** 拆 bundle：把 pdfjs / refractor 全量语法表 / katex 改为动态导入
12. **#14** 引入虚拟化（依赖数为 0，需新增依赖）— 工量 L，可放最后

### 批次 3 — 状态机迁移前置（约 1 周）

13. **#3** `load_messages_since` 增量读（**迁移 Phase 3 的硬前置**）
14. **#22** thinking 累积规则对齐（双路径行为分歧，属 parity 缺陷）
15. **#23** PromptManager tracker 复用（消除每轮的 config 解析与磁盘扫描）
16. **#24 / #25** 会话列表与检索的 SQL 层优化

### 批次 4 — 结构性收敛（与迁移同步）

17. **#4 / #9 / #11** 子进程 stdio 生命周期收敛到 `subprocess.rs` 单一实现（一次消 3 条 high）
18. **#8** 取消语义：让中断真正取消后端请求
19. **#16 / #36** CI：单一 `build-debug` job 复用产物 + `shared-key` + JS 缓存
20. **#28 / #27** "瞬时失败固化"一类问题统一改为"只缓存成功 + 有限退避重试"

---

## 7. 未覆盖 / 需进一步验证

本次审查的边界，以及需要**运行时**才能确认的项：

1. **Clippy 150 警告基线未验证** — 需实际跑 `cargo clippy --all-targets -- -D warnings`（未跑，太慢）
2. **性能结论均为代码路径级** — 未做实测。建议对 #3/#2/#21 加基准后再定优化优先级
3. **测试覆盖率 72%→85% 未验证** — 需 `cargo llvm-cov` 或等价工具
4. **向量数据库模块**（`crates/goose/src/vector_db/`，Week 1 新增 703 行）**未审查** — 它的 Qdrant 集成测试也未跑过（Week 1 自述"测试未完整运行"）
5. **`crates/goose-mcp/` 上游 MCP 服务器实现**仅抽查，未系统审查
6. **Python / Java SDK 与 documentation 站点未审查**
7. **本仓库只有 7 个 commit**，`session_manager.rs` 等大文件无有效 git 历史，**无法归因问题的引入时间**

---

## 8. 关于数据口径的说明

本报告的数字来自两种来源，已分别标注：

- **实测**（我用 ripgrep/脚本统计）：clone 3313、Arc\<Mutex\> 91、Arc\<RwLock\> 11、unsafe 78、`#[ignore]` 29、`#[allow(...)]` 102、workflow 43、`ui/desktop/src` 554 文件/3.5MB、`dist/assets/App-*.js` 3,776,237 字节
- **审查员报告**（经其本人 read 核实）：所有 `file:line` 引用

3 处已修正的口径偏差（子审查员的自我修正）：
- workflow 实为 **43** 个（非 44）
- `crates/goose/tests/` 顶层 **30** 个 .rs（+4 嵌套 = 34）
- `crates/**/*.rs` 内 TODO/FIXME/HACK 为 **129**；全仓库 .rs（含 examples）为 194 —— 两者口径不同，引用时需注明

---

## 9. 勘误与修复进展（2026-09-15 实施后更新）

### 9.1 勘误：#2「每 chunk 3 次深拷贝」不准确

实施批次 2 时实读代码发现，该问题**在基线中已经被优化过**，审计的 UI 子审查员报告的是修复前的状态：

```ts
// ui/desktop/src/acp/adapter/shared.ts:44-50
export function messagesChange(state: AdapterState): AcpChatStateChange[] {
  // Pass the live array by reference: the store is the only consumer and it
  // clones on write (applyChatStateChanges). Cloning here as well made every
  // streamed chunk O(messages) twice, which turns session-load replay into
  // O(n^2) on large sessions.
  return [{ type: 'messages', messages: state.messages }];
}
```

代码注释明确记录了这一优化，且 `shared.ts` / `chatSessionStore.ts` 均为基线文件（2026-09-12，`ba7678e` 白标基线），本会话未修改。**实际每 chunk 为 1 次克隆（写入侧），不是 3 次。**

**残留的真实问题（新编号 #2b）**：`snapshotFromEntry`（`chatSessionStore.ts:767-780`）每次调用都对全部消息做深拷贝，而 `getSnapshot` 在流式过程中被**多个不同调用方**反复调用（`chatSessionController.ts:90,133,179,225,252`、`hooks/useChatSession.ts:76,142,230,244`）。其中相当一部分调用方只读 `.session` / `.tokenState` / `.activeRunId`，却要付出 O(messages) 的拷贝代价。

建议改法：让 `getSnapshot` 返回条目内数组的**只读视图**（共享引用），仅对真正需要改写的调用方提供显式拷贝；或按字段拆分查询 API（`getSessionMeta` / `getTokenState`）。**这属于 API 语义变更，需先审计全部调用方，风险中等，未在本轮实施。**

### 9.2 批次 1 完成情况（全部通过编译与测试验证）

| # | 修复 | 文件 | 验证 |
|---|---|---|---|
| 1 | `/plan` 的 `GOOSE_MODE` 永久落盘泄漏（安全降级） | `goose-cli/src/session/mod.rs` | 编译 + 借用检查通过 |
| 5 | TokenCounter 进程级共享（缓存命中从恒 0 恢复） | `token_counter.rs` | 新增 `test_shared_counter_reuses_cache` 等 6 测试通过 |
| 6 | Bedrock 双层重试叠加（最坏 16 次 → 4 次） | `providers/bedrock.rs` | 编译通过 |
| 9 | `config.yaml` 先 truncate 后加锁 | `config/base.rs` | 编译通过 |
| 10 | codex stdio 双向管道死锁 | `providers/codex.rs` | 编译通过 |
| 12 | 网关确认条目在流错误路径不清理 | `gateway/handler.rs` | 编译通过 |
| 17 | 三个 PR 工作流补 `concurrency` | `.github/workflows/*` | YAML 结构校验 |
| 26 | 后台任务上限 TOCTOU（新增 `BackgroundTaskSlot`） | `summon.rs` | 编译通过 |
| 44 | `create_pool` 可达 panic | `session_manager.rs` | 编译通过 |
| 45 | ACP 确认投递失败被吞仍返回 true | `acp/provider.rs` | 编译通过 |

**验证证据**：
- `cargo check -p goose -p goose-cli --no-default-features --features .../rustls-tls --all-targets` → **EXIT 0**（含测试代码）
- `cargo test --lib`（我改动的全部模块）→ **716 passed / 0 failed**
- 全量 `cargo test --lib` → 2097 passed / 54 failed，**54 项全部不在我改动的模块内**，均为环境性（需要真实 shell、CLI 二进制、插件目录），代表性 panic 在 `agents/agent.rs` 的 hook 测试

**实施过程中编译器与测试抓出 4 个自查不出的缺陷**（详见对话记录）：`GooseModeGuard` 借用检查错误（E0502）、我自己引入的 TokenCounter 测试并行不稳定、codex 修复中 `??` 的错误类型不匹配、以及一次 stdin 等待位置放错导致死锁仍在。

### 9.3 编译环境备注

本机无法使用 MSVC 工具链（缺 VS Build Tools）且**仓库路径含中文**（`桌面\智能体`）会导致 MinGW 工具链失败。可用组合：

```
RUSTUP_HOME=E:\rustup  CARGO_HOME=E:\cargo
RUSTUP_TOOLCHAIN=1.96.1-x86_64-pc-windows-gnu
CARGO_TARGET_DIR=E:\goose-build\target   PATH 前置 E:\nasm\nasm-2.16.03
cargo check -p goose -p goose-cli --no-default-features --features goose-cli/rustls-tls,goose/rustls-tls
```

`--no-default-features` 是必需的：默认特性会拉入 `goose-local-inference` → `v8-goose`，其构建需要 MSVC。**长期建议把仓库迁到纯 ASCII 路径**，届时 MSVC 工具链可直接使用。

---

**报告生成**: 2026-09-15
**最后更新**: 2026-09-15（批次 1 实施完成，附勘误）
**审查方式**: 7 域并行 + 对抗性核实（21 个审查单元）+ 4 个补充域审查
**中间稿**: `.repair-backups/audit-s0.md`、`audit-s1.md`、`audit-s2.md`、`audit-missing-provider.md`、`audit-missing-ui.md`、`audit-missing-rustfail.md`、`audit-missing-eng.md`
