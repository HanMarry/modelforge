//! The Credential_Store values a Run_Record must not contain, and the Secret_Reference written in
//! place of each (spec mathmodel-parity-and-beyond, requirement 16.2, Property 37).
//!
//! The Credential_Store is goose's secret storage behind [`Config`]: the system keyring, or
//! `secrets.yaml` when the keyring is unavailable. [`KernelSecretValues`] hands the recorder every
//! value stored there, plus every value the Kernel has read as a secret, each with a reference of
//! the form `${secret:<key>}`, the key in `[a-z0-9_]`:
//!
//! - Entries saved through [`ConfigSecretStore`](super::secret_headers::ConfigSecretStore), such
//!   as auth headers, already have a reference: their key is the key of the `${secret:<key>}` the
//!   config file holds, so the record names the same reference.
//! - Every other entry (provider API keys such as `OPENAI_API_KEY`, extension secrets, OAuth
//!   tokens) has none, so [`secret_reference_for_key`] derives one from its key: the key in
//!   lowercase when that leaves only `[a-z0-9_]` (`OPENAI_API_KEY` is `${secret:openai_api_key}`),
//!   otherwise `config_<readable part>_<16 hex digits of SHA-256 over the key>`. The derivation is
//!   deterministic, so one entry is always named the same way.
//! - An environment variable named after the uppercased key overrides an entry
//!   (`Config::get_secret`), so its value counts under the same reference. A secret read from the
//!   environment without a stored entry is registered when the Kernel reads it
//!   ([`register_secret_value`], called by `Config::get_secret`), which also keeps the values of
//!   entries deleted since.
//!
//! Structured entries (OAuth tokens, gateway settings) count with every string inside them. Values
//! shorter than [`MIN_SECRET_CHARS`] characters are left out: replacing short strings such as
//! pairing codes, `Bearer` or `true` would garble ordinary words and numbers of a command while
//! protecting nothing. An auth header value such as `Bearer sk-…` also counts without its scheme,
//! since a command would contain the token alone.
//!
//! The developer `shell` takes [`kernel_secret_values`] directly; goose-cli installs it as the
//! builtin modeling extension's run integration when the Kernel starts.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, PoisonError, RwLock};

use goose_run_record::run_record::SecretValue;
use goose_run_record::run_recorder::SecretValues;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::secret_headers::SecretRef;
use super::{Config, ConfigError};

/// Shorter values are not treated as credentials; see the module documentation.
pub const MIN_SECRET_CHARS: usize = 8;
/// Bounds the values remembered from secret reads in a long-running process.
const MAX_REGISTERED_VALUES: usize = 1024;
/// Longest readable part of a derived reference key.
const SLUG_MAX_LEN: usize = 40;
/// Auth schemes whose token also counts on its own, compared case-insensitively.
const AUTH_SCHEMES: &[&str] = &["Bearer ", "Basic ", "Token "];

/// The Secret_Reference written in place of the value of the Credential_Store entry `key`.
pub fn secret_reference_for_key(key: &str) -> String {
    let reference_key = SecretRef::new(key)
        .or_else(|| SecretRef::new(key.to_ascii_lowercase()))
        .map(|reference| reference.key().to_string())
        .unwrap_or_else(|| {
            // The readable part is lossy (`a-b` and `a_b` read the same); the digest of the
            // exact key keeps two entries apart.
            let digest = Sha256::digest(key.as_bytes());
            let suffix: String = digest[..8]
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
            format!("config_{}_{suffix}", slug(key))
        });
    format!("${{secret:{reference_key}}}")
}

/// ASCII letters and digits in lowercase, every other run of characters folded into one `_`.
/// Never empty, never starts or ends with `_`.
fn slug(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        if out.len() >= SLUG_MAX_LEN {
            break;
        }
        let ch = ch.to_ascii_lowercase();
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            out.push(ch);
        } else if !out.is_empty() && !out.ends_with('_') {
            out.push('_');
        }
    }
    let trimmed = out.trim_end_matches('_');
    if trimmed.is_empty() {
        "x".to_string()
    } else {
        trimmed.to_string()
    }
}

/// The credential strings of the entry `key` holding `value`, each with the entry's reference.
fn credentials_of(key: &str, value: &Value, out: &mut Vec<SecretValue>) {
    let mut strings = Vec::new();
    collect_strings(value, &mut strings);
    if strings.is_empty() {
        return;
    }
    let reference = secret_reference_for_key(key);
    for text in strings {
        push_credential(&reference, text, out);
        for scheme in AUTH_SCHEMES {
            let token = text
                .get(..scheme.len())
                .filter(|head| head.eq_ignore_ascii_case(scheme))
                .and_then(|_| text.get(scheme.len()..));
            if let Some(token) = token {
                push_credential(&reference, token.trim_start(), out);
            }
        }
    }
}

fn collect_strings<'a>(value: &'a Value, out: &mut Vec<&'a str>) {
    match value {
        Value::String(text) => out.push(text.as_str()),
        Value::Array(items) => {
            for item in items {
                collect_strings(item, out);
            }
        }
        Value::Object(map) => {
            for item in map.values() {
                collect_strings(item, out);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

fn push_credential(reference: &str, value: &str, out: &mut Vec<SecretValue>) {
    if value.chars().count() >= MIN_SECRET_CHARS && !value.trim().is_empty() {
        out.push(SecretValue {
            reference: reference.to_string(),
            value: value.to_string(),
        });
    }
}

/// Credential values the Kernel has read or written, with their references.
#[derive(Debug, Default)]
pub struct SecretReferenceRegistry {
    /// Value to reference; the reference a value was first registered with stays.
    values: RwLock<BTreeMap<String, String>>,
}

impl SecretReferenceRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Remembers the credential strings of the secret `key`, whose value is `value`.
    pub fn register(&self, key: &str, value: &Value) {
        let mut found = Vec::new();
        credentials_of(key, value, &mut found);
        if found.is_empty() {
            return;
        }
        {
            let known = self.values.read().unwrap_or_else(PoisonError::into_inner);
            if found.iter().all(|secret| known.contains_key(&secret.value)) {
                return;
            }
        }
        let mut values = self.values.write().unwrap_or_else(PoisonError::into_inner);
        for secret in found {
            if values.len() >= MAX_REGISTERED_VALUES {
                break;
            }
            values.entry(secret.value).or_insert(secret.reference);
        }
    }

    pub fn secret_values(&self) -> Vec<SecretValue> {
        self.values
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .map(|(value, reference)| SecretValue {
                reference: reference.clone(),
                value: value.clone(),
            })
            .collect()
    }
}

/// Reads every entry of a Credential_Store, keyed by entry key.
type StoredSecrets = dyn Fn() -> Result<HashMap<String, Value>, ConfigError> + Send + Sync;

/// The Kernel's source of the values a Run_Record must not contain: the entries of a
/// Credential_Store with their environment overrides, and the secrets registered as read.
pub struct KernelSecretValues {
    stored: Box<StoredSecrets>,
    registry: Arc<SecretReferenceRegistry>,
}

impl KernelSecretValues {
    pub fn new(
        stored: impl Fn() -> Result<HashMap<String, Value>, ConfigError> + Send + Sync + 'static,
        registry: Arc<SecretReferenceRegistry>,
    ) -> Self {
        Self {
            stored: Box::new(stored),
            registry,
        }
    }
}

impl SecretValues for KernelSecretValues {
    fn secret_values(&self) -> Vec<SecretValue> {
        let mut values = Vec::new();
        match (self.stored)() {
            Ok(stored) => {
                // In key order, so the same store always yields the same list.
                let entries: BTreeMap<&String, &Value> = stored.iter().collect();
                for (key, value) in entries {
                    credentials_of(key, value, &mut values);
                    // Config::get_secret reads this variable before the stored entry.
                    if let Ok(text) = std::env::var(key.to_uppercase()) {
                        credentials_of(key, &Value::String(text), &mut values);
                    }
                }
            }
            // The record is still written, with the values registered so far: losing the
            // record of a finished step would break resuming (requirement 22.4).
            Err(error) => tracing::debug!(
                %error,
                "the credential store could not be read for Run_Record redaction"
            ),
        }
        values.extend(self.registry.secret_values());
        let mut seen = HashSet::new();
        values.retain(|secret| seen.insert(secret.value.clone()));
        values
    }
}

#[cfg(not(test))]
fn with_global_registry<R>(f: impl FnOnce(&Arc<SecretReferenceRegistry>) -> R) -> R {
    static REGISTRY: std::sync::LazyLock<Arc<SecretReferenceRegistry>> =
        std::sync::LazyLock::new(|| Arc::new(SecretReferenceRegistry::new()));
    f(&REGISTRY)
}

/// Unit tests run in parallel threads of one process. A registry per thread keeps the secrets
/// one test reads from changing the records another test checks.
#[cfg(test)]
fn with_global_registry<R>(f: impl FnOnce(&Arc<SecretReferenceRegistry>) -> R) -> R {
    thread_local! {
        static REGISTRY: Arc<SecretReferenceRegistry> = Arc::new(SecretReferenceRegistry::new());
    }
    REGISTRY.with(f)
}

/// Remembers a secret the Kernel read, so the Run_Records written later replace it even when it
/// came from an environment variable rather than the Credential_Store.
pub fn register_secret_value(key: &str, value: &Value) {
    with_global_registry(|registry| registry.register(key, value));
}

/// The Kernel's Credential_Store values for Run_Records: the secrets of [`Config::global`] and
/// the secrets registered with [`register_secret_value`].
pub fn kernel_secret_values() -> Arc<dyn SecretValues> {
    let registry = with_global_registry(Arc::clone);
    Arc::new(KernelSecretValues::new(
        || Config::global().all_secrets(),
        registry,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::secret_headers::{
        parse_secret_ref, secret_ref_for, ConfigSecretStore, SecretOwner, SecretStore,
    };
    use goose_run_record::run_record::{Dependency, RunRecord};
    use goose_run_record::run_recorder::{ProbedEnvironment, RunOutcome, RunRecorder, RunSpec};
    use proptest::prelude::*;
    use serde_json::json;
    use std::fs;
    use std::path::{Path, PathBuf};

    /// A Config whose secrets live in `secrets.yaml` under `dir`. Every key the tests store is
    /// made up, so no environment variable of the machine running them overrides it.
    fn file_config(dir: &Path) -> Arc<Config> {
        fs::create_dir_all(dir).unwrap();
        Arc::new(
            Config::new_with_file_secrets(dir.join("config.yaml"), dir.join("secrets.yaml"))
                .unwrap(),
        )
    }

    fn source(config: &Arc<Config>, registry: Arc<SecretReferenceRegistry>) -> KernelSecretValues {
        let config = Arc::clone(config);
        KernelSecretValues::new(move || config.all_secrets(), registry)
    }

    fn supplied(source: &KernelSecretValues) -> BTreeMap<String, String> {
        source
            .secret_values()
            .into_iter()
            .map(|secret| (secret.value, secret.reference))
            .collect()
    }

    #[test]
    fn references_follow_the_entry_key() {
        let header = secret_ref_for(SecretOwner::Provider("custom_gw"), "Authorization");
        assert_eq!(secret_reference_for_key(header.key()), header.to_string());
        assert_eq!(
            secret_reference_for_key("OPENAI_API_KEY"),
            "${secret:openai_api_key}"
        );

        let odd = secret_reference_for_key("github-mcp/GITHUB_TOKEN");
        assert!(
            odd.starts_with("${secret:config_github_mcp_github_token_"),
            "{odd}"
        );
        assert_eq!(secret_reference_for_key("github-mcp/GITHUB_TOKEN"), odd);
        assert_ne!(secret_reference_for_key("github_mcp/GITHUB_TOKEN"), odd);
        for key in ["github-mcp/GITHUB_TOKEN", "中文 密钥", "", "--", "a.b"] {
            let reference = secret_reference_for_key(key);
            assert!(
                parse_secret_ref(&reference).is_some(),
                "{key:?}: {reference}"
            );
        }
    }

    #[test]
    fn stored_entries_and_registered_reads_are_supplied_with_their_references() {
        let dir = tempfile::tempdir().unwrap();
        let config = file_config(dir.path());
        config
            .set_secret("MF_RRS_PROVIDER_API_KEY", &"sk-provider-0123456789")
            .unwrap();
        let header = secret_ref_for(SecretOwner::Provider("mf_rrs_gateway"), "Authorization");
        ConfigSecretStore::new(&config)
            .set(header.key(), "Bearer sk-header-abcdef")
            .unwrap();
        config
            .set_secret(
                "mf_rrs_oauth",
                &json!({ "access_token": "at-0123456789", "token_type": "Bearer", "expires_at": 1 }),
            )
            .unwrap();
        config.set_secret("MF_RRS_PAIRING_CODE", &"123456").unwrap();
        let registry = Arc::new(SecretReferenceRegistry::new());
        registry.register("MF_RRS_ENV_ONLY_KEY", &json!("sk-env-only-000111"));

        let values = supplied(&source(&config, registry));

        let expected: BTreeMap<String, String> = [
            (
                "sk-provider-0123456789",
                "${secret:mf_rrs_provider_api_key}".to_string(),
            ),
            ("Bearer sk-header-abcdef", header.to_string()),
            ("sk-header-abcdef", header.to_string()),
            ("at-0123456789", "${secret:mf_rrs_oauth}".to_string()),
            (
                "sk-env-only-000111",
                "${secret:mf_rrs_env_only_key}".to_string(),
            ),
        ]
        .into_iter()
        .map(|(value, reference)| (value.to_string(), reference))
        .collect();
        assert_eq!(values, expected);
    }

    #[test]
    fn an_environment_override_counts_under_the_entry_reference() {
        let dir = tempfile::tempdir().unwrap();
        let config = file_config(dir.path());
        // Unique, so no other test reads it.
        let key = "MF_RUN_RECORD_SECRETS_TEST_TOKEN";
        config.set_secret(key, &"stored-value-0001").unwrap();
        std::env::set_var(key, "override-value-0002");
        let values = supplied(&source(&config, Arc::new(SecretReferenceRegistry::new())));
        std::env::remove_var(key);

        let reference = "${secret:mf_run_record_secrets_test_token}".to_string();
        assert_eq!(values.get("stored-value-0001"), Some(&reference));
        assert_eq!(values.get("override-value-0002"), Some(&reference));
    }

    #[test]
    fn an_unreadable_store_still_supplies_the_registered_values() {
        let registry = Arc::new(SecretReferenceRegistry::new());
        registry.register("MF_RRS_REGISTERED_KEY", &json!("gsk-registered-0001"));
        let source = KernelSecretValues::new(
            || Err(ConfigError::KeyringError("locked".to_string())),
            registry,
        );
        assert_eq!(
            supplied(&source),
            BTreeMap::from([(
                "gsk-registered-0001".to_string(),
                "${secret:mf_rrs_registered_key}".to_string()
            )])
        );
    }

    #[test]
    fn secrets_read_through_the_config_are_registered() {
        let dir = tempfile::tempdir().unwrap();
        let config = file_config(dir.path());
        config
            .set_secret("MF_RRS_READ_KEY", &"xai-registered-0001")
            .unwrap();
        let _: String = config.get_secret("MF_RRS_READ_KEY").unwrap();
        // Deleted afterwards: the value read before is still known.
        config.delete_secret("MF_RRS_READ_KEY").unwrap();

        let registered: BTreeMap<String, String> =
            with_global_registry(|registry| registry.secret_values())
                .into_iter()
                .map(|secret| (secret.value, secret.reference))
                .collect();
        assert_eq!(
            registered.get("xai-registered-0001").map(String::as_str),
            Some("${secret:mf_rrs_read_key}")
        );
    }

    /// How a generated entry is kept.
    #[derive(Debug, Clone, Copy)]
    enum Kept {
        /// A provider auth header, saved through `ConfigSecretStore`.
        Header,
        /// A plain stored entry under an environment-style key.
        Stored,
        /// A stored structured entry, the value inside an object.
        Structured,
        /// Only read by the Kernel (from the environment), never stored.
        Registered,
    }

    #[derive(Debug, Clone)]
    struct Entry {
        kept: Kept,
        name: String,
        value: String,
    }

    impl Entry {
        fn key(&self) -> String {
            match self.kept {
                Kept::Header => secret_ref_for(SecretOwner::Provider(&self.name), "Authorization")
                    .key()
                    .to_string(),
                Kept::Stored | Kept::Registered => format!("MF_{}_API_KEY", self.name),
                Kept::Structured => format!("mf-{}-oauth/token", self.name.to_lowercase()),
            }
        }

        /// What the record must hold in place of the value.
        fn reference(&self) -> String {
            match self.kept {
                Kept::Header => {
                    secret_ref_for(SecretOwner::Provider(&self.name), "Authorization").to_string()
                }
                _ => secret_reference_for_key(&self.key()),
            }
        }
    }

    fn kept() -> impl Strategy<Value = Kept> {
        prop_oneof![
            Just(Kept::Header),
            Just(Kept::Stored),
            Just(Kept::Structured),
            Just(Kept::Registered),
        ]
    }

    /// Distinct values; each starts with `sk-`, which no reference, path, hash, run id or
    /// timestamp of a record contains, so a value can only appear where the test put it.
    fn entries() -> impl Strategy<Value = Vec<Entry>> {
        prop::collection::btree_map(
            "sk-[A-Za-z0-9]{6,16}[一二三]?",
            (kept(), "[A-Z]{2,8}"),
            1..5,
        )
        .prop_map(|entries| {
            entries
                .into_iter()
                .enumerate()
                .map(|(index, (value, (kept, name)))| Entry {
                    kept,
                    // The index keeps two entries from sharing a key.
                    name: format!("{name}{index}"),
                    value,
                })
                .collect()
        })
    }

    fn keep(entries: &[Entry], config: &Config, registry: &SecretReferenceRegistry) {
        for entry in entries {
            match entry.kept {
                Kept::Header => ConfigSecretStore::new(config)
                    .set(&entry.key(), &entry.value)
                    .unwrap(),
                Kept::Stored => config.set_secret(&entry.key(), &entry.value).unwrap(),
                Kept::Structured => config
                    .set_secret(
                        &entry.key(),
                        &json!({ "access_token": entry.value, "expires_at": 1 }),
                    )
                    .unwrap(),
                Kept::Registered => registry.register(&entry.key(), &json!(entry.value)),
            }
        }
    }

    /// `prefix` and one `--key <pick(entry)>` per entry, joined by spaces.
    fn line(prefix: &str, entries: &[Entry], pick: impl Fn(&Entry) -> String) -> String {
        std::iter::once(prefix.to_string())
            .chain(entries.iter().map(|entry| format!("--key {}", pick(entry))))
            .collect::<Vec<_>>()
            .join(" ")
    }

    // Feature: mathmodel-parity-and-beyond, Property 37: Run_Record 不含凭据原文
    // With the Kernel's real source: entries in a Credential_Store (headers, plain and structured
    // entries) and secrets only read from the environment, embedded in the command, the model
    // and runtime identifiers and the dependency summary of a run the recorder writes.
    proptest! {
        #![proptest_config(ProptestConfig::with_cases(100))]

        #[test]
        fn records_written_with_the_kernel_source_contain_no_credential_value(
            entries in entries(),
        ) {
            let dir = tempfile::tempdir().unwrap();
            let config = file_config(&dir.path().join("config"));
            let registry = Arc::new(SecretReferenceRegistry::new());
            keep(&entries, &config, &registry);

            let project = dir.path().join("project");
            fs::create_dir_all(project.join("code")).unwrap();
            fs::write(project.join("code/main.py"), "print(1)\n").unwrap();
            let recorder =
                RunRecorder::new(&project, Arc::new(source(&config, registry))).unwrap();
            let first = &entries[0];
            let handle = recorder
                .begin(RunSpec {
                    command: line("python code/main.py", &entries, |entry| entry.value.clone()),
                    code: PathBuf::from("code/main.py"),
                    inputs: Some(Vec::new()),
                    outputs: Some(Vec::new()),
                    seed: None,
                    provider: first.value.clone(),
                    model: format!("model {}", first.value),
                })
                .unwrap();
            let dependencies = entries
                .iter()
                .map(|entry| Dependency {
                    name: format!("pkg-{}", entry.value),
                    version: entry.value.clone(),
                })
                .collect();
            let run = recorder
                .finish(
                    handle,
                    RunOutcome::Exited(0),
                    ProbedEnvironment {
                        runtime: format!("python {}", first.value),
                        dependencies,
                    },
                )
                .unwrap();

            let text = fs::read_to_string(&run.path).unwrap();
            for entry in &entries {
                prop_assert!(!text.contains(&entry.value), "{} in {}", entry.value, text);
            }
            let record = RunRecord::from_json(&text).unwrap();
            prop_assert_eq!(
                &record.command,
                &line("python code/main.py", &entries, Entry::reference)
            );
            prop_assert_eq!(&record.config.provider, &first.reference());
            prop_assert_eq!(&record.config.model, &format!("model {}", first.reference()));
            prop_assert_eq!(&record.config.runtime, &format!("python {}", first.reference()));
            for (dependency, entry) in record.dependencies.iter().zip(&entries) {
                prop_assert_eq!(&dependency.name, &format!("pkg-{}", entry.reference()));
                prop_assert_eq!(&dependency.version, &entry.reference());
            }
        }
    }
}
