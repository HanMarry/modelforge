//! Auth headers of MCP extensions (requirement 1.11): the rules of custom providers applied to
//! the `headers` of `streamable_http` extensions.
//!
//! - Classification: a well-known auth header name, or a header the user marked as sensitive.
//!   ACP clients mark a header by listing its name in `env_keys`, as the desktop connector
//!   catalogue already does, and the CLI asks for each header. Names that look like credentials
//!   (`crate::utils::is_sensitive_header_name`) count as marked, as they did before secret
//!   references existed.
//! - Storage: the value goes to the credential store under the key derived from
//!   [`SecretOwner::Extension`] and the extension name, and the header holds `${secret:<key>}`.
//! - Resolution: right before the extension connects. A reference that cannot be resolved, or
//!   that belongs to another header or config, stops the connection.
//! - Saving and removing an extension write and delete its credentials in the same operation and
//!   roll back together.
//! - Plaintext values left in `config.yaml` are migrated at startup, see
//!   [`crate::config::credential_migration`].
//!
//! Older configs stay readable: a header such as `Bearer ${TOKEN}` with `TOKEN` in `env_keys`,
//! including the `MODELFORGE_MCP_HEADER_*` keys of the earlier fix, is resolved from `env_keys`
//! as before.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::OnceLock;

use indexmap::IndexMap;
use regex::Regex;

use crate::agents::extension_manager::substitute_env_vars;
use crate::agents::ExtensionConfig;
use crate::config::credential_migration::{
    is_plaintext, migrate_items, MigrationError, MigrationItem, MigrationOwner,
};
use crate::config::extensions::{get_extensions_map_with_config, ExtensionEntry};
use crate::config::extensions::{try_remove_extension_with_config, try_set_extension_with_config};
use crate::config::provider_credentials::restore_secret;
use crate::config::secret_headers::{
    is_auth_header, is_marked_sensitive, looks_like_secret_ref, parse_secret_ref, secret_ref_for,
    ConfigSecretStore, SecretOwner, SecretStore, SecretStoreError, UnresolvedReason,
};
use crate::config::Config;

/// Prefix of the keys the earlier fix stored header values under. They are listed in `env_keys`
/// and referred to as `${KEY}`.
pub const LEGACY_HEADER_KEY_PREFIX: &str = "MODELFORGE_MCP_HEADER_";

const DUPLICATE: &str = "appears more than once (header names are case-insensitive)";
const FOREIGN: &str = "refers to the credential of another header or config";
const MALFORMED: &str = "is a malformed secret reference";

/// Whether an extension header carries a credential: an auth header name, a header named in
/// `marks`, or a name that looks like a credential.
pub fn is_sensitive_extension_header(name: &str, marks: &[String]) -> bool {
    let marked = is_marked_sensitive(name, marks) || crate::utils::is_sensitive_header_name(name);
    is_auth_header(name, marked)
}

fn variable_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"\$\{[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*\}|\$([A-Za-z_][A-Za-z0-9_]*)")
            .expect("valid variable pattern")
    })
}

/// Whether `value` refers to one of `names` as `$NAME` or `${NAME}`, so that the credential
/// comes from `env_keys` or `envs` rather than from the value itself.
fn refers_to_variable(value: &str, names: &[String]) -> bool {
    variable_pattern().captures_iter(value).any(|capture| {
        let name = capture.get(1).or_else(|| capture.get(2));
        name.is_some_and(|name| names.iter().any(|known| known == name.as_str()))
    })
}

/// A header value to store, planned by [`plan_extension_header_secrets`].
///
/// Deliberately not `Debug`: it carries the value.
pub struct HeaderSecret {
    pub header: String,
    pub key: String,
    pub value: String,
}

/// Why saving or removing an MCP extension failed. Messages never contain credential values.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ExtensionSaveError {
    /// A credential could not be written to or deleted from the store (requirement 1.3).
    #[error("CREDENTIAL_WRITE_FAILED: extension {extension}: {cause}")]
    CredentialWrite { extension: String, cause: String },
    /// The extension entry could not be written to or removed from the config.
    #[error("CONFIG_WRITE_FAILED: extension {extension}: {cause}")]
    ConfigWrite { extension: String, cause: String },
    /// A header value cannot be saved as given.
    #[error("INVALID_HEADER: extension {extension}: header {header} {problem}")]
    InvalidHeader {
        extension: String,
        header: String,
        problem: &'static str,
    },
}

impl ExtensionSaveError {
    /// Stable code for clients, the same as for custom providers.
    pub fn code(&self) -> &'static str {
        match self {
            ExtensionSaveError::CredentialWrite { .. } => "CREDENTIAL_WRITE_FAILED",
            ExtensionSaveError::ConfigWrite { .. } => "CONFIG_WRITE_FAILED",
            ExtensionSaveError::InvalidHeader { .. } => "INVALID_HEADER",
        }
    }

    fn note_rollback_problems(&mut self, problems: &[String]) {
        if problems.is_empty() {
            return;
        }
        let note = format!("; rollback incomplete: {}", problems.join("; "));
        match self {
            ExtensionSaveError::CredentialWrite { cause, .. } => cause.push_str(&note),
            ExtensionSaveError::ConfigWrite { cause, .. } => cause.push_str(&note),
            ExtensionSaveError::InvalidHeader { .. } => {}
        }
    }
}

/// Moves the plaintext values of the sensitive headers of a `streamable_http` extension into
/// credential writes and puts the extension's own references in their place (requirement 1.2
/// via 1.11). `marks` are the header names the user marked as sensitive; `env_keys` entries that
/// name a header count as marks too and are dropped once the header refers to the store. A value
/// that already is the header's own reference is kept, so a client can send back what it read.
/// Values that refer to `env_keys` or `envs`, like the ones of the earlier fix, are kept as well.
/// Other extension types have no headers and are left alone.
pub fn plan_extension_header_secrets(
    config: &mut ExtensionConfig,
    marks: &[String],
) -> Result<Vec<HeaderSecret>, ExtensionSaveError> {
    let ExtensionConfig::StreamableHttp {
        name,
        envs,
        env_keys,
        headers,
        ..
    } = config
    else {
        return Ok(Vec::new());
    };
    let extension = name.clone();
    let owner = SecretOwner::Extension(&extension);
    let mut all_marks = marks.to_vec();
    all_marks.extend(env_keys.iter().cloned());
    let mut variables = env_keys.clone();
    variables.extend(envs.get_env().into_keys());

    let mut entries: Vec<(String, String)> = headers.iter().map(clone_pair).collect();
    entries.sort_unstable();
    let mut seen = HashSet::new();
    let mut stored = HashSet::new();
    let mut kept = HashMap::with_capacity(entries.len());
    let mut secrets = Vec::new();
    for (header, value) in entries {
        let lower = header.to_ascii_lowercase();
        let invalid = |problem| ExtensionSaveError::InvalidHeader {
            extension: extension.clone(),
            header: header.clone(),
            problem,
        };
        if !seen.insert(lower.clone()) {
            return Err(invalid(DUPLICATE));
        }
        let reference = secret_ref_for(owner, &header);
        let value = match parse_secret_ref(&value) {
            Some(found) if found == reference => {
                stored.insert(lower);
                value
            }
            Some(_) => return Err(invalid(FOREIGN)),
            None if looks_like_secret_ref(&value) => return Err(invalid(MALFORMED)),
            None if !is_plaintext(&value) || refers_to_variable(&value, &variables) => value,
            None if is_sensitive_extension_header(&header, &all_marks) => {
                stored.insert(lower);
                secrets.push(HeaderSecret {
                    header: header.clone(),
                    key: reference.key().to_string(),
                    value,
                });
                reference.to_string()
            }
            None => value,
        };
        kept.insert(header, value);
    }
    *headers = kept;
    env_keys.retain(|key| !stored.contains(&key.to_ascii_lowercase()));
    Ok(secrets)
}

fn clone_pair((name, value): (&String, &String)) -> (String, String) {
    (name.clone(), value.clone())
}

/// Credentials that `config` owns: the entries its headers refer to with their own references,
/// and the `MODELFORGE_MCP_HEADER_*` keys of the earlier fix listed in its `env_keys`.
pub fn extension_secret_keys(config: &ExtensionConfig) -> BTreeSet<String> {
    let mut keys = BTreeSet::new();
    let ExtensionConfig::StreamableHttp {
        name,
        env_keys,
        headers,
        ..
    } = config
    else {
        return keys;
    };
    let owner = SecretOwner::Extension(name);
    for (header, value) in headers {
        let reference = secret_ref_for(owner, header);
        if parse_secret_ref(value).as_ref() == Some(&reference) {
            keys.insert(reference.key().to_string());
        }
    }
    let legacy = env_keys
        .iter()
        .filter(|key| key.starts_with(LEGACY_HEADER_KEY_PREFIX));
    keys.extend(legacy.cloned());
    keys
}

/// Keys that extensions other than `except` refer to, so removing `except` must keep them.
fn keys_used_by_others(
    entries: &IndexMap<String, ExtensionEntry>,
    except: &str,
) -> HashSet<String> {
    let mut keys = HashSet::new();
    for (key, entry) in entries {
        if key == except {
            continue;
        }
        keys.extend(extension_secret_keys(&entry.config));
        match &entry.config {
            ExtensionConfig::StreamableHttp { env_keys, .. }
            | ExtensionConfig::Stdio { env_keys, .. } => keys.extend(env_keys.iter().cloned()),
            ExtensionConfig::Builtin { .. } | ExtensionConfig::Platform { .. } => {}
        }
    }
    keys
}

/// Where extension entries are kept: `config.yaml` in production; tests inject failures.
pub(crate) trait ExtensionEntries {
    fn extension_entries(&self) -> IndexMap<String, ExtensionEntry>;
    fn upsert_extension(&self, entry: ExtensionEntry) -> anyhow::Result<()>;
    fn remove_extension_entry(&self, key: &str) -> anyhow::Result<()>;
}

impl ExtensionEntries for Config {
    fn extension_entries(&self) -> IndexMap<String, ExtensionEntry> {
        get_extensions_map_with_config(self)
    }

    fn upsert_extension(&self, entry: ExtensionEntry) -> anyhow::Result<()> {
        try_set_extension_with_config(self, entry)
    }

    fn remove_extension_entry(&self, key: &str) -> anyhow::Result<()> {
        try_remove_extension_with_config(self, key)
    }
}

enum EntryChange {
    Upsert(Box<ExtensionEntry>),
    Remove,
}

enum Step {
    Secret(String),
    Entry,
}

/// One save or removal of an extension entry: credential writes, the change to the entry and
/// credential deletions, applied in that order and undone together on failure.
///
/// Deliberately not `Debug`: it carries credential values.
struct ExtensionSecretTxn {
    /// Extension name for error messages.
    extension: String,
    key: String,
    previous: Option<ExtensionEntry>,
    writes: Vec<(String, String)>,
    deletes: Vec<String>,
    change: EntryChange,
}

impl ExtensionSecretTxn {
    fn commit(
        self,
        entries: &dyn ExtensionEntries,
        store: &dyn SecretStore,
    ) -> Result<(), ExtensionSaveError> {
        let before = self.snapshot(store)?;
        let mut done = Vec::new();
        if let Err(mut error) = self.apply(entries, store, &mut done) {
            let problems = self.rollback(entries, store, &done, &before);
            error.note_rollback_problems(&problems);
            return Err(error);
        }
        Ok(())
    }

    /// Current values of every key this transaction touches, to restore on failure.
    fn snapshot(
        &self,
        store: &dyn SecretStore,
    ) -> Result<HashMap<String, Option<String>>, ExtensionSaveError> {
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

    fn apply(
        &self,
        entries: &dyn ExtensionEntries,
        store: &dyn SecretStore,
        done: &mut Vec<Step>,
    ) -> Result<(), ExtensionSaveError> {
        for (key, value) in &self.writes {
            // A write that reports failure may still have reached the store: undo it as well.
            done.push(Step::Secret(key.clone()));
            store.set(key, value).map_err(|e| self.store_error(e))?;
        }
        let outcome = match &self.change {
            EntryChange::Upsert(entry) => entries.upsert_extension(ExtensionEntry::clone(entry)),
            EntryChange::Remove => entries.remove_extension_entry(&self.key),
        };
        outcome.map_err(|e| self.config_error(e))?;
        done.push(Step::Entry);
        for key in &self.deletes {
            done.push(Step::Secret(key.clone()));
            store.delete(key).map_err(|e| self.store_error(e))?;
        }
        Ok(())
    }

    /// Undoes the completed steps in reverse order and returns what could not be undone.
    fn rollback(
        &self,
        entries: &dyn ExtensionEntries,
        store: &dyn SecretStore,
        done: &[Step],
        before: &HashMap<String, Option<String>>,
    ) -> Vec<String> {
        let mut problems = Vec::new();
        for step in done.iter().rev() {
            let outcome = match step {
                Step::Secret(key) => restore_secret(store, key, before.get(key)),
                Step::Entry => self.restore_entry(entries),
            };
            if let Err(problem) = outcome {
                problems.push(problem);
            }
        }
        problems
    }

    fn restore_entry(&self, entries: &dyn ExtensionEntries) -> Result<(), String> {
        let result = match &self.previous {
            Some(entry) => entries.upsert_extension(entry.clone()),
            None => entries.remove_extension_entry(&self.key),
        };
        result.map_err(|error| error.to_string())
    }

    fn store_error(&self, error: SecretStoreError) -> ExtensionSaveError {
        ExtensionSaveError::CredentialWrite {
            extension: self.extension.clone(),
            cause: error.to_string(),
        }
    }

    fn config_error(&self, error: anyhow::Error) -> ExtensionSaveError {
        ExtensionSaveError::ConfigWrite {
            extension: self.extension.clone(),
            cause: error.to_string(),
        }
    }
}

/// Saves an MCP extension together with the credentials its headers refer to (requirements 1.2,
/// 1.3 and 1.6 via 1.11). `marks` are the header names the user marked as sensitive. Credentials
/// of the previous version of the entry that nothing refers to any more are deleted in the same
/// operation; if a step fails, the config and the store stay as they were.
pub fn save_extension(entry: ExtensionEntry, marks: &[String]) -> Result<(), ExtensionSaveError> {
    let store = ConfigSecretStore::global();
    save_extension_in(Config::global(), &store, entry, marks, Vec::new())
}

/// [`save_extension`] with `writes` stored in the same transaction, such as the values of stdio
/// environment variables an ACP client sent inline.
pub(crate) fn save_extension_in(
    entries: &dyn ExtensionEntries,
    store: &dyn SecretStore,
    mut entry: ExtensionEntry,
    marks: &[String],
    mut writes: Vec<(String, String)>,
) -> Result<(), ExtensionSaveError> {
    for secret in plan_extension_header_secrets(&mut entry.config, marks)? {
        writes.push((secret.key, secret.value));
    }
    let key = entry.config.key();
    let all = entries.extension_entries();
    let previous = all.get(&key).cloned();
    let in_use = extension_secret_keys(&entry.config);
    let others = keys_used_by_others(&all, &key);
    let deletes = previous
        .iter()
        .flat_map(|old_entry| extension_secret_keys(&old_entry.config))
        .filter(|old| !in_use.contains(old) && !others.contains(old))
        .collect();
    let txn = ExtensionSecretTxn {
        extension: entry.config.name(),
        key,
        previous,
        writes,
        deletes,
        change: EntryChange::Upsert(Box::new(entry)),
    };
    txn.commit(entries, store)
}

/// Removes an MCP extension together with the credentials only it refers to (requirement 1.7
/// via 1.11). If a credential cannot be deleted, the entry is put back.
pub fn remove_extension_and_secrets(key: &str) -> Result<(), ExtensionSaveError> {
    let store = ConfigSecretStore::global();
    remove_extension_in(Config::global(), &store, key)
}

pub(crate) fn remove_extension_in(
    entries: &dyn ExtensionEntries,
    store: &dyn SecretStore,
    key: &str,
) -> Result<(), ExtensionSaveError> {
    let all = entries.extension_entries();
    let Some(previous) = all.get(key).cloned() else {
        // Not a readable entry, so it refers to no credential we know of; remove it as before.
        return entries.remove_extension_entry(key).map_err(|error| {
            ExtensionSaveError::ConfigWrite {
                extension: key.to_string(),
                cause: error.to_string(),
            }
        });
    };
    let others = keys_used_by_others(&all, key);
    let deletes = extension_secret_keys(&previous.config)
        .into_iter()
        .filter(|old| !others.contains(old))
        .collect();
    let txn = ExtensionSecretTxn {
        extension: previous.config.name(),
        key: key.to_string(),
        previous: Some(previous),
        writes: Vec::new(),
        deletes,
        change: EntryChange::Remove,
    };
    txn.commit(entries, store)
}

/// A header of an MCP extension that cannot be sent (requirement 1.5 via 1.11). The extension
/// must not connect.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("extension {extension}: header {header}: {reason}")]
pub struct UnresolvedExtensionHeader {
    pub extension: String,
    pub header: String,
    pub reason: String,
}

/// Resolves the headers of an extension right before it connects: its own secret references
/// from the store, and `$VAR` placeholders from `variables` (its `envs` and `env_keys`) as
/// before. Fails on the first header, in name order, whose reference cannot be resolved or
/// belongs to another header or config, and then returns no headers at all.
pub fn resolve_extension_headers(
    extension: &str,
    headers: HashMap<String, String>,
    variables: &HashMap<String, String>,
    store: &dyn SecretStore,
) -> Result<HashMap<String, String>, UnresolvedExtensionHeader> {
    let owner = SecretOwner::Extension(extension);
    let mut entries: Vec<(String, String)> = headers.into_iter().collect();
    entries.sort_unstable();
    let mut resolved = HashMap::with_capacity(entries.len());
    for (header, value) in entries {
        if !looks_like_secret_ref(&value) {
            let value = substitute_env_vars(&value, variables);
            resolved.insert(header, value);
            continue;
        }
        let own = secret_ref_for(owner, &header);
        let reason = match parse_secret_ref(&value) {
            Some(found) if found == own => match store.get(own.key()) {
                Ok(Some(secret)) if !secret.is_empty() => {
                    resolved.insert(header, secret);
                    continue;
                }
                Ok(_) => UnresolvedReason::Missing.to_string(),
                Err(error) => error.to_string(),
            },
            Some(_) => FOREIGN.to_string(),
            None => UnresolvedReason::Malformed.to_string(),
        };
        return Err(UnresolvedExtensionHeader {
            extension: extension.to_string(),
            header,
            reason,
        });
    }
    Ok(resolved)
}

/// Migrates the plaintext sensitive headers of every MCP extension entry, one entry at a time
/// (requirements 1.8, 1.9 via 1.11). The replace step rewrites the entry in `config.yaml`, which
/// is saved atomically, so a failed replace leaves the file as it was.
pub(crate) fn migrate_extensions(
    entries: &dyn ExtensionEntries,
    store: &dyn SecretStore,
) -> Vec<MigrationError> {
    let mut failures = Vec::new();
    for entry in entries.extension_entries().into_values() {
        let mut migrated = entry.clone();
        let Ok(secrets) = plan_extension_header_secrets(&mut migrated.config, &[]) else {
            // Saving would reject this entry too; resolution reports it when it connects.
            continue;
        };
        if secrets.is_empty() {
            continue;
        }
        let items: Vec<MigrationItem> = secrets
            .iter()
            .map(|secret| MigrationItem::new(&secret.header, &secret.key, &secret.value))
            .collect();
        let name = entry.config.name();
        let replace = || {
            entries
                .upsert_extension(migrated)
                .map_err(|error| error.to_string())
        };
        if let Err(error) = migrate_items(MigrationOwner::Extension, &name, &items, store, replace)
        {
            failures.push(error);
            continue;
        }
        let headers = items.len();
        tracing::info!(extension = %name, headers, "moved plaintext headers to the store");
    }
    failures
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::extension::Envs;
    use crate::config::credential_migration::MigrationStage;
    use crate::config::secret_headers::testing::MemorySecretStore;
    use std::cell::Cell;

    const NAME: &str = "GitHub MCP";

    fn http(headers: &[(&str, &str)], env_keys: &[&str]) -> ExtensionConfig {
        ExtensionConfig::StreamableHttp {
            name: NAME.to_string(),
            description: String::new(),
            uri: "https://mcp.example.invalid/mcp".to_string(),
            envs: Envs::default(),
            env_keys: env_keys.iter().map(|key| key.to_string()).collect(),
            headers: headers
                .iter()
                .map(|(name, value)| (name.to_string(), value.to_string()))
                .collect(),
            timeout: None,
            socket: None,
            client_id: None,
            client_secret_key: None,
            scopes: Vec::new(),
            bundled: None,
            available_tools: Vec::new(),
        }
    }

    fn entry(config: ExtensionConfig) -> ExtensionEntry {
        ExtensionEntry {
            enabled: true,
            config,
        }
    }

    fn own_ref(header: &str) -> String {
        secret_ref_for(SecretOwner::Extension(NAME), header).to_string()
    }

    fn own_key(header: &str) -> String {
        let reference = secret_ref_for(SecretOwner::Extension(NAME), header);
        reference.key().to_string()
    }

    fn headers_of(config: &ExtensionConfig) -> HashMap<String, String> {
        match config {
            ExtensionConfig::StreamableHttp { headers, .. } => headers.clone(),
            other => panic!("expected streamable_http, got {other:?}"),
        }
    }

    fn env_keys_of(config: &ExtensionConfig) -> Vec<String> {
        match config {
            ExtensionConfig::StreamableHttp { env_keys, .. } => env_keys.clone(),
            other => panic!("expected streamable_http, got {other:?}"),
        }
    }

    /// `config.yaml` in a temporary directory, with an optional failing write.
    struct TestEntries {
        config: Config,
        fail_writes: Cell<bool>,
        _dir: tempfile::TempDir,
    }

    impl TestEntries {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let config = Config::new_with_file_secrets(
                dir.path().join("config.yaml"),
                dir.path().join("secrets.yaml"),
            )
            .unwrap();
            Self {
                config,
                fail_writes: Cell::new(false),
                _dir: dir,
            }
        }

        fn config_bytes(&self) -> Vec<u8> {
            std::fs::read(self.config.path()).unwrap_or_default()
        }

        fn get(&self, key: &str) -> Option<ExtensionConfig> {
            let entries = self.extension_entries();
            entries.get(key).map(|entry| entry.config.clone())
        }
    }

    impl ExtensionEntries for TestEntries {
        fn extension_entries(&self) -> IndexMap<String, ExtensionEntry> {
            self.config.extension_entries()
        }

        fn upsert_extension(&self, entry: ExtensionEntry) -> anyhow::Result<()> {
            if self.fail_writes.get() {
                anyhow::bail!("config is read-only");
            }
            self.config.upsert_extension(entry)
        }

        fn remove_extension_entry(&self, key: &str) -> anyhow::Result<()> {
            if self.fail_writes.get() {
                anyhow::bail!("config is read-only");
            }
            self.config.remove_extension_entry(key)
        }
    }

    fn marks(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| name.to_string()).collect()
    }

    #[test]
    fn sensitive_headers_move_into_the_store() {
        let mut config = http(
            &[
                ("Authorization", "Bearer ghp-1"),
                ("X-Tenant", "t-1"),
                ("X-Marked", "m-1"),
                ("X-Auth-Token", "a-1"),
                ("Accept", "application/json"),
                ("X-Legacy", "Bearer ${LEGACY_TOKEN}"),
            ],
            &["X-Marked", "LEGACY_TOKEN"],
        );

        let secrets = plan_extension_header_secrets(&mut config, &marks(&["x-tenant"])).unwrap();
        let planned: Vec<&str> = secrets.iter().map(|s| s.header.as_str()).collect();
        assert_eq!(
            planned,
            vec!["Authorization", "X-Auth-Token", "X-Marked", "X-Tenant"]
        );
        let headers = headers_of(&config);
        for header in planned {
            assert_eq!(headers[header], own_ref(header));
        }
        assert_eq!(headers["Accept"], "application/json");
        assert_eq!(headers["X-Legacy"], "Bearer ${LEGACY_TOKEN}");
        assert_eq!(env_keys_of(&config), vec!["LEGACY_TOKEN".to_string()]);
        let serialized = serde_json::to_string(&config).unwrap();
        for value in ["ghp-1", "t-1", "m-1", "a-1"] {
            assert!(!serialized.contains(value), "{value}");
        }

        // Sending back what was read changes nothing.
        let again = plan_extension_header_secrets(&mut config, &[]).unwrap();
        assert!(again.is_empty());
        assert_eq!(headers_of(&config), headers);
    }

    #[test]
    fn header_values_that_cannot_be_saved_are_rejected() {
        let other = secret_ref_for(SecretOwner::Extension("other"), "Authorization").to_string();
        let provider = secret_ref_for(SecretOwner::Provider(NAME), "Authorization").to_string();
        let cases = [
            (vec![("X-Key", "a"), ("x-key", "b")], DUPLICATE),
            (vec![("Authorization", other.as_str())], FOREIGN),
            (vec![("Authorization", provider.as_str())], FOREIGN),
            (vec![("X-Team", "${secret:Nope}")], MALFORMED),
        ];
        for (headers, problem) in cases {
            let mut config = http(&headers, &[]);
            let error = plan_extension_header_secrets(&mut config, &[])
                .err()
                .unwrap();
            assert_eq!(error.code(), "INVALID_HEADER");
            assert!(error.to_string().contains(problem), "{error}");
            assert!(error.to_string().contains(NAME), "{error}");
        }
    }

    fn name_key() -> String {
        crate::config::extensions::name_to_key(NAME)
    }

    const FIRST: [(&str, &str); 2] = [("Authorization", "Bearer 1"), ("X-Api-Key", "k-1")];

    #[test]
    fn saving_and_removing_keep_the_store_in_step() {
        let entries = TestEntries::new();
        let store = MemorySecretStore::new();
        let first = entry(http(&FIRST, &[]));
        save_extension_in(&entries, &store, first, &[], Vec::new()).unwrap();
        let saved = headers_of(&entries.get(&name_key()).unwrap());
        let variables = HashMap::new();
        let resolved = resolve_extension_headers(NAME, saved, &variables, &store).unwrap();
        assert_eq!(resolved["Authorization"], "Bearer 1");
        assert_eq!(resolved["X-Api-Key"], "k-1");
        let text = String::from_utf8(entries.config_bytes()).unwrap();
        assert!(!text.contains("k-1"));

        // Edit: a new Authorization value, X-Api-Key dropped.
        let edited = http(&[("Authorization", "Bearer 2")], &[]);
        save_extension_in(&entries, &store, entry(edited), &[], Vec::new()).unwrap();
        let stored = store.entries();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[&own_key("Authorization")], "Bearer 2");

        remove_extension_in(&entries, &store, &name_key()).unwrap();
        assert!(entries.get(&name_key()).is_none());
        assert!(store.entries().is_empty());
    }

    #[test]
    fn failed_steps_leave_the_config_and_the_store_unchanged() {
        let entries = TestEntries::new();
        let store = MemorySecretStore::new();
        let first = entry(http(&FIRST, &[]));
        save_extension_in(&entries, &store, first, &[], Vec::new()).unwrap();
        let saved_before = entries.get(&name_key());
        let store_before = store.entries();

        // Calls of an edit that keeps Authorization and drops X-Api-Key: two snapshot reads,
        // the write of the new Authorization value, then the deletion of the X-Api-Key entry.
        for failing_call in [3, 4] {
            store.fail_on_call(store.calls() + failing_call);
            let edited = http(&[("Authorization", "Bearer 2")], &[]);
            let error = save_extension_in(&entries, &store, entry(edited), &[], Vec::new());
            let error = error.unwrap_err();
            assert_eq!(error.code(), "CREDENTIAL_WRITE_FAILED");
            assert!(error.to_string().contains(NAME), "{error}");
            assert_eq!(entries.get(&name_key()), saved_before);
            assert_eq!(store.entries(), store_before);
        }

        entries.fail_writes.set(true);
        let edited = http(&[("Authorization", "Bearer 3")], &[]);
        let error = save_extension_in(&entries, &store, entry(edited), &[], Vec::new());
        assert_eq!(error.unwrap_err().code(), "CONFIG_WRITE_FAILED");
        assert_eq!(entries.get(&name_key()), saved_before);
        assert_eq!(store.entries(), store_before);
        let error = remove_extension_in(&entries, &store, &name_key()).unwrap_err();
        assert_eq!(error.code(), "CONFIG_WRITE_FAILED");
        assert_eq!(entries.get(&name_key()), saved_before);
        assert_eq!(store.entries(), store_before);
    }

    #[test]
    fn credentials_shared_with_other_extensions_are_kept() {
        let entries = TestEntries::new();
        let legacy_key = "MODELFORGE_MCP_HEADER_AUTHORIZATION";
        let store = MemorySecretStore::with_entries([(legacy_key, "Bearer shared")]);
        let value = format!("${{{legacy_key}}}");
        let legacy = http(&[("Authorization", value.as_str())], &[legacy_key]);
        entries
            .config
            .upsert_extension(entry(legacy.clone()))
            .unwrap();
        let mut copy = legacy;
        if let ExtensionConfig::StreamableHttp { name, .. } = &mut copy {
            name.push_str(" copy");
        }
        let copy_key = copy.key();
        entries.config.upsert_extension(entry(copy)).unwrap();

        remove_extension_in(&entries, &store, &name_key()).unwrap();
        assert!(entries.get(&name_key()).is_none());
        assert_eq!(store.entries().len(), 1);

        remove_extension_in(&entries, &store, &copy_key).unwrap();
        assert!(store.entries().is_empty());
    }

    #[test]
    fn unresolvable_references_stop_the_connection() {
        let store = MemorySecretStore::with_entries([(own_key("Authorization"), "Bearer 1")]);
        let variables = HashMap::from([("TEAM".to_string(), "alpha".to_string())]);
        let headers = HashMap::from([
            ("Authorization".to_string(), own_ref("Authorization")),
            ("X-Team".to_string(), "$TEAM".to_string()),
        ]);
        let resolved = resolve_extension_headers(NAME, headers, &variables, &store).unwrap();
        assert_eq!(resolved["Authorization"], "Bearer 1");
        assert_eq!(resolved["X-Team"], "alpha");

        let other = secret_ref_for(SecretOwner::Extension("other"), "X-Api-Key").to_string();
        let cases = [
            ("X-Api-Key", own_ref("X-Api-Key"), "no credential"),
            ("X-Api-Key", other, "another header"),
            ("X-Api-Key", "${secret:Bad}".to_string(), "malformed"),
        ];
        for (header, value, reason) in cases {
            let headers = HashMap::from([(header.to_string(), value)]);
            let error = resolve_extension_headers(NAME, headers, &variables, &store).unwrap_err();
            assert_eq!(error.header, header);
            assert!(error.reason.contains(reason), "{error}");
            assert!(error.to_string().contains(NAME), "{error}");
        }

        store.set_unavailable(true);
        let headers = HashMap::from([("Authorization".to_string(), own_ref("Authorization"))]);
        assert!(resolve_extension_headers(NAME, headers, &variables, &store).is_err());
    }

    #[test]
    fn plaintext_headers_in_config_are_migrated_once() {
        let entries = TestEntries::new();
        let headers = [("Authorization", "Bearer plain"), ("Accept", "a")];
        entries
            .config
            .upsert_extension(entry(http(&headers, &[])))
            .unwrap();
        let before = entries.config_bytes();

        let locked = MemorySecretStore::new();
        locked.set_unavailable(true);
        let failures = migrate_extensions(&entries, &locked);
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].owner, MigrationOwner::Extension);
        assert_eq!(failures[0].stage, MigrationStage::Write);
        assert!(failures[0].to_string().contains(NAME));
        assert_eq!(entries.config_bytes(), before);

        let store = MemorySecretStore::new();
        entries.fail_writes.set(true);
        let failures = migrate_extensions(&entries, &store);
        assert_eq!(failures[0].stage, MigrationStage::Replace);
        assert_eq!(entries.config_bytes(), before);
        assert!(store.entries().is_empty());

        entries.fail_writes.set(false);
        assert!(migrate_extensions(&entries, &store).is_empty());
        let migrated = entries.get(&name_key()).unwrap();
        assert_eq!(
            headers_of(&migrated)["Authorization"],
            own_ref("Authorization")
        );
        assert_eq!(headers_of(&migrated)["Accept"], "a");
        assert_eq!(store.entries()[&own_key("Authorization")], "Bearer plain");
        let text = String::from_utf8(entries.config_bytes()).unwrap();
        assert!(!text.contains("Bearer plain"));
        assert!(migrate_extensions(&entries, &store).is_empty());
        assert_eq!(store.entries().len(), 1);
    }
}
