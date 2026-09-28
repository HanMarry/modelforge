//! Saving a custom provider's config file together with the credentials it refers to
//! (requirements 1.2, 1.3, 1.6, 1.7).
//!
//! Auth header values and the API key are kept in the credential store, and the config file
//! only refers to them. A save writes the new credentials first, then replaces the config file
//! atomically, then deletes the credentials the config no longer refers to. When a step fails,
//! the completed steps are undone in reverse order, so the config file keeps its old bytes and
//! the store its old entries.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};

use crate::config::atomic_fs::AtomicFs;
use crate::config::secret_headers::{
    is_auth_header, is_marked_sensitive, looks_like_secret_ref, parse_secret_ref, secret_ref_for,
    SecretOwner, SecretStore, SecretStoreError,
};
use crate::config::DeclarativeProviderConfig;

/// Why saving or removing a custom provider failed. Messages never contain credential values.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProviderSaveError {
    /// A credential could not be written to or deleted from the store (requirement 1.3).
    #[error("CREDENTIAL_WRITE_FAILED: provider {provider}: {cause}")]
    CredentialWrite { provider: String, cause: String },
    /// The config file could not be written or removed.
    #[error("CONFIG_WRITE_FAILED: provider {provider}: {cause}")]
    ConfigWrite { provider: String, cause: String },
    /// A header value cannot be saved as given.
    #[error("INVALID_HEADER: provider {provider}: header {header} {problem}")]
    InvalidHeader {
        provider: String,
        header: String,
        problem: &'static str,
    },
}

impl ProviderSaveError {
    /// Stable code for clients, e.g. `CREDENTIAL_WRITE_FAILED`.
    pub fn code(&self) -> &'static str {
        match self {
            ProviderSaveError::CredentialWrite { .. } => "CREDENTIAL_WRITE_FAILED",
            ProviderSaveError::ConfigWrite { .. } => "CONFIG_WRITE_FAILED",
            ProviderSaveError::InvalidHeader { .. } => "INVALID_HEADER",
        }
    }

    fn note_rollback_problems(&mut self, problems: &[String]) {
        if problems.is_empty() {
            return;
        }
        let note = format!("; rollback incomplete: {}", problems.join("; "));
        match self {
            ProviderSaveError::CredentialWrite { cause, .. } => cause.push_str(&note),
            ProviderSaveError::ConfigWrite { cause, .. } => cause.push_str(&note),
            ProviderSaveError::InvalidHeader { .. } => {}
        }
    }
}

/// What a save does to the provider's config file.
pub enum ConfigChange {
    /// Leave the file alone; providers that are not editable only change their API key.
    Keep,
    /// Replace the file atomically with these bytes, creating it if needed.
    Write(Vec<u8>),
    /// Delete the file.
    Remove,
}

/// One save or removal of a custom provider: credential writes, a change to the config file and
/// credential deletions, applied in that order and undone together on failure.
///
/// Deliberately not `Debug`: it carries credential values.
pub struct ProviderSecretTxn {
    /// Provider name for error messages.
    pub provider: String,
    pub path: PathBuf,
    /// `(key, value)` pairs to store.
    pub writes: Vec<(String, String)>,
    /// Keys to delete once the config file no longer refers to them.
    pub deletes: Vec<String>,
    pub change: ConfigChange,
}

enum Step {
    Secret(String),
    Config,
}

impl ProviderSecretTxn {
    pub fn commit(
        self,
        store: &dyn SecretStore,
        fs: &dyn AtomicFs,
    ) -> Result<(), ProviderSaveError> {
        let before = self.snapshot(store)?;
        let original = match self.change {
            ConfigChange::Keep => None,
            ConfigChange::Write(_) | ConfigChange::Remove => self.read_original()?,
        };
        let mut done = Vec::new();
        if let Err(mut error) = self.apply(store, fs, &mut done) {
            let problems = self.rollback(store, fs, &done, &before, original.as_deref());
            error.note_rollback_problems(&problems);
            return Err(error);
        }
        Ok(())
    }

    /// Current values of every key this transaction touches, to restore on failure.
    fn snapshot(
        &self,
        store: &dyn SecretStore,
    ) -> Result<HashMap<String, Option<String>>, ProviderSaveError> {
        let mut before = HashMap::new();
        let written = self.writes.iter().map(|(key, _)| key);
        for key in written.chain(&self.deletes) {
            if !before.contains_key(key) {
                let value = store.get(key).map_err(|e| self.store_error(e))?;
                before.insert(key.clone(), value);
            }
        }
        Ok(before)
    }

    fn read_original(&self) -> Result<Option<Vec<u8>>, ProviderSaveError> {
        match std::fs::read(&self.path) {
            Ok(contents) => Ok(Some(contents)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(self.file_error(error)),
        }
    }

    fn apply(
        &self,
        store: &dyn SecretStore,
        fs: &dyn AtomicFs,
        done: &mut Vec<Step>,
    ) -> Result<(), ProviderSaveError> {
        for (key, value) in &self.writes {
            // A write that reports failure may still have reached the store: undo it as well.
            done.push(Step::Secret(key.clone()));
            if let Err(error) = store.set(key, value) {
                return Err(self.store_error(error));
            }
        }
        match &self.change {
            ConfigChange::Keep => {}
            ConfigChange::Write(contents) => {
                if let Err(error) = fs.write_atomic(&self.path, contents) {
                    return Err(self.file_error(error));
                }
                done.push(Step::Config);
            }
            ConfigChange::Remove => {
                if let Err(error) = remove_file(&self.path) {
                    return Err(self.file_error(error));
                }
                done.push(Step::Config);
            }
        }
        for key in &self.deletes {
            done.push(Step::Secret(key.clone()));
            if let Err(error) = store.delete(key) {
                return Err(self.store_error(error));
            }
        }
        Ok(())
    }

    /// Undoes the completed steps in reverse order and returns what could not be undone.
    fn rollback(
        &self,
        store: &dyn SecretStore,
        fs: &dyn AtomicFs,
        done: &[Step],
        before: &HashMap<String, Option<String>>,
        original: Option<&[u8]>,
    ) -> Vec<String> {
        let mut problems = Vec::new();
        for step in done.iter().rev() {
            let outcome = match step {
                Step::Secret(key) => restore_secret(store, key, before.get(key)),
                Step::Config => restore_config(fs, &self.path, original),
            };
            if let Err(problem) = outcome {
                problems.push(problem);
            }
        }
        problems
    }

    fn store_error(&self, error: SecretStoreError) -> ProviderSaveError {
        ProviderSaveError::CredentialWrite {
            provider: self.provider.clone(),
            cause: error.to_string(),
        }
    }

    fn file_error(&self, error: io::Error) -> ProviderSaveError {
        ProviderSaveError::ConfigWrite {
            provider: self.provider.clone(),
            cause: error.to_string(),
        }
    }
}

fn remove_file(path: &Path) -> io::Result<()> {
    match std::fs::remove_file(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

fn restore_secret(
    store: &dyn SecretStore,
    key: &str,
    before: Option<&Option<String>>,
) -> Result<(), String> {
    let result = match before {
        Some(Some(value)) => store.set(key, value),
        _ => store.delete(key),
    };
    result.map_err(|error| error.to_string())
}

fn restore_config(fs: &dyn AtomicFs, path: &Path, bytes: Option<&[u8]>) -> Result<(), String> {
    let result = match bytes {
        Some(contents) => fs.write_atomic(path, contents),
        None => remove_file(path),
    };
    result.map_err(|error| error.to_string())
}

/// Credential changes that saving a provider's headers requires.
#[derive(Default)]
pub struct HeaderSecrets {
    /// `(key, value)` pairs to store.
    pub writes: Vec<(String, String)>,
    /// Keys the previous config referred to and the new one no longer does.
    pub deletes: Vec<String>,
}

const DUPLICATE: &str = "appears more than once (header names are case-insensitive)";
const FOREIGN: &str = "refers to the credential of another header or provider";
const MALFORMED: &str = "is a malformed secret reference";

/// Moves the values of the auth headers of `config` into credential writes and puts references
/// in their place (requirement 1.2). A value that already is the header's own reference is kept,
/// so a client can send back what it read without resending the credential. Credentials that
/// `previous` referred to and `config` no longer does are planned for deletion (requirements 1.6,
/// 1.7). Sensitive marks for headers that are not present are dropped.
pub fn plan_header_secrets(
    config: &mut DeclarativeProviderConfig,
    previous: Option<&DeclarativeProviderConfig>,
) -> Result<HeaderSecrets, ProviderSaveError> {
    let id = config.name.clone();
    let owner = SecretOwner::Provider(&id);
    let marks: Vec<String> = std::mem::take(&mut config.sensitive_headers)
        .into_iter()
        .map(|mark| mark.trim().to_string())
        .collect();
    let mut plan = HeaderSecrets::default();
    let mut in_use = HashSet::new();

    if let Some(headers) = config.headers.take() {
        let mut entries: Vec<(String, String)> = headers.into_iter().collect();
        entries.sort_unstable();
        let mut seen = HashSet::new();
        let mut stored = HashMap::with_capacity(entries.len());
        for (name, value) in entries {
            let invalid = |problem| ProviderSaveError::InvalidHeader {
                provider: config.display_name.clone(),
                header: name.clone(),
                problem,
            };
            if !seen.insert(name.to_ascii_lowercase()) {
                return Err(invalid(DUPLICATE));
            }
            let reference = secret_ref_for(owner, &name);
            let marked = is_marked_sensitive(&name, &marks);
            let value = match parse_secret_ref(&value) {
                Some(found) if found == reference => {
                    in_use.insert(found.key().to_string());
                    value
                }
                Some(_) => return Err(invalid(FOREIGN)),
                None if looks_like_secret_ref(&value) => return Err(invalid(MALFORMED)),
                None if is_auth_header(&name, marked) => {
                    in_use.insert(reference.key().to_string());
                    plan.writes.push((reference.key().to_string(), value));
                    reference.to_string()
                }
                None => value,
            };
            stored.insert(name, value);
        }
        config.headers = Some(stored);
    }

    config.sensitive_headers = match &config.headers {
        Some(headers) => retained_marks(marks, headers),
        None => Vec::new(),
    };
    if let Some(previous) = previous {
        plan.deletes = header_secret_keys(previous)
            .into_iter()
            .filter(|key| !in_use.contains(key))
            .collect();
    }
    Ok(plan)
}

/// Keeps one mark per header that is present, compared case-insensitively.
fn retained_marks(marks: Vec<String>, headers: &HashMap<String, String>) -> Vec<String> {
    let names: Vec<String> = headers.keys().cloned().collect();
    let mut kept = Vec::new();
    for mark in marks {
        if is_marked_sensitive(&mark, &names) && !is_marked_sensitive(&mark, &kept) {
            kept.push(mark);
        }
    }
    kept
}

/// Keys of the credentials that the headers of `config` refer to.
pub fn header_secret_keys(config: &DeclarativeProviderConfig) -> BTreeSet<String> {
    let owner = SecretOwner::Provider(&config.name);
    let mut keys = BTreeSet::new();
    for (name, value) in config.headers.iter().flatten() {
        let reference = secret_ref_for(owner, name);
        if parse_secret_ref(value).as_ref() == Some(&reference) {
            keys.insert(reference.key().to_string());
        }
    }
    keys
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::atomic_fs::StdAtomicFs;
    use crate::config::secret_headers::testing::MemorySecretStore;

    struct FailingFs;

    impl AtomicFs for FailingFs {
        fn write_atomic(&self, _target: &Path, _contents: &[u8]) -> io::Result<()> {
            Err(io::Error::other("disk full"))
        }
    }

    fn provider(headers: &[(&str, &str)], marks: &[&str]) -> DeclarativeProviderConfig {
        let headers: HashMap<&str, &str> = headers.iter().copied().collect();
        serde_json::from_value(serde_json::json!({
            "name": "custom_gw",
            "engine": "openai",
            "display_name": "Gateway",
            "base_url": "https://gw.example.invalid/v1",
            "models": [],
            "headers": headers,
            "sensitive_headers": marks,
        }))
        .unwrap()
    }

    fn pairs(items: &[(&str, &str)]) -> Vec<(String, String)> {
        items
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    fn own_ref(header: &str) -> String {
        secret_ref_for(SecretOwner::Provider("custom_gw"), header).to_string()
    }

    #[test]
    fn auth_values_move_into_writes_and_own_references_stay() {
        let headers = [
            ("Authorization", "Bearer sk-1"),
            ("X-Tenant", "t-1"),
            ("X-Team", "alpha"),
        ];
        let mut config = provider(&headers, &[" x-tenant", "X-Gone"]);

        let plan = plan_header_secrets(&mut config, None).unwrap();
        let saved = config.headers.clone().unwrap();
        assert_eq!(saved["Authorization"], own_ref("Authorization"));
        assert_eq!(saved["X-Tenant"], own_ref("X-Tenant"));
        assert_eq!(saved["X-Team"], "alpha");
        assert_eq!(config.sensitive_headers, vec!["x-tenant".to_string()]);
        let written: HashMap<String, String> = plan.writes.into_iter().collect();
        assert_eq!(written.len(), 2);
        assert!(written.values().any(|value| value == "Bearer sk-1"));
        assert!(plan.deletes.is_empty());

        // Saving what was read keeps the references and touches no credential.
        let previous = config.clone();
        let again = plan_header_secrets(&mut config, Some(&previous)).unwrap();
        assert!(again.writes.is_empty() && again.deletes.is_empty());
        assert_eq!(config.headers, previous.headers);
    }

    #[test]
    fn references_no_longer_used_are_planned_for_deletion() {
        let mut old = provider(&[("Authorization", "a"), ("X-Tenant", "t")], &["X-Tenant"]);
        plan_header_secrets(&mut old, None).unwrap();
        let mut next = provider(&[("X-Tenant", "t2")], &[]);

        let plan = plan_header_secrets(&mut next, Some(&old)).unwrap();
        let deletes: BTreeSet<String> = plan.deletes.into_iter().collect();
        let expected: BTreeSet<String> = header_secret_keys(&old);
        assert_eq!(deletes, expected);
        assert_eq!(deletes.len(), 2);
        assert!(plan.writes.is_empty());
        assert_eq!(next.headers.unwrap()["X-Tenant"], "t2");
    }

    fn rejected(headers: &[(&str, &str)]) -> ProviderSaveError {
        let mut config = provider(headers, &[]);
        plan_header_secrets(&mut config, None).err().unwrap()
    }

    #[test]
    fn values_that_cannot_be_saved_are_rejected() {
        let other = secret_ref_for(SecretOwner::Provider("custom_other"), "Authorization");
        let other = other.to_string();
        let cases = [
            (rejected(&[("X-Key", "a"), ("x-key", "b")]), DUPLICATE),
            (rejected(&[("Authorization", other.as_str())]), FOREIGN),
            (rejected(&[("X-Team", "${secret:Nope}")]), MALFORMED),
        ];
        for (error, problem) in cases {
            assert_eq!(error.code(), "INVALID_HEADER");
            assert!(error.to_string().contains(problem), "{error}");
            assert!(error.to_string().contains("Gateway"), "{error}");
        }
    }

    #[test]
    fn failed_config_write_restores_the_store() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("custom_gw.json");
        std::fs::write(&path, b"old").unwrap();
        let store = MemorySecretStore::with_entries([("kept", "old value")]);
        let txn = ProviderSecretTxn {
            provider: "Gateway".to_string(),
            path: path.clone(),
            writes: pairs(&[("kept", "new value"), ("added", "v")]),
            deletes: Vec::new(),
            change: ConfigChange::Write(b"new".to_vec()),
        };

        let error = txn.commit(&store, &FailingFs).unwrap_err();
        assert_eq!(error.code(), "CONFIG_WRITE_FAILED");
        assert!(error.to_string().contains("Gateway"), "{error}");
        assert_eq!(std::fs::read(&path).unwrap(), b"old");
        let entries = store.entries();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries["kept"], "old value");
    }

    #[test]
    fn failed_delete_restores_the_config_and_the_deleted_entries() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("custom_gw.json");
        std::fs::write(&path, b"old").unwrap();
        let store = MemorySecretStore::with_entries([("stale", "s"), ("kept", "k")]);
        // Calls: three reads for the snapshot, the write, then the deletes; the second fails.
        store.fail_on_call(6);
        let txn = ProviderSecretTxn {
            provider: "Gateway".to_string(),
            path: path.clone(),
            writes: pairs(&[("new", "n")]),
            deletes: vec!["stale".to_string(), "kept".to_string()],
            change: ConfigChange::Write(b"new".to_vec()),
        };

        let error = txn.commit(&store, &StdAtomicFs).unwrap_err();
        assert_eq!(error.code(), "CREDENTIAL_WRITE_FAILED");
        assert_eq!(std::fs::read(&path).unwrap(), b"old");
        let entries = store.entries();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries["stale"], "s");
        assert_eq!(entries["kept"], "k");
    }

    #[test]
    fn failed_removal_puts_the_config_file_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("custom_gw.json");
        std::fs::write(&path, b"old").unwrap();
        let store = MemorySecretStore::with_entries([("header", "h")]);
        // Call 1 reads the entry for the snapshot, call 2 deletes it.
        store.fail_on_call(2);
        let txn = ProviderSecretTxn {
            provider: "Gateway".to_string(),
            path: path.clone(),
            writes: Vec::new(),
            deletes: vec!["header".to_string()],
            change: ConfigChange::Remove,
        };

        let error = txn.commit(&store, &StdAtomicFs).unwrap_err();
        assert_eq!(error.code(), "CREDENTIAL_WRITE_FAILED");
        assert_eq!(std::fs::read(&path).unwrap(), b"old");
        assert_eq!(store.entries()["header"], "h");
    }

    #[test]
    fn a_store_that_cannot_be_read_stops_the_save_before_any_change() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("custom_gw.json");
        let store = MemorySecretStore::new();
        store.set_unavailable(true);
        let txn = ProviderSecretTxn {
            provider: "Gateway".to_string(),
            path: path.clone(),
            writes: pairs(&[("new", "n")]),
            deletes: Vec::new(),
            change: ConfigChange::Write(b"new".to_vec()),
        };

        let error = txn.commit(&store, &StdAtomicFs).unwrap_err();
        assert_eq!(error.code(), "CREDENTIAL_WRITE_FAILED");
        assert!(!path.exists());
        assert!(!error.to_string().contains("rollback"), "{error}");
    }
}
