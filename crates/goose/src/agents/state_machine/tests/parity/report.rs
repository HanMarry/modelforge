//! 逐项比较两条路径的归一化轨迹，并汇总为差异报告（需求 4.4、4.5、4.6、4.7）。
//!
//! 报告字段与设计文档的 `ParityReport` 一致（camelCase），另加 `section` 标明差异出在
//! 事件序列、持久化写入还是运行本身，以及每个用例的差异计数 `cases`。

use serde::Serialize;
use serde_json::{json, Value};

use super::model::{Dimension, ExecPath, FailureKind, ParityCase, PathResult, Trace};
use super::normalize::normalize;

/// 差异所在的比较范围。
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Section {
    Events,
    Persistence,
    /// 某条路径出错、panic 或超时，整个用例记 1 个差异项。
    Run,
}

/// 同一位置上两侧的值不同；某侧缺这一项时该侧为 `null`。
#[derive(Clone, Debug, PartialEq)]
pub(super) struct TraceDiff {
    pub(super) section: Section,
    pub(super) index: usize,
    pub(super) legacy: Value,
    pub(super) state_machine: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DiffItem {
    pub(super) case: String,
    pub(super) dimension: Dimension,
    pub(super) section: Section,
    pub(super) index: usize,
    pub(super) legacy: Value,
    pub(super) state_machine: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) failure: Option<FailureKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) path: Option<ExecPath>,
}

impl DiffItem {
    fn from_trace(case: &ParityCase, diff: TraceDiff) -> Self {
        Self {
            case: case.name.to_string(),
            dimension: case.dimension,
            section: diff.section,
            index: diff.index,
            legacy: diff.legacy,
            state_machine: diff.state_machine,
            failure: None,
            path: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CaseSummary {
    pub(super) name: String,
    pub(super) dimension: Dimension,
    pub(super) diffs: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ParityReport {
    pub(super) commit: String,
    pub(super) total_diffs: usize,
    pub(super) uncovered_dimensions: Vec<Dimension>,
    pub(super) cases: Vec<CaseSummary>,
    pub(super) diffs: Vec<DiffItem>,
}

impl ParityReport {
    /// 差异项为 0 且每个维度都有用例时才算通过（需求 4.7）。
    pub(super) fn passed(&self) -> bool {
        self.total_diffs == 0 && self.uncovered_dimensions.is_empty()
    }
}

/// 按位置逐项比较两条已归一化的轨迹：先事件序列，后持久化写入序列。
pub(super) fn diff(legacy: &Trace, state_machine: &Trace) -> Vec<TraceDiff> {
    let mut diffs = Vec::new();
    diff_section(
        Section::Events,
        &legacy.events,
        &state_machine.events,
        &mut diffs,
    );
    diff_section(
        Section::Persistence,
        &legacy.persistence,
        &state_machine.persistence,
        &mut diffs,
    );
    diffs
}

fn diff_section(
    section: Section,
    legacy: &[Value],
    state_machine: &[Value],
    diffs: &mut Vec<TraceDiff>,
) {
    let length = legacy.len().max(state_machine.len());
    for index in 0..length {
        let left = legacy.get(index);
        let right = state_machine.get(index);
        if left == right {
            continue;
        }
        diffs.push(TraceDiff {
            section,
            index,
            legacy: left.cloned().unwrap_or(Value::Null),
            state_machine: right.cloned().unwrap_or(Value::Null),
        });
    }
}

/// 把一个用例两条路径的结果变成差异项：都成功时归一化后逐项比较；
/// 任一路径失败时记 1 个差异项，注明先失败的路径与失败原因（需求 4.6）。
pub(super) fn compare_case(
    case: &ParityCase,
    legacy: &PathResult,
    state_machine: &PathResult,
) -> Vec<DiffItem> {
    let (path, failure) = match (legacy, state_machine) {
        (Ok(legacy), Ok(state_machine)) => {
            let legacy = normalize(legacy);
            let state_machine = normalize(state_machine);
            let mut items = Vec::new();
            for mismatch in diff(&legacy, &state_machine) {
                items.push(DiffItem::from_trace(case, mismatch));
            }
            return items;
        }
        (Err(failure), _) => (ExecPath::Legacy, failure.kind),
        (Ok(_), Err(failure)) => (ExecPath::StateMachine, failure.kind),
    };
    vec![DiffItem {
        case: case.name.to_string(),
        dimension: case.dimension,
        section: Section::Run,
        index: 0,
        legacy: outcome_summary(legacy),
        state_machine: outcome_summary(state_machine),
        failure: Some(failure),
        path: Some(path),
    }]
}

fn outcome_summary(result: &PathResult) -> Value {
    match result {
        Ok(_) => Value::String("completed".to_string()),
        Err(failure) => json!({ "failure": failure.kind, "reason": failure.reason }),
    }
}

/// 汇总差异项：总数、每个用例的差异数，以及没有任何用例的维度（需求 4.5）。
pub(super) fn report(commit: &str, cases: &[ParityCase], diffs: Vec<DiffItem>) -> ParityReport {
    let mut uncovered_dimensions = Vec::new();
    for dimension in Dimension::ALL {
        let covered = cases.iter().any(|case| case.dimension == dimension);
        if !covered {
            uncovered_dimensions.push(dimension);
        }
    }
    let mut summaries = Vec::with_capacity(cases.len());
    for case in cases {
        let count = diffs.iter().filter(|item| item.case == case.name).count();
        summaries.push(CaseSummary {
            name: case.name.to_string(),
            dimension: case.dimension,
            diffs: count,
        });
    }
    ParityReport {
        commit: commit.to_string(),
        total_diffs: diffs.len(),
        uncovered_dimensions,
        cases: summaries,
        diffs,
    }
}

#[cfg(test)]
mod tests {
    use super::super::model::{CaseInput, PathFailure};
    use super::*;
    use crate::config::GooseMode;

    fn case(name: &'static str, dimension: Dimension) -> ParityCase {
        let input = CaseInput {
            turns: Vec::new(),
            script: Vec::new(),
            mode: GooseMode::Auto,
            calculator: false,
            hook: None,
            max_turns: 1,
        };
        ParityCase {
            name,
            dimension,
            input,
            initial_session: Vec::new(),
        }
    }

    fn trace(events: Vec<Value>) -> Trace {
        Trace {
            events,
            persistence: vec![json!({ "table": "sessions" })],
        }
    }

    #[test]
    fn a_failed_path_is_one_diff_item_naming_the_path_and_reason() {
        let case = case("timeout", Dimension::Cancellation);
        let legacy: PathResult = Ok(Trace::default());
        let failure = PathFailure::new(FailureKind::Timeout, "exceeded 60s");
        let state_machine: PathResult = Err(failure);

        let items = compare_case(&case, &legacy, &state_machine);

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].section, Section::Run);
        assert_eq!(items[0].failure, Some(FailureKind::Timeout));
        assert_eq!(items[0].path, Some(ExecPath::StateMachine));
        assert_eq!(items[0].legacy, json!("completed"));
        assert_eq!(items[0].state_machine["reason"], "exceeded 60s");
    }

    #[test]
    fn report_lists_each_mismatch_and_every_uncovered_dimension() {
        let visibility = case("visibility", Dimension::MessageVisibility);
        let hook = case("hook", Dimension::Hook);
        let legacy = Ok(trace(vec![json!("a"), json!("b")]));
        let state_machine = Ok(trace(vec![json!("a"), json!("c"), json!("d")]));
        let items = compare_case(&visibility, &legacy, &state_machine);
        let cases = [visibility, hook];

        let report = report("abc123", &cases, items);

        let indexes: Vec<usize> = report.diffs.iter().map(|item| item.index).collect();
        assert_eq!(indexes, [1, 2]);
        assert_eq!(report.diffs[1].legacy, Value::Null);
        assert_eq!(report.total_diffs, report.diffs.len());
        assert_eq!(report.cases[0].diffs, 2);
        assert_eq!(report.cases[1].diffs, 0);
        assert_eq!(report.uncovered_dimensions.len(), 8);
        assert!(!report.uncovered_dimensions.contains(&Dimension::Hook));
        assert!(!report.passed());

        let json = serde_json::to_value(&report).unwrap();
        assert_eq!(json["totalDiffs"], 2);
        assert_eq!(json["diffs"][0]["stateMachine"], "c");
        assert_eq!(json["uncoveredDimensions"][0], "tool_approval");
    }

    #[test]
    fn report_passes_with_no_diffs_and_all_dimensions_covered() {
        let names = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
        let mut cases = Vec::new();
        for (name, dimension) in names.into_iter().zip(Dimension::ALL) {
            cases.push(case(name, dimension));
        }

        let report = report("abc123", &cases, Vec::new());

        assert!(report.passed());
        assert_eq!(report.cases.len(), 10);
    }
}
