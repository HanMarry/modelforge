//! 状态机迁移的对照测试（需求 4）：同一用例分别在 legacy 循环与状态机上运行，
//! 比较事件序列与会话存储写入序列。
//!
//! 普通 `cargo test` 只运行框架自身的单元测试、Property 13 与默认路径守卫；
//! 10 个维度的对照用例由 `runner::state_machine_parity_report`（`#[ignore]`）在专门的
//! workflow 里运行。

mod cases;
mod harness;
mod model;
mod normalize;
mod property;
mod provider;
mod report;
mod runner;
