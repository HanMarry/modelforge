use include_dir::{include_dir, Dir};
use std::io;
use std::path::Path;

static BUILTIN_SKILLS_DIR: Dir = include_dir!("$CARGO_MANIFEST_DIR/src/skills/builtins");

/// Stamped into the extracted tree so a stale copy is replaced on the next run
/// when the bundled assets change.
const BUILTIN_ASSETS_VERSION: &str = "1";

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
pub fn materialize_assets(dest: &Path) -> io::Result<()> {
    let stamp = dest.join(".assets-version");
    if std::fs::read_to_string(&stamp).is_ok_and(|v| v.trim() == BUILTIN_ASSETS_VERSION) {
        return Ok(());
    }

    // `Dir::extract` refuses to overwrite, so clear any stale or partial tree first.
    if dest.exists() {
        std::fs::remove_dir_all(dest)?;
    }
    BUILTIN_SKILLS_DIR.extract(dest)?;
    std::fs::write(stamp, BUILTIN_ASSETS_VERSION)
}
