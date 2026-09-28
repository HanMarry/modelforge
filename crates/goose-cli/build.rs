//! Embeds build provenance into the goose binary (spec mathmodel-parity-and-beyond, requirement
//! 3.2, 3.6, 3.9). `goose version --json` reports these values:
//!
//! - `GOOSE_BUILD_COMMIT`: the full 40-character commit id, or `unknown`.
//! - `GOOSE_BUILD_DIRTY`: `true` or `false`, or `unknown`.
//! - `GOOSE_BUILD_FEATURES`: the enabled goose-cli features, sorted and comma-separated.
//!
//! The release pipeline (`ui/desktop/scripts/release/build-release.mts`) and the dev build
//! (`build-kernel.ps1`) compile a copy of the sources without `.git`, so they pass the commit and
//! the dirty flag in environment variables of the same names. A plain `cargo build` in a checkout
//! asks git instead. Provenance never fails the build: whatever cannot be determined (no git, not
//! a checkout of this workspace, a malformed value) is recorded as `unknown`.
//!
//! Features always come from cargo itself, so the binary cannot claim features it was not built
//! with.

use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

const UNKNOWN: &str = "unknown";
const COMMIT_VAR: &str = "GOOSE_BUILD_COMMIT";
const DIRTY_VAR: &str = "GOOSE_BUILD_DIRTY";
const FEATURES_VAR: &str = "GOOSE_BUILD_FEATURES";

fn main() {
    println!("cargo::rerun-if-changed=build.rs");
    println!("cargo::rerun-if-env-changed={COMMIT_VAR}");
    println!("cargo::rerun-if-env-changed={DIRTY_VAR}");

    let manifest_dir = env::var_os("CARGO_MANIFEST_DIR")
        .map(PathBuf::from)
        .unwrap_or_default();
    let pipeline_commit = pipeline_value(COMMIT_VAR);
    let pipeline_dirty = pipeline_value(DIRTY_VAR);

    // Only consult git for what the pipeline did not pass; pipeline builds have no `.git`.
    let git = if pipeline_commit.is_none() || pipeline_dirty.is_none() {
        GitCheckout::find(&manifest_dir)
    } else {
        None
    };
    if let Some(git) = &git {
        git.watch_head();
    }

    let commit = match &pipeline_commit {
        Some(value) => normalize_commit(value),
        None => git.as_ref().and_then(GitCheckout::head),
    };
    let dirty = match &pipeline_dirty {
        Some(value) => normalize_dirty(value),
        None => git.as_ref().and_then(GitCheckout::dirty),
    };
    if let (Some(value), None) = (&pipeline_commit, &commit) {
        warn_ignored(COMMIT_VAR, value);
    }
    if let (Some(value), None) = (&pipeline_dirty, &dirty) {
        warn_ignored(DIRTY_VAR, value);
    }

    let commit = commit.unwrap_or_else(|| UNKNOWN.to_owned());
    let dirty = match dirty {
        Some(dirty) => dirty.to_string(),
        None => UNKNOWN.to_owned(),
    };
    let features = enabled_features().join(",");
    println!("cargo::rustc-env={COMMIT_VAR}={commit}");
    println!("cargo::rustc-env={DIRTY_VAR}={dirty}");
    println!("cargo::rustc-env={FEATURES_VAR}={features}");
}

fn pipeline_value(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn warn_ignored(name: &str, value: &str) {
    if !value.eq_ignore_ascii_case(UNKNOWN) {
        println!("cargo::warning=ignoring {name}={value:?}; recording \"{UNKNOWN}\" instead");
    }
}

/// A full commit id in lowercase; abbreviated ids and anything else are rejected.
fn normalize_commit(value: &str) -> Option<String> {
    let value = value.trim().to_ascii_lowercase();
    let is_full_sha = value.len() == 40 && value.bytes().all(|b| b.is_ascii_hexdigit());
    is_full_sha.then_some(value)
}

fn normalize_dirty(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "true" | "1" => Some(true),
        "false" | "0" => Some(false),
        _ => None,
    }
}

/// goose-cli features cargo enabled for this build. `CARGO_CFG_FEATURE` keeps the names as
/// written in Cargo.toml; the `CARGO_FEATURE_<NAME>` fallback cannot tell `-` from `_`, and every
/// goose-cli feature is spelled with `-`.
fn enabled_features() -> Vec<String> {
    let mut features = match env::var("CARGO_CFG_FEATURE") {
        Ok(value) => split_list(&value),
        Err(_) => env::vars()
            .filter_map(|(key, _)| feature_from_env_key(&key))
            .collect(),
    };
    features.retain(|name| name != "default");
    features.sort();
    features.dedup();
    features
}

fn split_list(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .collect()
}

fn feature_from_env_key(key: &str) -> Option<String> {
    let name = key.strip_prefix("CARGO_FEATURE_")?;
    Some(name.to_ascii_lowercase().replace('_', "-"))
}

/// The git checkout this workspace is built from, when there is one and git runs.
struct GitCheckout {
    dir: PathBuf,
}

impl GitCheckout {
    fn find(manifest_dir: &Path) -> Option<Self> {
        let checkout = Self {
            dir: manifest_dir.to_path_buf(),
        };
        // A source copy without `.git` that happens to sit inside another repository must not
        // report that repository's commit, so the checkout root has to be this workspace's root.
        let toplevel = PathBuf::from(checkout.run(&["rev-parse", "--show-toplevel"])?);
        let workspace_root = manifest_dir.join("..").join("..");
        if toplevel.canonicalize().ok()? != workspace_root.canonicalize().ok()? {
            return None;
        }
        Some(checkout)
    }

    /// `GIT_OPTIONAL_LOCKS=0` keeps `git status` from rewriting the index, which would wake
    /// file watchers and IDEs on every build script run.
    fn run(&self, args: &[&str]) -> Option<String> {
        let output = Command::new("git")
            .args(args)
            .current_dir(&self.dir)
            .env("GIT_OPTIONAL_LOCKS", "0")
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8(output.stdout).ok()?;
        Some(text.trim_end().to_owned())
    }

    fn head(&self) -> Option<String> {
        normalize_commit(&self.run(&["rev-parse", "--verify", "HEAD"])?)
    }

    fn dirty(&self) -> Option<bool> {
        let status = self.run(&["status", "--porcelain", "--untracked-files=normal"])?;
        Some(!status.is_empty())
    }

    /// Re-run when HEAD moves (checkout, commit, reset, pull). Editing files does not re-run the
    /// script, so a plain `cargo build` may keep an outdated dirty flag until HEAD changes; the
    /// build scripts pass the flag explicitly for that reason.
    fn watch_head(&self) {
        if let Some(git_dir) = self.run(&["rev-parse", "--git-dir"]) {
            rerun_if_exists(&self.dir.join(git_dir).join("HEAD"));
        }
        let Some(common_dir) = self.run(&["rev-parse", "--git-common-dir"]) else {
            return;
        };
        let common_dir = self.dir.join(common_dir);
        rerun_if_exists(&common_dir.join("packed-refs"));
        if let Some(reference) = self.run(&["symbolic-ref", "--quiet", "HEAD"]) {
            rerun_if_exists(&common_dir.join(reference));
        }
    }
}

/// Cargo re-runs the script on every build while a watched path is missing, so only existing
/// files are watched.
fn rerun_if_exists(path: &Path) {
    if path.exists() {
        println!("cargo::rerun-if-changed={}", path.display());
    }
}
