//! Auth headers of custom providers and MCP extensions (requirement 1).
//!
//! The value of an auth header is kept in the credential store; the config file only holds a
//! reference of the form `${secret:<key>}`. This module decides which headers count as auth
//! headers, derives and parses the references, and resolves them back to values before a
//! request is built. Custom providers and MCP extensions use the same functions
//! (requirement 1.11).
//!
//! `crate::utils::is_sensitive_header_name` is a broader name heuristic (any name containing
//! `token`, `key`, ...) kept from the earlier extension fix; it can suggest marking a header as
//! sensitive, but the classification required by requirement 1.1 is [`is_auth_header`].

use std::collections::HashMap;
use std::fmt;

use sha2::{Digest, Sha256};

use crate::config::{Config, ConfigError};

/// Header names that always carry credentials, compared case-insensitively (requirement 1.1).
pub const AUTH_HEADER_NAMES: &[&str] = &[
    "authorization",
    "proxy-authorization",
    "x-api-key",
    "api-key",
];

/// Whether a header is an auth header: its name is one of [`AUTH_HEADER_NAMES`] in any case,
/// or the user marked it as sensitive in the CLI or the desktop app.
pub fn is_auth_header(name: &str, user_marked_sensitive: bool) -> bool {
    let known = |candidate: &&str| name.eq_ignore_ascii_case(candidate);
    user_marked_sensitive || AUTH_HEADER_NAMES.iter().any(known)
}

/// Whether `name` is in the user's list of sensitive header names. Header names are
/// case-insensitive, so `X-Tenant-Token` in the list also covers `x-tenant-token`.
pub fn is_marked_sensitive(name: &str, sensitive_headers: &[String]) -> bool {
    sensitive_headers
        .iter()
        .any(|marked| marked.eq_ignore_ascii_case(name))
}

const REF_PREFIX: &str = "${secret:";
const REF_SUFFIX: &str = "}";

/// A reference to a credential store entry, written in config files as `${secret:<key>}`.
/// The key only contains `[a-z0-9_]`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SecretRef {
    key: String,
}

impl SecretRef {
    /// Returns `None` when `key` is empty or contains characters outside `[a-z0-9_]`.
    pub fn new(key: impl Into<String>) -> Option<Self> {
        let key = key.into();
        is_valid_key(&key).then_some(Self { key })
    }

    pub fn key(&self) -> &str {
        &self.key
    }
}

impl fmt::Display for SecretRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{REF_PREFIX}{}{REF_SUFFIX}", self.key)
    }
}

fn is_valid_key(key: &str) -> bool {
    let allowed = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_';
    !key.is_empty() && key.bytes().all(allowed)
}

/// Whether a header value starts like a reference. A value that does but fails
/// [`parse_secret_ref`] is malformed and must be neither stored nor sent.
pub fn looks_like_secret_ref(value: &str) -> bool {
    value.starts_with(REF_PREFIX)
}

/// Parses a header value that consists of exactly one reference, with nothing around it.
pub fn parse_secret_ref(value: &str) -> Option<SecretRef> {
    value
        .strip_prefix(REF_PREFIX)?
        .strip_suffix(REF_SUFFIX)
        .and_then(SecretRef::new)
}

/// The config entry an auth header belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretOwner<'a> {
    /// A custom provider, by provider id.
    Provider(&'a str),
    /// An MCP extension, by extension name.
    Extension(&'a str),
}

impl SecretOwner<'_> {
    fn kind(&self) -> &'static str {
        match self {
            SecretOwner::Provider(_) => "provider",
            SecretOwner::Extension(_) => "extension",
        }
    }

    fn id(&self) -> &str {
        match self {
            SecretOwner::Provider(id) | SecretOwner::Extension(id) => id,
        }
    }
}

/// Longest readable part taken from the owner id or the header name.
const SLUG_MAX_LEN: usize = 40;

/// Derives the reference for one auth header, for example
/// `${secret:provider_custom_deepseek__header__authorization_79da571049dfed38}`.
///
/// The readable part is lossy (`x-api-key` and `x_api_key` read the same), so the key ends with
/// 64 bits of SHA-256 over the kind, the exact owner id and the lowercased header name. Header
/// names are case-insensitive, so every spelling of one header maps to the same entry.
///
/// Stored entries are found through this derivation: changing it orphans every saved header
/// secret.
pub fn secret_ref_for(owner: SecretOwner<'_>, header_name: &str) -> SecretRef {
    let kind = owner.kind();
    let id = owner.id();
    let header = header_name.to_ascii_lowercase();
    // The id length keeps the boundary between id and header unambiguous.
    let id_len = id.len();
    let digest = Sha256::digest(format!("{kind}\n{id_len}\n{id}\n{header}"));
    let suffix: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
    let owner_slug = slug(id);
    let header_slug = slug(&header);
    let key = format!("{kind}_{owner_slug}__header__{header_slug}_{suffix}");
    SecretRef { key }
}

/// ASCII letters and digits in lowercase, with every other run of characters folded into a
/// single `_`. Never empty, never starts or ends with `_`, never contains `__`.
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

/// Error from the credential store. The message never contains a stored value.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("credential store error: {0}")]
pub struct SecretStoreError(pub String);

/// Where auth header values are kept.
pub trait SecretStore: Send + Sync {
    fn set(&self, key: &str, value: &str) -> Result<(), SecretStoreError>;
    /// `Ok(None)` when there is no entry for `key`; `Err` when the store cannot be read.
    fn get(&self, key: &str) -> Result<Option<String>, SecretStoreError>;
    /// Deleting an entry that does not exist succeeds.
    fn delete(&self, key: &str) -> Result<(), SecretStoreError>;
}

/// The goose secret storage behind [`Config`]: the system keyring, or `secrets.yaml` when the
/// keyring is disabled. Like every goose secret, an entry can be overridden by an environment
/// variable named after the uppercased key.
pub struct ConfigSecretStore<'a> {
    config: &'a Config,
}

impl<'a> ConfigSecretStore<'a> {
    pub fn new(config: &'a Config) -> Self {
        Self { config }
    }
}

impl ConfigSecretStore<'static> {
    pub fn global() -> Self {
        Self::new(Config::global())
    }
}

fn store_error(error: ConfigError) -> SecretStoreError {
    SecretStoreError(error.to_string())
}

impl SecretStore for ConfigSecretStore<'_> {
    fn set(&self, key: &str, value: &str) -> Result<(), SecretStoreError> {
        self.config.set_secret(key, &value).map_err(store_error)
    }

    fn get(&self, key: &str) -> Result<Option<String>, SecretStoreError> {
        match self.config.get_secret::<String>(key) {
            Ok(value) => Ok(Some(value)),
            Err(ConfigError::NotFound(_)) => Ok(None),
            Err(error) => Err(store_error(error)),
        }
    }

    fn delete(&self, key: &str) -> Result<(), SecretStoreError> {
        self.config.delete_secret(key).map_err(store_error)
    }
}

/// Why a header value could not be resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnresolvedReason {
    /// The value starts like a reference but is not a valid one, so sending it as is would
    /// leak the reference text instead of the credential.
    Malformed,
    /// The store has no entry for the reference, or the entry is empty.
    Missing,
    /// The store could not be read.
    StoreUnavailable(String),
}

impl fmt::Display for UnresolvedReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            UnresolvedReason::Malformed => write!(f, "the secret reference is malformed"),
            UnresolvedReason::Missing => write!(f, "no credential is stored for it"),
            UnresolvedReason::StoreUnavailable(cause) => write!(f, "{cause}"),
        }
    }
}

/// A header whose secret reference could not be resolved (requirement 1.5). Callers must not
/// send the request.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("cannot resolve the credential for header {header}: {reason}")]
pub struct UnresolvedHeader {
    pub header: String,
    pub reason: UnresolvedReason,
}

impl UnresolvedHeader {
    fn new(header: &str, reason: UnresolvedReason) -> Self {
        Self {
            header: header.to_string(),
            reason,
        }
    }
}

/// Replaces every secret reference in `headers` with the stored value; other values pass
/// through unchanged. Fails on the first header that cannot be resolved, in header name order,
/// and then returns no headers at all, so an empty value or the reference text is never sent
/// (requirements 1.4, 1.5).
pub fn resolve_headers(
    headers: &HashMap<String, String>,
    store: &dyn SecretStore,
) -> Result<HashMap<String, String>, UnresolvedHeader> {
    let mut entries: Vec<(&String, &String)> = headers.iter().collect();
    entries.sort_unstable();

    let mut resolved = HashMap::with_capacity(entries.len());
    for (name, value) in entries {
        match resolve_value(value, store) {
            Ok(value) => {
                resolved.insert(name.clone(), value);
            }
            Err(reason) => return Err(UnresolvedHeader::new(name, reason)),
        }
    }
    Ok(resolved)
}

fn resolve_value(value: &str, store: &dyn SecretStore) -> Result<String, UnresolvedReason> {
    match parse_secret_ref(value) {
        Some(reference) => match store.get(reference.key()) {
            Ok(Some(secret)) if !secret.is_empty() => Ok(secret),
            Ok(_) => Err(UnresolvedReason::Missing),
            Err(error) => Err(UnresolvedReason::StoreUnavailable(error.to_string())),
        },
        None if looks_like_secret_ref(value) => Err(UnresolvedReason::Malformed),
        None => Ok(value.to_string()),
    }
}

#[cfg(test)]
pub(crate) mod testing {
    use super::{SecretStore, SecretStoreError};
    use std::collections::BTreeMap;
    use std::sync::{Mutex, MutexGuard};

    #[derive(Default)]
    struct State {
        entries: BTreeMap<String, String>,
        calls: usize,
        fail_on_call: Option<usize>,
        unavailable: bool,
    }

    /// In-memory credential store for tests. `set`, `get` and `delete` calls are numbered from
    /// 1; `fail_on_call(k)` makes the k-th call fail without touching the entries, and
    /// `set_unavailable(true)` makes every call fail, like a locked keyring.
    #[derive(Default)]
    pub(crate) struct MemorySecretStore {
        state: Mutex<State>,
    }

    impl MemorySecretStore {
        pub(crate) fn new() -> Self {
            Self::default()
        }

        pub(crate) fn with_entries<I, K, V>(entries: I) -> Self
        where
            I: IntoIterator<Item = (K, V)>,
            K: Into<String>,
            V: Into<String>,
        {
            let entries = entries.into_iter().map(|(k, v)| (k.into(), v.into()));
            let store = Self::new();
            store.lock().entries = entries.collect();
            store
        }

        pub(crate) fn fail_on_call(&self, call: usize) {
            self.lock().fail_on_call = Some(call);
        }

        pub(crate) fn set_unavailable(&self, unavailable: bool) {
            self.lock().unavailable = unavailable;
        }

        /// The stored entries; reading them is not counted as a call.
        pub(crate) fn entries(&self) -> BTreeMap<String, String> {
            self.lock().entries.clone()
        }

        pub(crate) fn calls(&self) -> usize {
            self.lock().calls
        }

        fn lock(&self) -> MutexGuard<'_, State> {
            self.state.lock().unwrap()
        }

        fn begin(&self) -> Result<MutexGuard<'_, State>, SecretStoreError> {
            let mut state = self.lock();
            state.calls += 1;
            let call = state.calls;
            if state.unavailable {
                return Err(SecretStoreError("store unavailable".to_string()));
            }
            if state.fail_on_call == Some(call) {
                return Err(SecretStoreError(format!("injected failure {call}")));
            }
            Ok(state)
        }
    }

    impl SecretStore for MemorySecretStore {
        fn set(&self, key: &str, value: &str) -> Result<(), SecretStoreError> {
            let mut state = self.begin()?;
            state.entries.insert(key.to_string(), value.to_string());
            Ok(())
        }

        fn get(&self, key: &str) -> Result<Option<String>, SecretStoreError> {
            Ok(self.begin()?.entries.get(key).cloned())
        }

        fn delete(&self, key: &str) -> Result<(), SecretStoreError> {
            self.begin()?.entries.remove(key);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::MemorySecretStore;
    use super::*;
    use proptest::prelude::*;
    use std::collections::HashSet;

    fn headers(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect()
    }

    #[test]
    fn known_auth_header_names_match_in_any_case() {
        for name in [
            "Authorization",
            "AUTHORIZATION",
            "proxy-Authorization",
            "X-API-Key",
            "x-api-key",
            "Api-Key",
        ] {
            assert!(is_auth_header(name, false), "{name}");
        }
        for name in [
            "Authorization2",
            " authorization",
            "x_api_key",
            "api_key",
            "X-Auth-Token",
            "Content-Type",
            "",
        ] {
            assert!(!is_auth_header(name, false), "{name}");
            assert!(is_auth_header(name, true), "{name}");
        }
    }

    #[test]
    fn marked_sensitive_names_match_in_any_case() {
        let marked = ["X-Tenant-Token".to_string()];
        assert!(is_marked_sensitive("x-tenant-token", &marked));
        assert!(is_marked_sensitive("X-TENANT-TOKEN", &marked));
        assert!(!is_marked_sensitive("X-Tenant", &marked));
        assert!(!is_marked_sensitive("X-Tenant-Token", &[]));
    }

    #[test]
    fn reference_keys_are_stable() {
        let provider = secret_ref_for(SecretOwner::Provider("custom_deepseek"), "Authorization");
        assert_eq!(
            provider.to_string(),
            "${secret:provider_custom_deepseek__header__authorization_79da571049dfed38}"
        );
        let extension = secret_ref_for(SecretOwner::Extension("GitHub MCP"), "X-API-Key");
        assert_eq!(
            extension.to_string(),
            "${secret:extension_github_mcp__header__x_api_key_61a97ef98eb6c5e0}"
        );
    }

    #[test]
    fn reference_keys_separate_owners_and_headers() {
        let provider = SecretOwner::Provider("custom_gw");
        assert_eq!(
            secret_ref_for(provider, "Authorization"),
            secret_ref_for(provider, "authorization")
        );

        let references = [
            secret_ref_for(provider, "x-api-key"),
            secret_ref_for(provider, "x_api_key"),
            secret_ref_for(provider, "x_api-key"),
            secret_ref_for(SecretOwner::Extension("custom_gw"), "x-api-key"),
            secret_ref_for(SecretOwner::Provider("custom-gw"), "x-api-key"),
            secret_ref_for(SecretOwner::Provider("custom_gw_x"), "api-key"),
        ];
        let keys: HashSet<&str> = references.iter().map(SecretRef::key).collect();
        assert_eq!(keys.len(), references.len());
    }

    #[test]
    fn reference_keys_are_valid_for_any_owner_and_header() {
        let long = "a".repeat(200);
        for (owner, header) in [
            (SecretOwner::Extension("中文 扩展"), "令牌"),
            (SecretOwner::Extension(""), ""),
            (SecretOwner::Provider("__x__"), "--"),
            (SecretOwner::Provider(long.as_str()), long.as_str()),
        ] {
            let reference = secret_ref_for(owner, header);
            assert!(is_valid_key(reference.key()), "{}", reference.key());
            assert_eq!(parse_secret_ref(&reference.to_string()), Some(reference));
        }
        let cjk = secret_ref_for(SecretOwner::Extension("中文 扩展"), "令牌");
        assert!(cjk.key().starts_with("extension_x__header__x_"));
    }

    #[test]
    fn only_whole_valid_references_parse() {
        let parsed = parse_secret_ref("${secret:abc_1}").unwrap();
        assert_eq!(parsed.key(), "abc_1");
        for value in [
            "${secret:}",
            "${secret:ABC}",
            "${secret:a-b}",
            "${secret:abc",
            " ${secret:abc}",
            "${secret:abc} ",
            "Bearer ${secret:abc}",
            "$secret:abc}",
            "${SECRET:abc}",
            "sk-plain",
        ] {
            assert!(parse_secret_ref(value).is_none(), "{value}");
        }
        assert!(SecretRef::new("Upper").is_none());
        assert!(SecretRef::new("").is_none());
    }

    #[test]
    fn config_store_round_trips_through_secret_storage() -> Result<(), ConfigError> {
        let dir = tempfile::tempdir()?;
        let config_path = dir.path().join("config.yaml");
        let secrets_path = dir.path().join("secrets.yaml");
        let config = Config::new_with_file_secrets(config_path, secrets_path)?;
        let store = ConfigSecretStore::new(&config);
        let reference = secret_ref_for(SecretOwner::Provider("custom_rt"), "Authorization");
        let key = reference.key();

        assert_eq!(store.get(key), Ok(None));
        store.set(key, "Bearer 密钥 🔑").unwrap();
        assert_eq!(store.get(key), Ok(Some("Bearer 密钥 🔑".to_string())));
        store.delete(key).unwrap();
        assert_eq!(store.get(key), Ok(None));
        store.delete(key).unwrap();
        Ok(())
    }

    #[test]
    fn memory_store_injects_failures_without_side_effects() {
        let store = MemorySecretStore::with_entries([("kept", "old")]);
        store.fail_on_call(2);

        store.set("first", "1").unwrap();
        assert!(store.set("second", "2").is_err());
        assert_eq!(store.get("kept"), Ok(Some("old".to_string())));
        assert_eq!(store.calls(), 3);
        let entries = store.entries();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries["first"], "1");
        assert_eq!(entries["kept"], "old");

        store.set_unavailable(true);
        assert!(store.get("kept").is_err());
        assert!(store.delete("kept").is_err());
        store.set_unavailable(false);
        store.delete("kept").unwrap();
        assert_eq!(store.get("kept"), Ok(None));
    }

    #[test]
    fn resolves_references_and_passes_other_values_through() {
        let reference = secret_ref_for(SecretOwner::Provider("custom_gw"), "Authorization");
        let secret = "Bearer sk-1234567890";
        let store = MemorySecretStore::with_entries([(reference.key(), secret)]);
        let input = HashMap::from([
            ("Authorization".to_string(), reference.to_string()),
            ("X-Team".to_string(), "alpha".to_string()),
        ]);

        let resolved = resolve_headers(&input, &store).unwrap();
        assert_eq!(resolved.len(), 2);
        assert_eq!(resolved["Authorization"], secret);
        assert_eq!(resolved["X-Team"], "alpha");
    }

    #[test]
    fn unresolvable_references_fail_with_the_header_name() {
        let reference = secret_ref_for(SecretOwner::Provider("custom_gw"), "Authorization");
        let input = HashMap::from([
            ("Authorization".to_string(), reference.to_string()),
            ("X-Team".to_string(), "a".to_string()),
        ]);

        let empty_store = MemorySecretStore::new();
        let missing = resolve_headers(&input, &empty_store).unwrap_err();
        assert_eq!(missing.header, "Authorization");
        assert_eq!(missing.reason, UnresolvedReason::Missing);

        let empty_value = MemorySecretStore::with_entries([(reference.key(), "")]);
        let reason = resolve_headers(&input, &empty_value).unwrap_err().reason;
        assert_eq!(reason, UnresolvedReason::Missing);

        let locked = MemorySecretStore::new();
        locked.set_unavailable(true);
        let reason = resolve_headers(&input, &locked).unwrap_err().reason;
        assert!(matches!(reason, UnresolvedReason::StoreUnavailable(_)));

        let input = headers(&[("X-Token", "${secret:Not-Valid}")]);
        let malformed = resolve_headers(&input, &empty_store).unwrap_err();
        assert_eq!(malformed.header, "X-Token");
        assert_eq!(malformed.reason, UnresolvedReason::Malformed);
        assert!(!malformed.to_string().contains("Not-Valid"));
    }

    const EXPECTED_AUTH_NAMES: [&str; 4] = [
        "authorization",
        "proxy-authorization",
        "x-api-key",
        "api-key",
    ];

    fn with_random_case(name: &str, mask: u64) -> String {
        let mut out = String::with_capacity(name.len());
        for (index, ch) in name.chars().enumerate() {
            if ((mask >> (index % 64)) & 1) == 1 {
                out.push(ch.to_ascii_uppercase());
            } else {
                out.push(ch);
            }
        }
        out
    }

    /// Known names in random case, near misses of them, header-like names and arbitrary text.
    fn header_name() -> impl Strategy<Value = String> {
        let known = || prop::sample::select(EXPECTED_AUTH_NAMES.to_vec());
        let near_miss = "[ _a-z0-9-]{0,2}";
        prop_oneof![
            (known(), any::<u64>()).prop_map(|(name, mask)| with_random_case(name, mask)),
            (known(), near_miss, near_miss)
                .prop_map(|(name, before, after)| format!("{before}{name}{after}")),
            "[A-Za-z0-9_-]{0,24}",
            ".{0,12}",
        ]
    }

    #[derive(Debug, Clone)]
    enum HeaderSpec {
        Plain(String),
        /// The stored value, and whether the entry is in the store.
        Reference(String, bool),
        Malformed(String),
    }

    fn malformed_reference() -> impl Strategy<Value = String> {
        prop_oneof![
            Just(REF_PREFIX.to_string()),
            "\\$\\{secret:[A-Z-]{1,8}\\}",
            "\\$\\{secret:[a-z0-9_]{1,8}\\} ",
            "\\$\\{secret:[a-z0-9_]{1,8}",
        ]
    }

    fn header_spec() -> impl Strategy<Value = HeaderSpec> {
        prop_oneof![
            ".{0,30}"
                .prop_filter("not a reference", |v| !v.starts_with(REF_PREFIX))
                .prop_map(HeaderSpec::Plain),
            (".{1,30}", any::<bool>())
                .prop_map(|(value, present)| HeaderSpec::Reference(value, present)),
            malformed_reference().prop_map(HeaderSpec::Malformed),
        ]
    }

    // Feature: mathmodel-parity-and-beyond, Property 1: 认证请求头判定
    proptest! {
        #![proptest_config(ProptestConfig::with_cases(100))]

        #[test]
        fn auth_header_iff_known_name_or_marked(
            name in header_name(),
            others in prop::collection::vec(header_name(), 0..4),
            mark_itself in any::<bool>(),
            mask in any::<u64>(),
        ) {
            let mut marked = others;
            if mark_itself {
                marked.push(with_random_case(&name, mask));
            }
            let lower = name.to_ascii_lowercase();
            let known = EXPECTED_AUTH_NAMES.contains(&lower.as_str());
            let expected = known || marked.iter().any(|m| m.to_ascii_lowercase() == lower);

            // Providers and MCP extensions both classify through these two functions.
            prop_assert_eq!(is_auth_header(&name, is_marked_sensitive(&name, &marked)), expected);
            prop_assert_eq!(is_auth_header(&name, false), known);
            prop_assert!(is_auth_header(&name, true));
        }
    }

    // Feature: mathmodel-parity-and-beyond, Property 4: 无法解析的 Secret_Reference 阻止请求
    proptest! {
        #![proptest_config(ProptestConfig::with_cases(100))]

        #[test]
        fn resolution_fails_iff_a_reference_cannot_be_resolved(
            // Lowercase names: two spellings of one header share one entry.
            specs in prop::collection::hash_map("[a-z][a-z0-9-]{0,12}", header_spec(), 0..8),
            store_down in prop::bool::weighted(0.2),
        ) {
            let store = MemorySecretStore::new();
            let mut input = HashMap::new();
            let mut unresolvable = HashSet::new();
            for (name, spec) in &specs {
                let value = match spec {
                    HeaderSpec::Plain(value) => value.clone(),
                    HeaderSpec::Reference(value, present) => {
                        let reference = secret_ref_for(SecretOwner::Provider("custom_gw"), name);
                        if *present {
                            store.set(reference.key(), value).unwrap();
                        }
                        if !*present || store_down {
                            unresolvable.insert(name.clone());
                        }
                        reference.to_string()
                    }
                    HeaderSpec::Malformed(value) => {
                        unresolvable.insert(name.clone());
                        value.clone()
                    }
                };
                input.insert(name.clone(), value);
            }
            store.set_unavailable(store_down);
            let before = store.entries();

            let result = resolve_headers(&input, &store);

            // Resolving only reads the store.
            prop_assert_eq!(store.entries(), before);
            prop_assert_eq!(result.is_err(), !unresolvable.is_empty());
            match result {
                Err(error) => {
                    prop_assert!(unresolvable.contains(&error.header), "{error:?}");
                }
                Ok(resolved) => {
                    prop_assert_eq!(resolved.len(), specs.len());
                    for (name, spec) in &specs {
                        let expected = match spec {
                            HeaderSpec::Plain(value) | HeaderSpec::Reference(value, _) => value,
                            HeaderSpec::Malformed(_) => unreachable!("malformed values fail"),
                        };
                        prop_assert_eq!(resolved.get(name), Some(expected));
                    }
                }
            }
        }
    }
}
