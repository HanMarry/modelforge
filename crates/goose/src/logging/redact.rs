//! Masks known credential values in Kernel logs and in error messages sent to clients
//! (requirement 1.10).
//!
//! Every value that goes through
//! [`ConfigSecretStore`](crate::config::secret_headers::ConfigSecretStore) is registered here.
//! The log writers built by [`build_logging_subscriber`](crate::logging::build_logging_subscriber)
//! and the ACP error conversion replace registered values with their mask before the text
//! leaves the process.

use std::borrow::Cow;
use std::cmp::Reverse;
use std::collections::BTreeMap;
use std::io;
use std::sync::{Arc, PoisonError, RwLock};

use tracing_subscriber::fmt::MakeWriter;

use super::secret_mask::mask_secret;

/// `redact_text` does not search for values this short, so they are not kept either.
const MIN_REGISTERED_CHARS: usize = 5;
/// Bounds both the memory and the work done per log line in a long-running process. Every
/// value takes up to three patterns (plain, JSON-escaped, `Debug`-escaped).
const MAX_PATTERNS: usize = 3 * 1024;

/// Patterns ordered longest first, ties by code point, the order `redact_text` uses; each maps
/// to its replacement.
type Patterns = BTreeMap<(Reverse<usize>, String), String>;

/// A set of credential values to mask. Reads take a shared lock, so masking a log line does
/// not block other writers.
#[derive(Debug, Default)]
pub struct SecretRegistry {
    patterns: RwLock<Patterns>,
}

impl SecretRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Remembers `value` together with the forms it takes inside JSON log lines and inside
    /// `Debug`-formatted log fields. An escaped form is replaced by the mask escaped the same
    /// way, so a masked JSON line stays valid JSON.
    pub fn register(&self, value: &str) {
        if value.chars().count() < MIN_REGISTERED_CHARS {
            return;
        }
        let mask = mask_secret(value);
        let forms = [
            (json_escape(value), json_escape(&mask)),
            (debug_escape(value), debug_escape(&mask)),
            (value.to_string(), mask),
        ];

        let lock = self.patterns.write();
        let mut patterns = lock.unwrap_or_else(PoisonError::into_inner);
        if patterns.len() >= MAX_PATTERNS {
            return;
        }
        for (pattern, replacement) in forms {
            let key = (Reverse(pattern.chars().count()), pattern);
            patterns.entry(key).or_insert(replacement);
        }
    }

    /// `None` when `text` contains no registered value, which is the common case and costs
    /// no allocation.
    pub fn redact(&self, text: &str) -> Option<String> {
        let lock = self.patterns.read();
        let patterns = lock.unwrap_or_else(PoisonError::into_inner);
        let found = patterns
            .keys()
            .any(|(_, pattern)| text.contains(pattern.as_str()));
        if !found {
            return None;
        }
        let mut result = text.to_string();
        for ((_, pattern), replacement) in patterns.iter() {
            if result.contains(pattern.as_str()) {
                result = result.replace(pattern.as_str(), replacement);
            }
        }
        Some(result)
    }
}

fn json_escape(value: &str) -> String {
    unquote(&serde_json::Value::from(value).to_string())
}

/// How `tracing` writes a string field in plain-text logs.
fn debug_escape(value: &str) -> String {
    unquote(&format!("{value:?}"))
}

fn unquote(quoted: &str) -> String {
    let inner = quoted
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'));
    inner.unwrap_or(quoted).to_string()
}

#[cfg(not(test))]
fn with_global<R>(f: impl FnOnce(&Arc<SecretRegistry>) -> R) -> R {
    static REGISTERED: std::sync::LazyLock<Arc<SecretRegistry>> =
        std::sync::LazyLock::new(|| Arc::new(SecretRegistry::new()));
    f(&REGISTERED)
}

/// Unit tests run in parallel threads of one process. A registry per thread keeps the values
/// one test registers from masking the text another test asserts on.
#[cfg(test)]
fn with_global<R>(f: impl FnOnce(&Arc<SecretRegistry>) -> R) -> R {
    thread_local! {
        static REGISTERED: Arc<SecretRegistry> = Arc::new(SecretRegistry::new());
    }
    REGISTERED.with(f)
}

/// Registers a credential value so logs and client-facing errors mask it from now on.
pub fn register_secret(value: &str) {
    with_global(|registry| registry.register(value));
}

/// `text` with every registered credential value masked.
pub fn redact_registered(text: &str) -> Cow<'_, str> {
    match with_global(|registry| registry.redact(text)) {
        Some(masked) => Cow::Owned(masked),
        None => Cow::Borrowed(text),
    }
}

/// Masks registered credential values in every string inside `value`.
pub fn redact_json_value(value: &mut serde_json::Value) {
    with_global(|registry| redact_json_with(registry, value));
}

fn redact_json_with(registry: &SecretRegistry, value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(text) => {
            if let Some(masked) = registry.redact(text) {
                *text = masked;
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                redact_json_with(registry, item);
            }
        }
        serde_json::Value::Object(map) => {
            for item in map.values_mut() {
                redact_json_with(registry, item);
            }
        }
        _ => {}
    }
}

/// Wraps a tracing writer factory so that registered credential values are masked in
/// everything written through it.
#[derive(Debug, Clone)]
pub struct RedactingMakeWriter<M> {
    inner: M,
    registry: Arc<SecretRegistry>,
}

impl<M> RedactingMakeWriter<M> {
    /// Masks the values registered with [`register_secret`].
    pub fn new(inner: M) -> Self {
        let registry = with_global(Arc::clone);
        Self::with_registry(inner, registry)
    }

    pub fn with_registry(inner: M, registry: Arc<SecretRegistry>) -> Self {
        Self { inner, registry }
    }
}

impl<'a, M> MakeWriter<'a> for RedactingMakeWriter<M>
where
    M: MakeWriter<'a>,
{
    type Writer = RedactingWriter<'a, M::Writer>;

    fn make_writer(&'a self) -> Self::Writer {
        RedactingWriter {
            inner: self.inner.make_writer(),
            registry: &self.registry,
        }
    }

    fn make_writer_for(&'a self, meta: &tracing::Metadata<'_>) -> Self::Writer {
        RedactingWriter {
            inner: self.inner.make_writer_for(meta),
            registry: &self.registry,
        }
    }
}

/// The tracing formatter writes each event with one `write_all`, so a value is never split
/// across two writes.
pub struct RedactingWriter<'a, W> {
    inner: W,
    registry: &'a SecretRegistry,
}

impl<W: io::Write> io::Write for RedactingWriter<'_, W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let text = std::str::from_utf8(buf).ok();
        match text.and_then(|text| self.registry.redact(text)) {
            Some(masked) => {
                self.inner.write_all(masked.as_bytes())?;
                Ok(buf.len())
            }
            // When no registered value occurs in `buf`, none occurs in the rest that
            // `write_all` passes back after a short write either.
            None => self.inner.write(buf),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::Mutex;
    use tracing_subscriber::layer::SubscriberExt;

    #[derive(Clone, Default)]
    struct Sink(Arc<Mutex<Vec<u8>>>);

    impl Sink {
        fn text(&self) -> String {
            String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
        }
    }

    impl io::Write for Sink {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn registered_values_are_masked_and_short_ones_ignored() {
        let registry = SecretRegistry::new();
        registry.register("abcd");
        registry.register("Bearer sk-registry-0001");

        assert_eq!(registry.redact("abcd is too short to register"), None);
        assert_eq!(registry.redact("nothing to mask"), None);
        let masked = registry.redact("header Bearer sk-registry-0001 sent");
        assert_eq!(masked.as_deref(), Some("header ********0001 sent"));
    }

    #[test]
    fn longer_values_are_masked_first() {
        let registry = SecretRegistry::new();
        registry.register("sk-inner-12345");
        registry.register("Bearer sk-inner-12345");

        let masked = registry.redact("a=Bearer sk-inner-12345 b=sk-inner-12345");
        assert_eq!(masked.as_deref(), Some("a=********2345 b=********2345"));
    }

    #[test]
    fn escaped_forms_are_masked_and_json_stays_valid() {
        let registry = SecretRegistry::new();
        let secret = "tok\\en-with\"abc";
        registry.register(secret);
        let line = serde_json::json!({ "message": format!("value {secret}") }).to_string();

        let masked = registry.redact(&line).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&masked).unwrap();
        assert_eq!(parsed["message"], "value ********\"abc");

        let debug = registry.redact(&format!("header={secret:?}")).unwrap();
        assert_eq!(debug, "header=\"********\\\"abc\"");
    }

    #[test]
    fn writer_masks_before_writing() -> io::Result<()> {
        let registry = SecretRegistry::new();
        registry.register("sk-writer-secret-42");
        let mut writer = RedactingWriter {
            inner: Vec::new(),
            registry: &registry,
        };

        writer.write_all(b"failed with sk-writer-secret-42\n")?;
        writer.write_all(b"plain line\n")?;
        let written = String::from_utf8(writer.inner).unwrap();
        assert_eq!(written, "failed with ********t-42\nplain line\n");
        Ok(())
    }

    #[test]
    fn tracing_events_are_masked_in_the_formatted_output() {
        let registry = Arc::new(SecretRegistry::new());
        registry.register("Bearer sk-tracing-5678");
        let sink = Sink::default();
        let make = {
            let sink = sink.clone();
            move || sink.clone()
        };
        let writer = RedactingMakeWriter::with_registry(make, registry);
        let layer = tracing_subscriber::fmt::layer()
            .with_ansi(false)
            .with_writer(writer);
        let subscriber = tracing_subscriber::registry().with(layer);

        tracing::subscriber::with_default(subscriber, || {
            let header = "Bearer sk-tracing-5678";
            tracing::warn!(header, "request failed: {header}");
        });

        let logged = sink.text();
        assert!(!logged.contains("sk-tracing-5678"), "{logged}");
        assert!(logged.contains("********5678"), "{logged}");
    }

    #[test]
    fn json_values_are_masked_everywhere() {
        register_secret("sk-json-value-9012");
        let mut value = serde_json::json!({
            "message": "bad key sk-json-value-9012",
            "nested": ["sk-json-value-9012", 3, { "k": "sk-json-value-9012" }],
        });

        redact_json_value(&mut value);
        let text = value.to_string();
        assert!(!text.contains("sk-json-value-9012"), "{text}");
        assert_eq!(redact_registered("plain"), "plain");
    }
}
