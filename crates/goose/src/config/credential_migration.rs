//! Moving plaintext auth header values out of config files at startup (requirements 1.8, 1.9,
//! 1.11).
//!
//! Older versions, hand edits and imported configs can leave the value of an auth header in
//! plaintext in a custom provider file, or in an MCP extension entry of `config.yaml`. Before
//! any provider is built, each such config is migrated on its own: every value is written to the
//! credential store, every entry is read back and compared with the plaintext, and only then is
//! the config replaced atomically with one that holds secret references. When a step fails, the
//! entries written for that config are deleted and the config keeps its bytes. Nothing records
//! that a migration was tried, so the next start plans the same migration again.

use std::collections::HashSet;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use serde_json::{json, Value};

use crate::config::atomic_fs::{AtomicFs, StdAtomicFs};
use crate::config::declarative_providers::{custom_providers_dir, deserialize_provider_config};
use crate::config::extension_credentials::migrate_extensions;
use crate::config::provider_credentials::header_secret_keys;
use crate::config::secret_headers::{
    is_auth_header, is_marked_sensitive, looks_like_secret_ref, secret_ref_for, ConfigSecretStore,
    SecretOwner, SecretStore,
};
use crate::config::Config;

/// The step of a migration that failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MigrationStage {
    /// Writing a value to the credential store.
    Write,
    /// Reading an entry back and comparing it with the plaintext.
    Verify,
    /// Replacing the config with one that holds references.
    Replace,
}

impl MigrationStage {
    pub fn as_str(self) -> &'static str {
        match self {
            MigrationStage::Write => "write",
            MigrationStage::Verify => "verify",
            MigrationStage::Replace => "replace",
        }
    }
}

impl fmt::Display for MigrationStage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// What kind of config a migration concerns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MigrationOwner {
    Provider,
    Extension,
}

impl MigrationOwner {
    pub fn as_str(self) -> &'static str {
        match self {
            MigrationOwner::Provider => "provider",
            MigrationOwner::Extension => "extension",
        }
    }
}

impl fmt::Display for MigrationOwner {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A config whose plaintext headers could not be migrated. The message names the config and the
/// failed step, and never contains a credential value.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{owner} {name}: plaintext header migration failed at {stage}: {cause}")]
pub struct MigrationError {
    pub owner: MigrationOwner,
    /// Provider display name or extension name.
    pub name: String,
    pub stage: MigrationStage,
    pub cause: String,
}

/// One plaintext header value to move into the credential store.
///
/// Deliberately not `Debug`: it carries the value.
pub struct MigrationItem {
    header: String,
    key: String,
    value: String,
}

impl MigrationItem {
    pub(crate) fn new(header: &str, key: &str, value: &str) -> Self {
        Self {
            header: header.to_string(),
            key: key.to_string(),
            value: value.to_string(),
        }
    }

    pub fn header(&self) -> &str {
        &self.header
    }

    pub fn key(&self) -> &str {
        &self.key
    }
}

/// The migration of one custom provider file.
///
/// Deliberately not `Debug`: it carries credential values.
pub struct MigrationPlan {
    /// Provider display name, for messages.
    pub provider: String,
    pub file: PathBuf,
    pub items: Vec<MigrationItem>,
    /// The file with every migrated value replaced by its reference.
    replacement: Vec<u8>,
}

/// A header value that would be sent as it is: not empty and not a secret reference.
pub(crate) fn is_plaintext(value: &str) -> bool {
    !value.is_empty() && !looks_like_secret_ref(value)
}

/// Plans the migration of the custom provider file `file` whose contents are `original`: every
/// auth header, a well-known name or one in `sensitive_headers`, whose value is plaintext.
/// Malformed references are left for resolution to reject. Fields the provider config does not
/// know are kept. Returns `None` when there is nothing to migrate or the file is not a provider
/// config.
pub fn plan_migration(file: &Path, original: &[u8]) -> Option<MigrationPlan> {
    let text = std::str::from_utf8(original).ok()?;
    let config = deserialize_provider_config(text).ok()?;
    let owner = SecretOwner::Provider(&config.name);
    let mut headers: Vec<(&String, &String)> = config.headers.iter().flatten().collect();
    headers.sort_unstable();

    // Two spellings of one header share one entry; never overwrite one that is referred to.
    let mut taken: HashSet<String> = header_secret_keys(&config).into_iter().collect();
    let mut items = Vec::new();
    for (name, value) in headers {
        let marked = is_marked_sensitive(name, &config.sensitive_headers);
        if !is_plaintext(value) || !is_auth_header(name, marked) {
            continue;
        }
        let reference = secret_ref_for(owner, name);
        if taken.insert(reference.key().to_string()) {
            items.push(MigrationItem::new(name, reference.key(), value));
        }
    }
    if items.is_empty() {
        return None;
    }

    let mut raw: Value = serde_json::from_str(text).ok()?;
    let object = raw.get_mut("headers")?.as_object_mut()?;
    for item in &items {
        let reference = secret_ref_for(owner, &item.header).to_string();
        object.insert(item.header.clone(), Value::String(reference));
    }
    let replacement = serde_json::to_vec_pretty(&raw).ok()?;
    Some(MigrationPlan {
        provider: config.display_name.clone(),
        file: file.to_path_buf(),
        items,
        replacement,
    })
}

/// Migrates one custom provider file: writes every value, reads every entry back and compares
/// it with the plaintext, then replaces the file atomically. When a step fails, the entries
/// written for this plan are deleted and the file keeps its bytes (requirement 1.9).
pub fn migrate_one(
    plan: &MigrationPlan,
    store: &dyn SecretStore,
    fs: &dyn AtomicFs,
) -> Result<(), MigrationError> {
    let replace = || {
        fs.write_atomic(&plan.file, &plan.replacement)
            .map_err(|error| error.to_string())
    };
    let owner = MigrationOwner::Provider;
    migrate_items(owner, &plan.provider, &plan.items, store, replace)
}

/// The steps shared by provider files and extension entries; `replace` swaps the config.
pub(crate) fn migrate_items<F>(
    owner: MigrationOwner,
    name: &str,
    items: &[MigrationItem],
    store: &dyn SecretStore,
    replace: F,
) -> Result<(), MigrationError>
where
    F: FnOnce() -> Result<(), String>,
{
    let mut attempted = 0;
    let outcome = write_and_verify(items, store, &mut attempted)
        .and_then(|()| replace().map_err(|cause| (MigrationStage::Replace, cause)));
    let Err((stage, mut cause)) = outcome else {
        return Ok(());
    };

    let problems: Vec<String> = items
        .iter()
        .take(attempted)
        .filter_map(|item| store.delete(&item.key).err())
        .map(|error| error.to_string())
        .collect();
    if !problems.is_empty() {
        cause.push_str("; cleanup incomplete: ");
        cause.push_str(&problems.join("; "));
    }
    Err(MigrationError {
        owner,
        name: name.to_string(),
        stage,
        cause,
    })
}

fn write_and_verify(
    items: &[MigrationItem],
    store: &dyn SecretStore,
    attempted: &mut usize,
) -> Result<(), (MigrationStage, String)> {
    for item in items {
        // A write that reports failure may still have reached the store: delete it as well.
        *attempted += 1;
        if let Err(error) = store.set(&item.key, &item.value) {
            let header = &item.header;
            return Err((MigrationStage::Write, format!("header {header}: {error}")));
        }
    }
    for item in items {
        let problem = match store.get(&item.key) {
            Ok(Some(value)) if value == item.value => continue,
            Ok(Some(_)) => "the store returned a different value".to_string(),
            Ok(None) => "the entry is missing after writing it".to_string(),
            Err(error) => error.to_string(),
        };
        let header = &item.header;
        return Err((MigrationStage::Verify, format!("header {header}: {problem}")));
    }
    Ok(())
}

static STARTUP_FAILURES: Mutex<Vec<MigrationError>> = Mutex::new(Vec::new());

/// Migrates every custom provider file and MCP extension entry that holds a plaintext auth
/// header. Called at startup, once the config can be read and before any provider is built.
/// Failures are logged, kept for [`startup_failures`] and returned; the configs they concern are
/// unchanged and are planned again at the next start.
pub fn run_startup_migration() -> Vec<MigrationError> {
    let store = ConfigSecretStore::global();
    let dir = custom_providers_dir();
    let mut failures = migrate_provider_dir(&dir, &store, &StdAtomicFs);
    failures.extend(migrate_extensions(Config::global(), &store));
    for failure in &failures {
        tracing::error!("{failure}");
    }
    let mut recorded = STARTUP_FAILURES
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    recorded.clone_from(&failures);
    failures
}

/// The failures of the last [`run_startup_migration`] of this process.
pub fn startup_failures() -> Vec<MigrationError> {
    STARTUP_FAILURES
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
}

/// How ACP clients learn about failed migrations: the value of
/// `_meta.goose.credentialMigration` in the `initialize` response.
pub fn failures_meta(failures: &[MigrationError]) -> Value {
    let failures: Vec<Value> = failures.iter().map(failure_meta).collect();
    json!({ "failures": failures })
}

fn failure_meta(failure: &MigrationError) -> Value {
    json!({
        "owner": failure.owner.as_str(),
        "name": failure.name,
        "stage": failure.stage.as_str(),
        "message": failure.to_string(),
    })
}

fn migrate_provider_dir(
    dir: &Path,
    store: &dyn SecretStore,
    fs: &dyn AtomicFs,
) -> Vec<MigrationError> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    paths.sort();

    let mut failures = Vec::new();
    for path in paths {
        let Ok(original) = std::fs::read(&path) else {
            continue;
        };
        let Some(plan) = plan_migration(&path, &original) else {
            continue;
        };
        if let Err(error) = migrate_one(&plan, store, fs) {
            failures.push(error);
            continue;
        }
        let headers = plan.items.len();
        tracing::info!(provider = %plan.provider, headers, "moved plaintext headers to the store");
    }
    failures
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::secret_headers::resolve_headers;
    use crate::config::secret_headers::testing::MemorySecretStore;
    use proptest::prelude::*;
    use proptest::test_runner::TestCaseError;
    use std::collections::{BTreeMap, HashMap};
    use std::io;

    const PROVIDER_ID: &str = "custom_gateway";
    const DISPLAY_NAME: &str = "Gateway 网关";
    const HEADER_POOL: [&str; 6] = [
        "Authorization",
        "X-API-Key",
        "api-key",
        "X-Tenant-Token",
        "X-Team",
        "Accept",
    ];
    const MARKABLE: [&str; 2] = ["X-Tenant-Token", "X-Team"];
    /// A header that already refers to the store before the migration.
    const MIGRATED_HEADER: &str = "Proxy-Authorization";
    const MIGRATED_VALUE: &str = "Basic already-stored";

    struct FailingFs;

    impl AtomicFs for FailingFs {
        fn write_atomic(&self, _target: &Path, _contents: &[u8]) -> io::Result<()> {
            Err(io::Error::other("disk full"))
        }
    }

    fn provider_file(headers: &HashMap<String, String>, marks: &[String]) -> Vec<u8> {
        let file = json!({
            "name": PROVIDER_ID,
            "engine": "openai",
            "display_name": DISPLAY_NAME,
            "base_url": "https://gateway.example.invalid/v1",
            "models": [],
            "headers": headers,
            "sensitive_headers": marks,
            "unknown_field": "kept",
        });
        serde_json::to_vec_pretty(&file).unwrap()
    }

    fn own_ref(header: &str) -> String {
        secret_ref_for(SecretOwner::Provider(PROVIDER_ID), header).to_string()
    }

    fn own_key(header: &str) -> String {
        let reference = secret_ref_for(SecretOwner::Provider(PROVIDER_ID), header);
        reference.key().to_string()
    }

    /// Credential-like values with Unicode, whitespace and JSON special characters.
    fn secret_value() -> impl Strategy<Value = String> {
        let tail_pattern = "[ \\t!-~中文🔑]{0,12}";
        ("[A-Za-z0-9]{16}", tail_pattern).prop_map(|(token, tail)| format!("sk-{token}{tail}"))
    }

    fn header_set() -> impl Strategy<Value = BTreeMap<&'static str, String>> {
        let name = prop::sample::select(HEADER_POOL.to_vec());
        prop::collection::btree_map(name, secret_value(), 0..6)
    }

    fn mark_set() -> impl Strategy<Value = Vec<String>> {
        prop::sample::subsequence(MARKABLE.to_vec(), 0..=2)
            .prop_map(|marks| marks.into_iter().map(str::to_string).collect())
    }

    #[derive(Debug, Clone, Copy)]
    enum Failure {
        None,
        /// The write of the k-th item fails.
        Write(usize),
        /// Reading the k-th entry back returns something else.
        VerifyMismatch(usize),
        /// Reading the k-th entry back fails.
        VerifyError(usize),
        Replace,
    }

    fn failure() -> impl Strategy<Value = Failure> {
        prop_oneof![
            Just(Failure::None),
            (0usize..8).prop_map(Failure::Write),
            (0usize..8).prop_map(Failure::VerifyMismatch),
            (0usize..8).prop_map(Failure::VerifyError),
            Just(Failure::Replace),
        ]
    }

    /// Arms `failure` for a migration of `n` items; returns the stage expected to fail.
    fn inject(store: &MemorySecretStore, failure: Failure, n: usize) -> Option<MigrationStage> {
        // Calls of the migration: one `set` per item, then one `get` per item.
        let base = store.calls();
        match failure {
            Failure::None => None,
            Failure::Write(k) => {
                store.fail_on_call(base + k % n + 1);
                Some(MigrationStage::Write)
            }
            Failure::VerifyMismatch(k) => {
                store.mismatch_on_call(base + n + k % n + 1);
                Some(MigrationStage::Verify)
            }
            Failure::VerifyError(k) => {
                store.fail_on_call(base + n + k % n + 1);
                Some(MigrationStage::Verify)
            }
            Failure::Replace => Some(MigrationStage::Replace),
        }
    }

    fn json_inner(value: &str) -> String {
        let escaped = serde_json::to_string(value).unwrap();
        let inner = escaped
            .strip_prefix('"')
            .and_then(|rest| rest.strip_suffix('"'));
        inner.unwrap().to_string()
    }

    #[test]
    fn plans_only_plaintext_auth_headers() {
        let headers = HashMap::from([
            ("Authorization".to_string(), "Bearer sk-1".to_string()),
            ("X-Tenant".to_string(), "t-1".to_string()),
            ("X-Team".to_string(), "alpha".to_string()),
            (MIGRATED_HEADER.to_string(), own_ref(MIGRATED_HEADER)),
            ("X-API-Key".to_string(), "${secret:Broken".to_string()),
            ("api-key".to_string(), String::new()),
        ]);
        let original = provider_file(&headers, &["x-tenant".to_string()]);
        let plan = plan_migration(Path::new("custom_gateway.json"), &original).unwrap();

        let planned: Vec<&str> = plan.items.iter().map(MigrationItem::header).collect();
        assert_eq!(planned, vec!["Authorization", "X-Tenant"]);
        assert_eq!(plan.provider, DISPLAY_NAME);
        let replaced: Value = serde_json::from_slice(&plan.replacement).unwrap();
        assert_eq!(replaced["headers"]["Authorization"], own_ref("Authorization"));
        assert_eq!(replaced["headers"]["X-Team"], "alpha");
        assert_eq!(replaced["headers"]["X-API-Key"], "${secret:Broken");
        assert_eq!(replaced["unknown_field"], "kept");

        let references_only = HashMap::from([("X-Team".to_string(), "alpha".to_string())]);
        let original = provider_file(&references_only, &[]);
        assert!(plan_migration(Path::new("custom_gateway.json"), &original).is_none());
        assert!(plan_migration(Path::new("notes.json"), b"not json").is_none());
    }

    #[test]
    fn startup_scan_migrates_each_provider_file_on_its_own() {
        let dir = tempfile::tempdir().unwrap();
        let headers = HashMap::from([("Authorization".to_string(), "Bearer sk-1".to_string())]);
        let good = dir.path().join("custom_gateway.json");
        std::fs::write(&good, provider_file(&headers, &[])).unwrap();
        let broken = dir.path().join("broken.json");
        std::fs::write(&broken, b"{").unwrap();
        let notes = dir.path().join("notes.txt");
        std::fs::write(&notes, b"Authorization: Bearer sk-1").unwrap();

        let locked = MemorySecretStore::new();
        locked.set_unavailable(true);
        let failures = migrate_provider_dir(dir.path(), &locked, &StdAtomicFs);
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].stage, MigrationStage::Write);
        assert_eq!(failures[0].owner, MigrationOwner::Provider);
        assert!(failures[0].to_string().contains(DISPLAY_NAME));
        assert!(!failures[0].to_string().contains("sk-1"));
        assert_eq!(std::fs::read(&good).unwrap(), provider_file(&headers, &[]));

        let store = MemorySecretStore::new();
        assert!(migrate_provider_dir(dir.path(), &store, &StdAtomicFs).is_empty());
        let text = std::fs::read_to_string(&good).unwrap();
        assert!(!text.contains("sk-1"));
        assert_eq!(store.entries()[&own_key("Authorization")], "Bearer sk-1");
        assert_eq!(std::fs::read(&broken).unwrap(), b"{");
        assert_eq!(std::fs::read(&notes).unwrap(), b"Authorization: Bearer sk-1");
        assert!(migrate_provider_dir(dir.path(), &store, &StdAtomicFs).is_empty());
    }

    #[test]
    fn failures_are_reported_to_clients_without_values() {
        let failure = MigrationError {
            owner: MigrationOwner::Extension,
            name: "GitHub".to_string(),
            stage: MigrationStage::Verify,
            cause: "header Authorization: the store returned a different value".to_string(),
        };
        let meta = failures_meta(std::slice::from_ref(&failure));
        assert_eq!(meta["failures"][0]["owner"], "extension");
        assert_eq!(meta["failures"][0]["name"], "GitHub");
        assert_eq!(meta["failures"][0]["stage"], "verify");
        assert_eq!(meta["failures"][0]["message"], failure.to_string());
    }

    // Feature: mathmodel-parity-and-beyond, Property 6: 明文迁移原子性
    proptest! {
        #![proptest_config(ProptestConfig::with_cases(100))]

        #[test]
        fn migration_is_atomic(
            headers in header_set(),
            marks in mark_set(),
            with_reference in any::<bool>(),
            failure in failure(),
        ) {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join(format!("{PROVIDER_ID}.json"));
            let store = MemorySecretStore::new();
            let mut all: HashMap<String, String> = headers
                .iter()
                .map(|(name, value)| (name.to_string(), value.clone()))
                .collect();
            let mut in_file = all.clone();
            if with_reference {
                store.set(&own_key(MIGRATED_HEADER), MIGRATED_VALUE).unwrap();
                in_file.insert(MIGRATED_HEADER.to_string(), own_ref(MIGRATED_HEADER));
                all.insert(MIGRATED_HEADER.to_string(), MIGRATED_VALUE.to_string());
            }
            let original = provider_file(&in_file, &marks);
            std::fs::write(&path, &original).unwrap();
            let plaintext: BTreeMap<&str, &String> = headers
                .iter()
                .filter(|(name, _)| is_auth_header(name, is_marked_sensitive(name, &marks)))
                .map(|(name, value)| (*name, value))
                .collect();

            let plan = plan_migration(&path, &original);
            prop_assert_eq!(plan.is_some(), !plaintext.is_empty());
            let Some(plan) = plan else {
                return Ok(());
            };
            let planned: Vec<&str> = plan.items.iter().map(MigrationItem::header).collect();
            let expected: Vec<&str> = plaintext.keys().copied().collect();
            prop_assert_eq!(planned, expected);

            let entries_before = store.entries();
            let expected_stage = inject(&store, failure, plan.items.len());
            let fs: &dyn AtomicFs = match failure {
                Failure::Replace => &FailingFs,
                _ => &StdAtomicFs,
            };
            let result = migrate_one(&plan, &store, fs);

            match (result, expected_stage) {
                (Ok(()), None) => {
                    let text = std::fs::read_to_string(&path).unwrap();
                    for (name, value) in &plaintext {
                        prop_assert!(!text.contains(value.as_str()), "{name} is in the file");
                        prop_assert!(!text.contains(&json_inner(value)), "{name} is in the file");
                    }
                    let saved = deserialize_provider_config(&text).unwrap();
                    let saved_headers = saved.headers.unwrap_or_default();
                    for name in plaintext.keys() {
                        prop_assert_eq!(&saved_headers[*name], &own_ref(name));
                    }
                    prop_assert_eq!(resolve_headers(&saved_headers, &store).unwrap(), all);
                    let raw: Value = serde_json::from_str(&text).unwrap();
                    prop_assert_eq!(raw["unknown_field"].as_str(), Some("kept"));
                    prop_assert!(plan_migration(&path, text.as_bytes()).is_none());
                }
                (Err(error), Some(stage)) => {
                    prop_assert_eq!(error.stage, stage);
                    prop_assert_eq!(error.owner, MigrationOwner::Provider);
                    let message = error.to_string();
                    prop_assert!(message.contains(DISPLAY_NAME), "{message}");
                    for value in plaintext.values() {
                        prop_assert!(!message.contains(value.as_str()), "{message}");
                    }
                    prop_assert_eq!(std::fs::read(&path).unwrap(), original.clone());
                    prop_assert_eq!(store.entries(), entries_before);
                    let files = std::fs::read_dir(dir.path()).unwrap().count();
                    prop_assert_eq!(files, 1);
                    // Nothing records the attempt: the next start plans the same migration.
                    let again = plan_migration(&path, &original).map(|plan| plan.items.len());
                    prop_assert_eq!(again, Some(plan.items.len()));
                }
                (result, stage) => {
                    let outcome = result.map_err(|error| error.to_string());
                    let message = format!("expected a failure at {stage:?}, got {outcome:?}");
                    return Err(TestCaseError::fail(message));
                }
            }
        }
    }
}
