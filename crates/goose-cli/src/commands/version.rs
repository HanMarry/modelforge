//! `goose version [--json]`: the version plus the build provenance that build.rs embedded
//! (spec mathmodel-parity-and-beyond, requirement 3.2, 3.6, 3.9). The JSON form is what the
//! release pipeline and the desktop diagnostics read; `goose --version` keeps its plain output.

use anyhow::Result;
use serde::Serialize;

const UNKNOWN: &str = "unknown";

/// Output of `goose version --json`. `commit` and `dirty` are `null` when the build could not
/// determine them (no git, or a source copy the pipeline did not describe).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BuildInfo {
    pub version: String,
    pub commit: Option<String>,
    pub dirty: Option<bool>,
    pub features: Vec<String>,
}

impl BuildInfo {
    pub fn current() -> Self {
        Self::from_build_env(
            env!("CARGO_PKG_VERSION"),
            env!("GOOSE_BUILD_COMMIT"),
            env!("GOOSE_BUILD_DIRTY"),
            env!("GOOSE_BUILD_FEATURES"),
        )
    }

    fn from_build_env(version: &str, commit: &str, dirty: &str, features: &str) -> Self {
        Self {
            version: version.to_owned(),
            commit: parse_commit(commit),
            dirty: parse_dirty(dirty),
            features: parse_features(features),
        }
    }

    /// Starts with the same line as `goose --version`.
    fn render_text(&self) -> String {
        let dirty = match self.dirty {
            Some(dirty) => dirty.to_string(),
            None => UNKNOWN.to_owned(),
        };
        let features = if self.features.is_empty() {
            "(none)".to_owned()
        } else {
            self.features.join(", ")
        };
        format!(
            "goose {}\ncommit: {}\ndirty: {}\nfeatures: {}\n",
            self.version,
            self.commit.as_deref().unwrap_or(UNKNOWN),
            dirty,
            features
        )
    }
}

fn parse_commit(value: &str) -> Option<String> {
    let value = value.trim();
    let is_full_sha = value.len() == 40 && value.bytes().all(|b| b.is_ascii_hexdigit());
    is_full_sha.then(|| value.to_ascii_lowercase())
}

fn parse_dirty(value: &str) -> Option<bool> {
    match value.trim() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

fn parse_features(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .collect()
}

pub fn handle_version(json: bool) -> Result<()> {
    let info = BuildInfo::current();
    if json {
        println!("{}", serde_json::to_string(&info)?);
    } else {
        print!("{}", info.render_text());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA: &str = "0123456789abcdef0123456789abcdef01234567";

    #[test]
    fn json_has_exactly_the_documented_fields() {
        let info = BuildInfo::from_build_env("1.2.3", SHA, "false", "aws-providers,rustls-tls");
        let value = serde_json::to_value(&info).unwrap();

        assert_eq!(
            value,
            serde_json::json!({
                "version": "1.2.3",
                "commit": SHA,
                "dirty": false,
                "features": ["aws-providers", "rustls-tls"],
            })
        );
    }

    #[test]
    fn unknown_values_become_null() {
        let info = BuildInfo::from_build_env("1.2.3", UNKNOWN, UNKNOWN, "");
        let value = serde_json::to_value(&info).unwrap();

        assert_eq!(value["commit"], serde_json::Value::Null);
        assert_eq!(value["dirty"], serde_json::Value::Null);
        assert_eq!(value["features"], serde_json::json!([]));
    }

    #[test]
    fn only_full_commit_ids_are_reported() {
        for value in ["0123456", "g123456789abcdef0123456789abcdef01234567", ""] {
            assert_eq!(parse_commit(value), None, "{value}");
        }
        let upper = SHA.to_ascii_uppercase();
        assert_eq!(parse_commit(&upper), Some(SHA.to_owned()));
    }

    #[test]
    fn text_output_starts_like_the_version_flag() {
        let info = BuildInfo::from_build_env("1.2.3", UNKNOWN, "true", "");
        let text = info.render_text();

        assert!(text.starts_with("goose 1.2.3\n"), "{text}");
        assert!(text.contains("\ncommit: unknown\n"), "{text}");
        assert!(text.contains("\ndirty: true\n"), "{text}");
        assert!(text.contains("\nfeatures: (none)\n"), "{text}");
    }

    #[test]
    fn current_build_reports_the_features_it_was_compiled_with() {
        let info = BuildInfo::current();
        let has = |name: &str| info.features.iter().any(|feature| feature == name);

        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
        assert_eq!(has("rustls-tls"), cfg!(feature = "rustls-tls"));
        assert_eq!(has("native-tls"), cfg!(feature = "native-tls"));
        assert_eq!(has("code-mode"), cfg!(feature = "code-mode"));
        assert_eq!(has("system-keyring"), cfg!(feature = "system-keyring"));
        assert!(!has("default"));

        let mut sorted = info.features.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(info.features, sorted);
    }
}
