//! 轨迹归一化（需求 4.4）：比较前把时间戳与运行时随机生成的标识替换为编号占位值。
//!
//! - 时间戳：键名属于 `TIMESTAMP_KEYS` 的非空值，以及字符串里的日期时间文本，
//!   按出现顺序依次替换为 `<ts#1>`、`<ts#2>`……每次出现各占一个编号，与取值无关，
//!   两条路径跨过秒或分钟边界的先后不同也不会产生差异。
//! - 标识：键名属于 `ID_KEYS` 的字符串整体替换，字符串里的 UUID 片段就地替换，
//!   同一原值在整条轨迹中映射到同一个 `<id#n>`，编号按首次出现顺序分配，保留引用关系。
//!
//! 遍历顺序固定为先事件、后持久化写入，对象按键序遍历。

use std::collections::HashMap;

use regex::{Captures, Regex};
use serde_json::{Map, Value};

use super::model::Trace;

const TIMESTAMP_KEYS: [&str; 7] = [
    "archived_at",
    "created",
    "created_at",
    "created_timestamp",
    "last_message_at",
    "timestamp",
    "updated_at",
];
const ID_KEYS: [&str; 9] = [
    "id",
    "message_id",
    "messageId",
    "request_id",
    "requestId",
    "session_id",
    "sessionId",
    "tool_call_id",
    "toolCallId",
];
// 只用 ASCII 字符类：`regex` 在本 crate 关闭了默认 feature，`\d`、`\s` 依赖 unicode-perl。
const DATETIME_PATTERN: &str = concat!(
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}",
    r"(?::[0-9]{2}(?:\.[0-9]+)?)?(?:Z| ?[+-][0-9]{2}:?[0-9]{2})?"
);
const UUID_PATTERN: &str =
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

/// 返回归一化后的轨迹，输入不变。
pub(super) fn normalize(trace: &Trace) -> Trace {
    let mut normalizer = Normalizer::new();
    let mut events = Vec::with_capacity(trace.events.len());
    for value in &trace.events {
        events.push(normalizer.value(value, None));
    }
    let mut persistence = Vec::with_capacity(trace.persistence.len());
    for value in &trace.persistence {
        persistence.push(normalizer.value(value, None));
    }
    Trace {
        events,
        persistence,
    }
}

pub(super) fn is_timestamp_key(key: &str) -> bool {
    TIMESTAMP_KEYS.contains(&key)
}

pub(super) fn is_id_key(key: &str) -> bool {
    ID_KEYS.contains(&key)
}

struct Normalizer {
    datetime: Regex,
    uuid: Regex,
    ids: HashMap<String, usize>,
    timestamps: usize,
}

impl Normalizer {
    fn new() -> Self {
        Self {
            datetime: Regex::new(DATETIME_PATTERN).expect("valid datetime pattern"),
            uuid: Regex::new(UUID_PATTERN).expect("valid UUID pattern"),
            ids: HashMap::new(),
            timestamps: 0,
        }
    }

    fn value(&mut self, value: &Value, key: Option<&str>) -> Value {
        let timestamp_key = key.is_some_and(is_timestamp_key);
        let id_key = key.is_some_and(is_id_key);
        match value {
            Value::Null => Value::Null,
            _ if timestamp_key => Value::String(next_timestamp(&mut self.timestamps)),
            Value::String(raw) if id_key => Value::String(id_placeholder(&mut self.ids, raw)),
            Value::String(text) => Value::String(self.text(text)),
            Value::Array(items) => {
                let mut normalized = Vec::with_capacity(items.len());
                for item in items {
                    normalized.push(self.value(item, None));
                }
                Value::Array(normalized)
            }
            Value::Object(fields) => {
                let mut normalized = Map::new();
                for (name, item) in fields {
                    let item = self.value(item, Some(name));
                    normalized.insert(name.clone(), item);
                }
                Value::Object(normalized)
            }
            other => other.clone(),
        }
    }

    fn text(&mut self, text: &str) -> String {
        let timestamps = &mut self.timestamps;
        let dated = self
            .datetime
            .replace_all(text, |_: &Captures| next_timestamp(timestamps));
        let ids = &mut self.ids;
        let identified = self
            .uuid
            .replace_all(&dated, |found: &Captures| id_placeholder(ids, &found[0]));
        identified.into_owned()
    }
}

fn next_timestamp(counter: &mut usize) -> String {
    *counter += 1;
    format!("<ts#{counter}>")
}

fn id_placeholder(ids: &mut HashMap<String, usize>, raw: &str) -> String {
    let next = ids.len() + 1;
    let number = *ids.entry(raw.to_string()).or_insert(next);
    format!("<id#{number}>")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn trace(events: Vec<Value>, persistence: Vec<Value>) -> Trace {
        Trace {
            events,
            persistence,
        }
    }

    #[test]
    fn replaces_ids_by_first_occurrence_and_timestamps_by_occurrence() {
        let first = "msg_0b7e5a52-8d0c-4b43-9d64-54f1b3cb0d11";
        let second = "msg_c2a5e1e0-7f55-4d5d-8b0e-2f7c0f7bb9a2";
        let events = vec![
            json!({ "id": first, "created": 1_700_000_000, "text": "hi" }),
            json!({ "id": second, "created": 1_700_000_000 }),
            json!({ "message_id": first, "created_at": "2026-09-19T10:00:00Z" }),
        ];
        let persistence = vec![json!({ "message_id": second, "created_timestamp": 5 })];

        let normalized = normalize(&trace(events, persistence));

        let expected_events = vec![
            json!({ "id": "<id#1>", "created": "<ts#1>", "text": "hi" }),
            json!({ "id": "<id#2>", "created": "<ts#2>" }),
            json!({ "message_id": "<id#1>", "created_at": "<ts#3>" }),
        ];
        let write = json!({ "message_id": "<id#2>", "created_timestamp": "<ts#4>" });
        assert_eq!(normalized, trace(expected_events, vec![write]));
    }

    #[test]
    fn rewrites_uuids_and_datetimes_inside_text() {
        let uuid = "0b7e5a52-8d0c-4b43-9d64-54f1b3cb0d11";
        let text = format!("call {uuid} at 2026-09-19 10:42:00 +08:00, again {uuid}");
        let events = vec![json!({ "text": text, "null_id": null, "id": null })];

        let normalized = normalize(&trace(events, Vec::new()));

        let text = "call <id#1> at <ts#1>, again <id#1>";
        let expected = json!({ "text": text, "null_id": null, "id": null });
        assert_eq!(normalized.events, vec![expected]);
    }

    #[test]
    fn leaves_plain_content_untouched() {
        let events = vec![json!({ "type": "message", "text": "total is 3", "count": 2 })];
        let persistence = vec![json!({ "table": "messages", "role": "user" })];
        let original = trace(events, persistence);

        assert_eq!(normalize(&original), original);
    }
}
