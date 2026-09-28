//! 状态机迁移的对照测试（需求 4）：同一用例分别在 legacy 循环与状态机上运行，
//! 比较事件序列与会话存储写入序列。

mod harness;
mod model;
mod normalize;
mod provider;
mod report;
