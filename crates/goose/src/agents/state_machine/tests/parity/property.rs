//! Property 13：对照轨迹归一化（需求 4.4、4.5）。
//!
//! 轨迹由模板渲染：模板只记录"第几个标识、第几个时间戳"，渲染时代入具体取值。
//! 同一模板用两组标识（各自互不相同）与两组任意时间戳渲染，就是对同一轨迹做的一致重命名。

use std::collections::BTreeSet;

use chrono::{DateTime, Utc};
use proptest::prelude::*;
use serde_json::{json, Map, Value};
use uuid::Uuid;

use super::model::{CaseInput, Dimension, ParityCase, Trace};
use super::normalize::normalize;
use super::report::{compare_case, diff, report, Section};
use crate::config::GooseMode;

/// 模板里可引用的标识与时间戳个数。
const SLOTS: usize = 6;
/// 2100-01-01T00:00:00Z，保证渲染出的年份是 4 位数。
const LATEST_SECONDS: i64 = 4_102_444_800;
const KINDS: [&str; 3] = ["message", "usage", "history_replaced"];

/// 轨迹中的一项。`id`、`reference`、`text_id` 引用标识槽位，`created`、`created_at`、
/// `text_time` 引用时间戳槽位。
#[derive(Clone, Debug)]
struct Entry {
    kind: &'static str,
    id: usize,
    reference: Option<usize>,
    created: Option<usize>,
    created_at: Option<usize>,
    text: String,
    text_id: Option<usize>,
    text_time: Option<usize>,
}

#[derive(Clone, Debug)]
struct Template {
    events: Vec<Entry>,
    persistence: Vec<Entry>,
}

type EntryParts = (
    &'static str,
    usize,
    Option<usize>,
    Option<usize>,
    Option<usize>,
    String,
    Option<usize>,
    Option<usize>,
);

fn entry_from_parts(parts: EntryParts) -> Entry {
    let (kind, id, reference, created, created_at, text, text_id, text_time) = parts;
    Entry {
        kind,
        id,
        reference,
        created,
        created_at,
        text,
        text_id,
        text_time,
    }
}

fn entry_strategy() -> impl Strategy<Value = Entry> {
    (
        prop::sample::select(KINDS.to_vec()),
        0..SLOTS,
        prop::option::of(0..SLOTS),
        prop::option::of(0..SLOTS),
        prop::option::of(0..SLOTS),
        "[a-z ]{0,12}",
        prop::option::of(0..SLOTS),
        prop::option::of(0..SLOTS),
    )
        .prop_map(entry_from_parts)
}

fn template_strategy() -> impl Strategy<Value = Template> {
    let events = prop::collection::vec(entry_strategy(), 0..6);
    let persistence = prop::collection::vec(entry_strategy(), 0..6);
    (events, persistence).prop_map(|(events, persistence)| Template {
        events,
        persistence,
    })
}

fn times_strategy() -> impl Strategy<Value = Vec<i64>> {
    prop::collection::vec(0..LATEST_SECONDS, SLOTS)
}

/// 从 `seed` 起连续取 `SLOTS` 个 UUID，彼此一定不同，重命名因此是一一对应的。
fn distinct_ids(seed: u128) -> Vec<Uuid> {
    let mut ids = Vec::with_capacity(SLOTS);
    for offset in 0..SLOTS as u128 {
        ids.push(Uuid::from_u128(seed.wrapping_add(offset)));
    }
    ids
}

fn datetime(seconds: i64) -> String {
    let moment = DateTime::<Utc>::from_timestamp(seconds, 0);
    moment.expect("timestamp in range").to_rfc3339()
}

fn render_entry(entry: &Entry, ids: &[Uuid], times: &[i64]) -> Value {
    let mut fields = Map::new();
    fields.insert("type".to_string(), json!(entry.kind));
    let id = format!("msg_{}", ids[entry.id]);
    fields.insert("id".to_string(), json!(id));
    if let Some(slot) = entry.reference {
        let reference = format!("msg_{}", ids[slot]);
        fields.insert("message_id".to_string(), json!(reference));
    }
    if let Some(slot) = entry.created {
        fields.insert("created".to_string(), json!(times[slot]));
    }
    if let Some(slot) = entry.created_at {
        fields.insert("created_at".to_string(), json!(datetime(times[slot])));
    }
    let mut text = entry.text.clone();
    if let Some(slot) = entry.text_id {
        text = format!("{text} ref {} end", ids[slot]);
    }
    if let Some(slot) = entry.text_time {
        text = format!("{text} at {}", datetime(times[slot]));
    }
    fields.insert("text".to_string(), Value::String(text));
    Value::Object(fields)
}

fn render(template: &Template, ids: &[Uuid], times: &[i64]) -> Trace {
    let mut events = Vec::new();
    for entry in &template.events {
        events.push(render_entry(entry, ids, times));
    }
    let mut persistence = Vec::new();
    for entry in &template.persistence {
        persistence.push(render_entry(entry, ids, times));
    }
    Trace {
        events,
        persistence,
    }
}

fn property_case() -> ParityCase {
    let input = CaseInput {
        turns: Vec::new(),
        script: Vec::new(),
        mode: GooseMode::Auto,
        calculator: false,
        hook: None,
        max_turns: 1,
    };
    ParityCase {
        name: "property-13",
        dimension: Dimension::MessageVisibility,
        input,
        initial_session: Vec::new(),
    }
}

/// 第 `index` 项；`changed` 为真时只改动文本内容，标识与时间戳保持不变。
fn item(index: usize, text: &str, changed: bool) -> Value {
    let text = if changed {
        format!("{text}!")
    } else {
        text.to_string()
    };
    json!({
        "type": "message",
        "id": format!("msg_{index}"),
        "created": 1_700_000_000 + index,
        "text": text
    })
}

// Feature: mathmodel-parity-and-beyond, Property 13: 对照轨迹归一化
proptest! {
    #![proptest_config(ProptestConfig::with_cases(100))]

    #[test]
    fn consistent_renaming_leaves_the_normalized_trace_unchanged(
        template in template_strategy(),
        seeds in (any::<u128>(), any::<u128>()),
        times in (times_strategy(), times_strategy()),
    ) {
        let first_ids = distinct_ids(seeds.0);
        let second_ids = distinct_ids(seeds.1);
        let first = normalize(&render(&template, &first_ids, &times.0));
        let second = normalize(&render(&template, &second_ids, &times.1));

        prop_assert_eq!(&first, &second);
        let mismatches = diff(&first, &second);
        prop_assert!(mismatches.is_empty(), "unexpected diffs: {mismatches:?}");

        let flat = serde_json::to_string(&(&first.events, &first.persistence)).unwrap();
        for id in &first_ids {
            let raw = id.to_string();
            let leaked = flat.contains(&raw);
            prop_assert!(!leaked, "{raw} survived normalization");
        }
    }

    #[test]
    fn every_differing_position_is_reported_and_counted(
        texts in prop::collection::vec("[a-z ]{0,12}", 0..8),
        changed in prop::collection::btree_set(0..8usize, 0..4),
        extra in 0..3usize,
        in_persistence in any::<bool>(),
    ) {
        let mut legacy_items = Vec::new();
        let mut state_machine_items = Vec::new();
        let mut expected = BTreeSet::new();
        for (index, text) in texts.iter().enumerate() {
            let differs = changed.contains(&index);
            if differs {
                expected.insert(index);
            }
            legacy_items.push(item(index, text, false));
            state_machine_items.push(item(index, text, differs));
        }
        for offset in 0..extra {
            let index = texts.len() + offset;
            expected.insert(index);
            state_machine_items.push(item(index, "extra", false));
        }
        let (legacy, state_machine, section) = if in_persistence {
            let legacy = Trace {
                events: Vec::new(),
                persistence: legacy_items,
            };
            let state_machine = Trace {
                events: Vec::new(),
                persistence: state_machine_items,
            };
            (legacy, state_machine, Section::Persistence)
        } else {
            let legacy = Trace {
                events: legacy_items,
                persistence: Vec::new(),
            };
            let state_machine = Trace {
                events: state_machine_items,
                persistence: Vec::new(),
            };
            (legacy, state_machine, Section::Events)
        };

        let case = property_case();
        let items = compare_case(&case, &Ok(legacy), &Ok(state_machine));
        let reported: BTreeSet<usize> = items.iter().map(|item| item.index).collect();
        prop_assert_eq!(&reported, &expected);
        let same_section = items.iter().all(|item| item.section == section);
        prop_assert!(same_section);

        let summary = report("property-13", std::slice::from_ref(&case), items);
        prop_assert_eq!(summary.total_diffs, summary.diffs.len());
        prop_assert_eq!(summary.total_diffs, expected.len());
        prop_assert_eq!(summary.cases[0].diffs, expected.len());
    }
}
