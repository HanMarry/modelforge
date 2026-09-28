//! 对照测试入口（需求 4.3、4.5、4.7）。
//!
//! `state_machine_parity_report` 在两条路径上跑完全部用例，输出 JSON 报告；差异项总数大于 0
//! 或有维度没有用例时失败。它标了 `#[ignore]`，普通 `cargo test` 不运行，只由
//! `.github/workflows/modelforge-sm-parity.yml` 用 `--ignored` 单独运行：对照发现的差异是
//! 状态机待修复的问题，不让主 CI 失败。

use super::cases::all_cases;
use super::harness::run_both;
use super::report::{compare_case, report};

/// 报告 JSON 的输出路径；未设置时只打印到标准输出。
const REPORT_PATH_ENV: &str = "GOOSE_PARITY_REPORT";
/// 写进报告的源码 commit；未设置时记为 `unknown`。
const COMMIT_ENV: &str = "GOOSE_PARITY_COMMIT";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "对照差异不阻塞主 CI，由 modelforge-sm-parity.yml 以 --ignored 运行"]
async fn state_machine_parity_report() {
    let cases = all_cases();
    let mut diffs = Vec::new();
    for case in &cases {
        let (legacy, state_machine) = run_both(case).await;
        diffs.extend(compare_case(case, &legacy, &state_machine));
    }
    let commit = std::env::var(COMMIT_ENV).unwrap_or_else(|_| "unknown".to_string());
    let report = report(&commit, &cases, diffs);
    let json = serde_json::to_string_pretty(&report).expect("parity report serializes");
    if let Ok(path) = std::env::var(REPORT_PATH_ENV) {
        std::fs::write(&path, &json).expect("parity report is writable");
    }
    println!("{json}");
    assert!(
        report.passed(),
        "{} parity diff(s); uncovered dimensions: {:?}",
        report.total_diffs,
        report.uncovered_dimensions
    );
}
