use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::RwLock;

pub type SpawnServerFn = fn(tokio::io::DuplexStream, tokio::io::DuplexStream);

static BUILTIN_REGISTRY: Lazy<RwLock<HashMap<&'static str, SpawnServerFn>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

/// Least client-side timeout, in seconds, of the builtin `modeling` extension. Its `run_script`
/// tool enforces its own time limit, up to 86400 seconds
/// (`goose_mcp::modeling::run_script::MAX_TIMEOUT_SECS`), then kills the run and records it as
/// timed out. goose must not cancel the call before that happens; the extra minute covers
/// killing the process tree and writing the Run_Record.
pub const MODELING_TIMEOUT_SECS: u64 = 86_460;

/// The client-side timeout for the builtin extension with key `name`: `configured_secs` (from the
/// extension config or the default), raised to the extension's floor if it has one. Only
/// `modeling` has one, see [`MODELING_TIMEOUT_SECS`].
pub fn builtin_extension_timeout(name: &str, configured_secs: u64) -> u64 {
    match name {
        "modeling" => configured_secs.max(MODELING_TIMEOUT_SECS),
        _ => configured_secs,
    }
}

/// Register a builtin extension into the global registry
pub fn register_builtin_extension(name: &'static str, spawn_fn: SpawnServerFn) {
    BUILTIN_REGISTRY.write().unwrap().insert(name, spawn_fn);
}

/// Register multiple builtin extensions from a HashMap
pub fn register_builtin_extensions(extensions: HashMap<&'static str, SpawnServerFn>) {
    let mut registry = BUILTIN_REGISTRY.write().unwrap();
    registry.extend(extensions);
}

/// Get a copy of all registered builtin extensions
pub fn get_builtin_extension(name: &str) -> Option<SpawnServerFn> {
    BUILTIN_REGISTRY.read().unwrap().get(name).cloned()
}

pub fn get_builtin_extension_names() -> Vec<&'static str> {
    BUILTIN_REGISTRY.read().unwrap().keys().copied().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::DEFAULT_EXTENSION_TIMEOUT;

    #[test]
    fn modeling_outlasts_the_longest_run_script() {
        let longest_run = goose_mcp::modeling::run_script::MAX_TIMEOUT_SECS;
        for configured in [DEFAULT_EXTENSION_TIMEOUT, 1, longest_run] {
            assert!(
                builtin_extension_timeout("modeling", configured) > longest_run,
                "configured {configured}"
            );
        }
        assert_eq!(
            builtin_extension_timeout("modeling", DEFAULT_EXTENSION_TIMEOUT),
            MODELING_TIMEOUT_SECS
        );
        // A longer configured timeout is kept.
        assert_eq!(
            builtin_extension_timeout("modeling", 2 * MODELING_TIMEOUT_SECS),
            2 * MODELING_TIMEOUT_SECS
        );
    }

    #[test]
    fn other_builtins_keep_their_configured_timeout() {
        for name in goose_mcp::BUILTIN_EXTENSIONS.keys().copied() {
            if name == "modeling" {
                continue;
            }
            for configured in [1, DEFAULT_EXTENSION_TIMEOUT, 100_000] {
                assert_eq!(
                    builtin_extension_timeout(name, configured),
                    configured,
                    "{name}"
                );
            }
        }
        assert_eq!(builtin_extension_timeout("unknown", 5), 5);
    }
}
