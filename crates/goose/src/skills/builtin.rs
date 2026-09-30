use include_dir::{include_dir, Dir};
use std::collections::HashMap;
use std::io;
use std::path::Path;
use std::sync::OnceLock;

static BUILTIN_SKILLS_DIR: Dir = include_dir!("$CARGO_MANIFEST_DIR/src/skills/builtins");

/// Stamped into the extracted tree so a stale copy is replaced on the next run
/// when the bundled assets change.
///
/// "2": the contest problems under `math_modeling/assets/examples/` were removed, so
/// trees extracted by earlier builds are rewritten without them.
/// "3": `mathmodel_mock_review/` (manifest and output schema of the mock review skill) was
/// added; a tree stamped "2" would otherwise never receive it, because extraction is
/// skipped while the stamp matches.
const BUILTIN_ASSETS_VERSION: &str = "3";

/// Outcome of the single extraction attempt this process makes.
static EXTRACTED: OnceLock<Result<(), String>> = OnceLock::new();

pub fn get_all() -> Vec<&'static str> {
    BUILTIN_SKILLS_DIR
        .files()
        .filter(|f| f.path().extension().is_some_and(|ext| ext == "md"))
        .filter_map(|f| f.contents_utf8())
        .collect()
}

/// Write the bundled skill assets to `dest`.
///
/// Skill instructions reference their own files by relative path (for example
/// `scripts/check_environment.py`). Those files are compiled into the binary, so
/// without extracting them here a skill can be loaded but its scripts and
/// references can neither be read nor executed.
///
/// The tree is ~200MB, so it is written at most once per process: test cases
/// each point `GOOSE_PATH_ROOT` at a fresh temp directory, and re-extracting for
/// every one of them would swamp the suite.
pub fn materialize_assets(dest: &Path) -> io::Result<()> {
    match EXTRACTED.get_or_init(|| extract(dest).map_err(|error| error.to_string())) {
        Ok(()) => Ok(()),
        Err(message) => Err(io::Error::other(message.clone())),
    }
}

fn extract(dest: &Path) -> io::Result<()> {
    extract_tree(&BUILTIN_SKILLS_DIR, dest)
}

fn extract_tree(tree: &Dir<'_>, dest: &Path) -> io::Result<()> {
    let stamp = dest.join(".assets-version");
    if std::fs::read_to_string(&stamp).is_ok_and(|v| v.trim() == BUILTIN_ASSETS_VERSION) {
        return Ok(());
    }

    // `Dir::extract` refuses to overwrite, so clear any stale or partial tree first.
    if dest.exists() {
        std::fs::remove_dir_all(dest)?;
    }
    // `Dir::extract` creates the subdirectories it meets but not `dest` itself, and writes the
    // files at the root of the tree straight into it. On Windows the build lists entries
    // alphabetically, so the tree starts with `abstract_and_conclusion.md`: without this, every
    // fresh profile failed with "path not found" and no skill had its scripts or templates.
    std::fs::create_dir_all(dest)?;
    tree.extract(dest)?;
    std::fs::write(stamp, BUILTIN_ASSETS_VERSION)
}

/// Skill name → absolute paths of its supporting files.
///
/// Built once per process. The bundled tree cannot change while the process
/// runs, and skill discovery consults this on every lookup — walking ~790 files
/// per call made the test suite crawl.
pub fn supporting_file_index(dest: &Path) -> &'static HashMap<String, Vec<String>> {
    static INDEX: OnceLock<HashMap<String, Vec<String>>> = OnceLock::new();

    INDEX.get_or_init(|| {
        let mut index = HashMap::new();
        let Ok(entries) = std::fs::read_dir(dest) else {
            return index;
        };
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let Some(name) = dir.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            let mut files = Vec::new();
            collect_files(&dir, &mut files);
            if !files.is_empty() {
                index.insert(name.to_string(), files);
            }
        }
        index
    })
}

fn collect_files(dir: &Path, files: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, files);
        } else if path.is_file() {
            files.push(path.to_string_lossy().into_owned());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use include_dir::{DirEntry, File};
    use std::path::PathBuf;

    /// Shaped like the bundled tree: a file at the root comes before any directory.
    static FILE_FIRST_TREE: Dir<'static> = Dir::new(
        "",
        &[
            DirEntry::File(File::new("abstract_and_conclusion.md", b"root skill")),
            DirEntry::Dir(Dir::new(
                "data_search",
                &[DirEntry::Dir(Dir::new(
                    "data_search/scripts",
                    &[DirEntry::File(File::new(
                        "data_search/scripts/search.py",
                        b"print('ok')",
                    ))],
                ))],
            )),
        ],
    );

    #[test]
    fn extracts_into_a_directory_that_does_not_exist_yet() {
        let temp = tempfile::tempdir().unwrap();
        // A fresh profile has neither the data directory nor `builtin-skills` under it.
        let dest = temp.path().join("data").join("builtin-skills");

        extract_tree(&FILE_FIRST_TREE, &dest).unwrap();

        assert_eq!(
            std::fs::read(dest.join("abstract_and_conclusion.md")).unwrap(),
            b"root skill"
        );
        assert_eq!(
            std::fs::read(dest.join("data_search").join("scripts").join("search.py")).unwrap(),
            b"print('ok')"
        );
        assert_eq!(
            std::fs::read_to_string(dest.join(".assets-version")).unwrap(),
            BUILTIN_ASSETS_VERSION
        );

        // With the stamp in place a later start leaves the tree alone.
        extract_tree(&FILE_FIRST_TREE, &dest).unwrap();
    }

    fn collect_bundled(dir: &Dir<'_>, files: &mut Vec<PathBuf>) {
        for file in dir.files() {
            files.push(file.path().to_path_buf());
        }
        for sub in dir.dirs() {
            collect_bundled(sub, files);
        }
    }

    /// Contest statements, attachments and result files are the organisers' copyright
    /// (spec requirements 9.6, 7.1). Everything under `builtins/` is compiled into goose,
    /// so none of it may sit under `math_modeling/assets/examples/`; local study copies
    /// live in the desktop app's git-ignored `resources/builtin-examples/`.
    #[test]
    fn contest_examples_are_not_compiled_in() {
        let examples = Path::new("math_modeling/assets/examples");
        let mut files = Vec::new();
        collect_bundled(&BUILTIN_SKILLS_DIR, &mut files);
        assert!(!files.is_empty(), "no builtin skills bundled");

        let bundled: Vec<&PathBuf> = files
            .iter()
            .filter(|path| path.starts_with(examples))
            .collect();
        assert!(
            bundled.is_empty(),
            "contest material compiled into goose: {bundled:?}"
        );
        assert!(BUILTIN_SKILLS_DIR.get_dir(examples).is_none());
    }
}
