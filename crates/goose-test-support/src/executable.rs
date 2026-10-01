//! Executable fixtures (fake CLIs, hook scripts) that a test runs right after writing them.

use std::io;
use std::path::Path;

/// Writes `contents` to `path` as an executable script (mode 0o755 on Unix) that can be
/// exec'd as soon as this returns.
///
/// `fs::write` followed by `chmod` is racy in a multi-threaded test binary: while this
/// process holds `path` open for writing, a sibling test may fork to spawn a subprocess,
/// and the child keeps a copy of that descriptor until it reaches `exec`. Exec'ing `path`
/// in that window fails with ETXTBSY ("Text file busy", os error 26). Writing a temporary
/// file and renaming it into place does not help, because the inherited descriptor still
/// refers to the same inode. Here the bytes go to a staging file and `cp` creates `path`,
/// so the only process that ever opens `path` for writing is that `cp`, which never forks
/// and has exited by the time this returns.
#[cfg(unix)]
pub fn write_executable_script(path: &Path, contents: impl AsRef<[u8]>) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    use std::process::{Command, Stdio};

    let file_name = path.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{} has no file name", path.display()),
        )
    })?;
    let mut staging_name = file_name.to_os_string();
    staging_name.push(".staging");
    let staging = path.with_file_name(staging_name);

    std::fs::write(&staging, contents)?;
    let copied = Command::new("cp")
        .arg(&staging)
        .arg(path)
        .stdin(Stdio::null())
        .status();
    let removed = std::fs::remove_file(&staging);
    let status = copied?;
    if !status.success() {
        return Err(io::Error::other(format!(
            "cp to {} exited with {status}",
            path.display()
        )));
    }
    removed?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
}

/// Windows runs scripts through their interpreter and does not hand this process's file
/// handles to children, so a plain write is enough there.
#[cfg(not(unix))]
pub fn write_executable_script(path: &Path, contents: impl AsRef<[u8]>) -> io::Result<()> {
    std::fs::write(path, contents)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;

    /// A fresh directory under the system temp dir, removed on drop.
    struct ScratchDir(PathBuf);

    impl ScratchDir {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let dir = std::env::temp_dir().join(format!(
                "goose-test-support-executable-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for ScratchDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn writes_an_executable_script_without_leaving_the_staging_file() {
        let dir = ScratchDir::new();
        let script = dir.0.join("fake-cli");

        write_executable_script(&script, "#!/bin/sh\nprintf 'ran:%s' \"$1\"\n").unwrap();

        let mode = std::fs::metadata(&script).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o755);
        let names: Vec<_> = std::fs::read_dir(&dir.0)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("fake-cli")]);
        let output = Command::new(&script).arg("x").output().unwrap();
        assert_eq!(String::from_utf8_lossy(&output.stdout), "ran:x");
    }

    #[test]
    fn rewriting_replaces_the_contents() {
        let dir = ScratchDir::new();
        let script = dir.0.join("fake-cli");

        write_executable_script(&script, "#!/bin/sh\necho first\n").unwrap();
        write_executable_script(&script, "#!/bin/sh\necho second\n").unwrap();

        let output = Command::new(&script).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&output.stdout), "second\n");
    }

    #[test]
    fn scripts_run_at_once_while_other_threads_keep_spawning() {
        // Sibling threads that fork all the time are what made `fs::write` + exec fail
        // with ETXTBSY; every script written by the helper must run on the first try.
        let stop = Arc::new(AtomicBool::new(false));
        let spawners: Vec<_> = (0..4)
            .map(|_| {
                let stop = Arc::clone(&stop);
                std::thread::spawn(move || {
                    while !stop.load(Ordering::Relaxed) {
                        let _ = Command::new("true")
                            .stdin(Stdio::null())
                            .stdout(Stdio::null())
                            .stderr(Stdio::null())
                            .status();
                    }
                })
            })
            .collect();

        let dir = ScratchDir::new();
        let outputs: io::Result<Vec<(String, String)>> = (0..50)
            .map(|i| {
                let script = dir.0.join(format!("script-{i}"));
                write_executable_script(&script, format!("#!/bin/sh\necho {i}\n"))?;
                let output = Command::new(&script).stdin(Stdio::null()).output()?;
                Ok((
                    format!("{i}\n"),
                    String::from_utf8_lossy(&output.stdout).into_owned(),
                ))
            })
            .collect();

        // Stop the spawners before asserting, so a failure does not leave them running.
        stop.store(true, Ordering::Relaxed);
        for spawner in spawners {
            spawner.join().unwrap();
        }
        for (expected, actual) in outputs.unwrap() {
            assert_eq!(actual, expected);
        }
    }
}
