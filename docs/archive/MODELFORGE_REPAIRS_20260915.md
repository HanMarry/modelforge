# ModelForge 首轮修复记录（2026-09-15）

本轮集中修复凭据保存、论文编译和本地数据保护。保留已有开发改动，未发布安装包，也未操作真实连接器凭据。

## 修改内容

- HTTP 连接器：将标记为凭据的请求头及 Authorization、X-Api-Key 等常见认证头的明文值移入现有 secret store；配置只保存引用。引用按连接器名称、地址和请求头区分，避免不同连接器覆盖同名密钥。已有的环境变量引用继续沿用，重复保存不会把引用当成新密钥。
- 论文编译：保持源文件所在目录作为工作目录，用各编译器支持的参数指定输出位置。相对 `output_dir` 以源文件目录为基准；绝对目录保持不变。拒绝未知编译器；检查 PDF 文件头；编译失败返回 MCP 错误状态。环境探测限时 8 秒，单次编译限时 180 秒，取消等待时终止直接子进程。
- 环境检测：保留 `install_uv` 参数兼容已有调用，但它现在只返回官方安装说明，不执行下载脚本。
- 外部内核：关闭适配器时保留 CLI 配置目录和会话记录。完整上游请求抓取默认关闭，需要开发者明确设置 `MODELFORGE_DEBUG_SHIM=1` 才启用。
- 资产清理：`strip-unshippable.js` 的默认行为仍为列举。实际清理前要求工作区干净、所有待删文件已提交且位于仓库内；输出用于恢复的提交号。未运行实际清理。
- CLI 入口：仅整理原有一条过长的 import，使 Rust 格式检查通过。

## 验证

- 桌面端针对性回归：41 项通过（运行时、内核管理、输出上限）。
- TypeScript 类型检查：通过。
- 修改的 TypeScript 文件 ESLint：通过。
- 修改的前端和清理保护文件 Prettier：通过。
- 清理保护：5 项通过，覆盖可恢复文件、脏树、未跟踪文件、被忽略的目标和仓库外目标。
- 建模 MCP：9 项通过，含本机真实 latexmk 编译。实际样例包含空格路径、相对 `input` 和独立输出目录。
- Rust 格式检查（`cargo fmt --all -- --check`）：通过。
- HTTP 凭据 Rust 回归：15 项通过，覆盖原有扩展转换以及新增密钥引用的往返保存、不同连接器的密钥隔离和会话级明文拒绝。

合计 70 项针对性测试通过。Rust 编译仍有既有未使用导入、变量与测试辅助函数警告，位于此次未修改的实现中；未进行全库测试、付费模型调用或完整桌面安装包构建。

可复用的针对性检查命令（桌面端命令在 `ui/desktop` 执行）：

```text
pnpm exec vitest run src/utils/agentRuntime.test.ts src/utils/agentKernel.test.ts src/utils/shimOutputLimit.test.ts
node --test scripts/strip-safety.test.js
pnpm exec tsc --noEmit
```

Rust 命令在仓库根目录、配置好现有 GNU 工具链环境后执行。本次直接编译当前工作区，缓存复用 `E:\goose-build\target`，未同步或覆盖该目录中的旧源码。

```text
cargo test -p goose-mcp modeling --offline --target-dir E:\goose-build\target -- --include-ignored
cargo test -p goose --lib acp::server::extensions::tests --features portable-default,system-keyring,nostr --offline --target-dir E:\goose-build\target
```

第一条命令包含需要本机安装 latexmk/TeX 的实际编译测试；普通环境可去掉 `-- --include-ignored`。

## 生效与边界

这些是源码修改。运行中的旧程序和已有安装包不会自动获得修复；需要从此工作区重新构建后启用。

已有 HTTP 连接器在新版里重新保存时才会转换旧的明文请求头。此次没有读取或迁移个人配置，历史配置副本也没有改写。自定义认证头应在 `env_keys` 中声明，或使用已有 secret store 的环境变量引用。

修改前文件备份：`E:\桌面\智能体\.repair-backups\20260915-085334`。这只是本轮涉及文件的备份，不是完整项目的 Git 基线。

后续仍需单独完成：整理并提交当前开发基线、替换或取得第三方内容授权、完整建模题质量评估、干净 Windows 环境的安装包验收。原有审查报告保留作历史记录，以本文件的具体修复范围为准。
