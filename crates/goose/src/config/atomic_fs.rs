//! Atomic file replacement for configuration writers (requirement 2.6; used by the credential
//! transactions of requirement 1): the contents go to a temporary file in the target's directory,
//! are flushed to disk, and the temporary file is then persisted over the target. Readers see
//! either the complete old file or the complete new one, and a failed write leaves the target
//! untouched with no temporary file behind.

use std::io::{self, Write};
use std::path::Path;
use std::thread;
use std::time::Duration;

pub trait AtomicFs {
    fn write_atomic(&self, target: &Path, contents: &[u8]) -> io::Result<()>;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct StdAtomicFs;

impl AtomicFs for StdAtomicFs {
    fn write_atomic(&self, target: &Path, contents: &[u8]) -> io::Result<()> {
        write_atomic(target, contents)
    }
}

/// Windows reports a denied rename while an antivirus scanner or indexer briefly holds the
/// target; the rename is retried a few times before giving up.
const PERSIST_RETRIES: usize = 3;
const PERSIST_RETRY_DELAY: Duration = Duration::from_millis(50);

pub fn write_atomic(target: &Path, contents: &[u8]) -> io::Result<()> {
    let dir = match target.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };
    let mut temp = tempfile::Builder::new()
        .prefix(".goose-write-")
        .suffix(".tmp")
        .tempfile_in(dir)?;
    temp.write_all(contents)?;
    temp.as_file().sync_all()?;

    let mut attempt = 0;
    loop {
        match temp.persist(target) {
            Ok(_) => return Ok(()),
            Err(error)
                if error.error.kind() == io::ErrorKind::PermissionDenied
                    && attempt < PERSIST_RETRIES =>
            {
                attempt += 1;
                temp = error.file;
                thread::sleep(PERSIST_RETRY_DELAY);
            }
            // Dropping the returned temporary file deletes it.
            Err(error) => return Err(error.error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn entries(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn replaces_the_target_without_leaving_temporary_files() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("密钥 配置.json");
        fs::write(&target, b"{\"version\":1}").unwrap();

        StdAtomicFs
            .write_atomic(&target, b"{\"version\":2}")
            .unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"{\"version\":2}");
        assert_eq!(entries(dir.path()), vec!["密钥 配置.json".to_string()]);
    }

    #[test]
    fn creates_a_missing_target() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("custom_provider.json");

        write_atomic(&target, b"{}").unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"{}");
        assert_eq!(
            entries(dir.path()),
            vec!["custom_provider.json".to_string()]
        );
    }

    #[test]
    fn fails_without_side_effects_when_the_directory_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("missing").join("config.json");

        assert!(write_atomic(&target, b"{}").is_err());
        assert!(entries(dir.path()).is_empty());
    }
}
