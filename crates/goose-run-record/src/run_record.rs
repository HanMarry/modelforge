//! Run_Record (spec mathmodel-parity-and-beyond, requirement 16): one execution of computation
//! code inside a Project, stored as `<project>/.modelforge/runs/<run_id>.json`.
//!
//! The contract is `schemas/run-record.schema.json`. The desktop reads these files with
//! `ui/desktop/src/utils/runRecord.ts`; both sides implement the same checks and are tested
//! against `fixtures/run-record-vectors.json`, so a record one side writes reads back unchanged
//! on the other (Property 36).
//!
//! This module owns the data type, its validation, run id allocation, the atomic write and the
//! credential redaction (Property 37). Measuring a run (hashing inputs, spotting outputs) belongs
//! to the recorder that wraps the execution tools.

use std::fmt::Display;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use anyhow::{anyhow, bail, Context, Result};
use chrono::{DateTime, SecondsFormat, TimeZone};
use serde::{Deserialize, Deserializer, Serialize};

pub const RUN_RECORD_SCHEMA_VERSION: u32 = 1;
/// Inputs and outputs are each capped at this many entries (requirement 16.1).
pub const MAX_RECORDED_FILES: usize = 1000;
/// The seed value recorded when the code set no seed.
pub const SEED_UNSET: &str = "未设置";

const RUN_ID_SUFFIX_LEN: usize = 6;
const RUN_ID_ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
/// Collisions need the same millisecond and the same 6 random characters; a handful of retries
/// is already generous.
const MAX_RUN_ID_ATTEMPTS: usize = 16;

/// Why an execution did not succeed (requirement 16.3). Serialized with the Chinese names the
/// desktop displays.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RunFailure {
    #[serde(rename = "非零退出码")]
    NonZeroExit,
    #[serde(rename = "超时")]
    Timeout,
    #[serde(rename = "用户取消")]
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileHash {
    /// Project-relative path with `/` separators.
    pub path: String,
    /// Lowercase hexadecimal SHA-256, 64 characters.
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunConfig {
    pub provider: String,
    pub model: String,
    pub runtime: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Dependency {
    pub name: String,
    pub version: String,
}

/// Field names and order match the schema; `serde_json::to_string_pretty` of this struct is
/// byte-for-byte the layout the desktop's `serializeRunRecord` produces.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub schema_version: u32,
    /// `YYYYMMDDTHHMMSSmmm-<6 random [0-9a-z]>`, unique inside the Project.
    pub run_id: String,
    /// At most 1000, in discovery order.
    pub inputs: Vec<FileHash>,
    /// True when more than 1000 inputs were found; `inputs` then holds exactly 1000.
    pub inputs_truncated: bool,
    pub code: FileHash,
    pub config: RunConfig,
    pub command: String,
    pub dependencies: Vec<Dependency>,
    /// The seed as given, or [`SEED_UNSET`].
    pub seed: String,
    /// `None` after a timeout or a user cancellation. Required in JSON, `null` allowed.
    #[serde(deserialize_with = "required_nullable")]
    pub exit_code: Option<i32>,
    /// `None` exactly when `exit_code` is `Some(0)`. May be absent in JSON.
    #[serde(default)]
    pub failure: Option<RunFailure>,
    /// ISO 8601 with milliseconds and offset, see [`format_timestamp`].
    pub started_at: String,
    pub ended_at: String,
    /// At most 1000.
    pub outputs: Vec<FileHash>,
    pub outputs_truncated: bool,
}

/// Makes an `Option` field required: without `deserialize_with`, serde reads a missing `Option`
/// field as `None`, but the schema requires `exitCode` to be present.
fn required_nullable<'de, D, T>(deserializer: D) -> std::result::Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

impl RunRecord {
    /// Parses and validates one Run_Record file.
    pub fn from_json(text: &str) -> Result<Self> {
        let record: RunRecord = serde_json::from_str(text).context("parsing Run_Record")?;
        let problems = record.problems();
        if !problems.is_empty() {
            bail!("invalid Run_Record fields: {}", problems.join(", "));
        }
        Ok(record)
    }

    /// Pretty-printed JSON with a trailing newline.
    pub fn to_json(&self) -> Result<String> {
        let mut text = serde_json::to_string_pretty(self).context("serializing Run_Record")?;
        text.push('\n');
        Ok(text)
    }

    /// Fields that break the contract, named like the desktop names them (`runId`,
    /// `inputs[3].path`). Type errors and missing fields are already rejected by serde; these
    /// are the checks serde cannot express. Empty for a valid record.
    pub fn problems(&self) -> Vec<String> {
        let mut invalid = Vec::new();
        if self.schema_version != RUN_RECORD_SCHEMA_VERSION {
            invalid.push("schemaVersion".to_string());
        }
        if !is_run_id(&self.run_id) {
            invalid.push("runId".to_string());
        }
        let inputs_valid = check_file_list(&self.inputs, "inputs", &mut invalid);
        check_file_hash(&self.code, "code", &mut invalid);
        match (self.failure, self.exit_code) {
            (None, Some(0)) => {}
            (None, _) => invalid.push("failure".to_string()),
            (Some(RunFailure::NonZeroExit), Some(code)) if code != 0 => {}
            (Some(RunFailure::Timeout | RunFailure::Cancelled), None) => {}
            (Some(_), _) => invalid.push("exitCode".to_string()),
        }
        if !is_run_timestamp(&self.started_at) {
            invalid.push("startedAt".to_string());
        }
        if !is_run_timestamp(&self.ended_at) {
            invalid.push("endedAt".to_string());
        }
        let outputs_valid = check_file_list(&self.outputs, "outputs", &mut invalid);
        // A truncated list holds exactly the cap.
        if inputs_valid && self.inputs_truncated && self.inputs.len() != MAX_RECORDED_FILES {
            invalid.push("inputsTruncated".to_string());
        }
        if outputs_valid && self.outputs_truncated && self.outputs.len() != MAX_RECORDED_FILES {
            invalid.push("outputsTruncated".to_string());
        }
        invalid
    }
}

fn check_file_hash(file: &FileHash, field: &str, invalid: &mut Vec<String>) -> bool {
    let mut valid = true;
    if !is_project_relative_path(&file.path) {
        invalid.push(format!("{field}.path"));
        valid = false;
    }
    if !is_sha256(&file.sha256) {
        invalid.push(format!("{field}.sha256"));
        valid = false;
    }
    valid
}

fn check_file_list(files: &[FileHash], field: &str, invalid: &mut Vec<String>) -> bool {
    if files.len() > MAX_RECORDED_FILES {
        invalid.push(field.to_string());
        return false;
    }
    let mut valid = true;
    for (index, file) in files.iter().enumerate() {
        valid &= check_file_hash(file, &format!("{field}[{index}]"), invalid);
    }
    valid
}

pub fn is_run_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 8 + 1 + 9 + 1 + RUN_ID_SUFFIX_LEN
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 => *byte == b'T',
            18 => *byte == b'-',
            0..=17 => byte.is_ascii_digit(),
            _ => byte.is_ascii_digit() || byte.is_ascii_lowercase(),
        })
}

pub fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// A path that stays inside the Project: not absolute, no drive letter, no NUL and no `..`
/// segment. Backslashes are legal file name characters on POSIX, so they are allowed, but they
/// count as separators when looking for `..`.
pub fn is_project_relative_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.contains(&0) {
        return false;
    }
    if matches!(bytes.first(), Some(b'/' | b'\\')) {
        return false;
    }
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return false;
    }
    !value.split(['/', '\\']).any(|segment| segment == "..")
}

/// The decimal number in `bytes[start..start + len]`, if all of it is ASCII digits.
fn digits(bytes: &[u8], start: usize, len: usize) -> Option<u32> {
    let mut value = 0u32;
    for byte in bytes.get(start..start + len)? {
        if !byte.is_ascii_digit() {
            return None;
        }
        value = value * 10 + u32::from(byte - b'0');
    }
    Some(value)
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        2 if (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400) => {
            29
        }
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// ISO 8601 with exactly three fractional digits and an offset (`Z` or `±HH:MM`), checked field
/// by field the same way the desktop checks it.
pub fn is_run_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    let separators = [
        (4, b'-'),
        (7, b'-'),
        (10, b'T'),
        (13, b':'),
        (16, b':'),
        (19, b'.'),
    ];
    if !separators
        .iter()
        .all(|(index, expected)| bytes.get(*index) == Some(expected))
    {
        return false;
    }
    let fields = (
        digits(bytes, 0, 4),
        digits(bytes, 5, 2),
        digits(bytes, 8, 2),
        digits(bytes, 11, 2),
        digits(bytes, 14, 2),
        digits(bytes, 17, 2),
        digits(bytes, 20, 3),
    );
    let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second), Some(_)) =
        fields
    else {
        return false;
    };
    let offset_valid = match bytes.get(23..) {
        Some(b"Z") => true,
        Some([sign, _, _, b':', _, _]) if *sign == b'+' || *sign == b'-' => {
            matches!(
                (digits(bytes, 24, 2), digits(bytes, 27, 2)),
                (Some(hours), Some(minutes)) if hours <= 23 && minutes <= 59
            )
        }
        _ => false,
    };
    offset_valid
        && (1..=12).contains(&month)
        && day >= 1
        && day <= days_in_month(year, month)
        && hour <= 23
        && minute <= 59
        && second <= 59
}

/// `2026-09-20T10:15:30.123+08:00`; UTC is written as `+00:00`.
pub fn format_timestamp<Tz: TimeZone>(at: &DateTime<Tz>) -> String
where
    Tz::Offset: Display,
{
    at.to_rfc3339_opts(SecondsFormat::Millis, false)
}

/// `YYYYMMDDTHHMMSSmmm-<suffix>` for a run that started at `started_at`.
pub fn run_id_for<Tz: TimeZone>(started_at: &DateTime<Tz>, suffix: &str) -> String
where
    Tz::Offset: Display,
{
    format!("{}-{suffix}", started_at.format("%Y%m%dT%H%M%S%3f"))
}

fn random_suffix() -> String {
    use rand::RngExt;
    let mut rng = rand::rng();
    (0..RUN_ID_SUFFIX_LEN)
        .map(|_| char::from(RUN_ID_ALPHABET[rng.random_range(0..RUN_ID_ALPHABET.len())]))
        .collect()
}

pub fn new_run_id<Tz: TimeZone>(started_at: &DateTime<Tz>) -> String
where
    Tz::Offset: Display,
{
    run_id_for(started_at, &random_suffix())
}

/// `<project>/.modelforge/runs`.
pub fn runs_dir(project_root: &Path) -> PathBuf {
    project_root.join(".modelforge").join("runs")
}

fn record_path(dir: &Path, run_id: &str) -> PathBuf {
    dir.join(format!("{run_id}.json"))
}

/// A run id that no record in the Project uses yet, for a run that starts now. The write in
/// [`persist_run_record`] still guards against a record appearing in between.
pub fn allocate_run_id<Tz: TimeZone>(project_root: &Path, started_at: &DateTime<Tz>) -> String
where
    Tz::Offset: Display,
{
    let dir = runs_dir(project_root);
    let mut run_id = new_run_id(started_at);
    for _ in 1..MAX_RUN_ID_ATTEMPTS {
        if fs::symlink_metadata(record_path(&dir, &run_id)).is_err() {
            break;
        }
        run_id = new_run_id(started_at);
    }
    run_id
}

/// Writes `record` to `<project>/.modelforge/runs/<run_id>.json` atomically: a temporary file in
/// the same directory, flushed to disk, then moved into place without replacing anything. If the
/// name is taken, the random suffix is drawn again, keeping the time prefix. Returns the record
/// as written (its `run_id` may have changed) and the file path.
///
/// Readers only ever see complete files, so a crash at any point leaves either no record or a
/// whole one (requirement 22.4). Temporary files start with `.run-` and end in `.tmp`.
pub fn persist_run_record(project_root: &Path, record: RunRecord) -> Result<(RunRecord, PathBuf)> {
    persist_with(project_root, record, random_suffix, &mut NoWriteFaults)
}

/// Points inside the atomic write of [`persist_run_record`]. Tests stop the writer at one of them
/// to see what a process killed at that moment leaves on disk (Property 51).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WriteStage {
    /// The temporary file exists and is empty.
    TempCreated,
    /// Half of the record is in the temporary file.
    HalfWritten,
    /// The whole record is in the temporary file, not yet flushed.
    Written,
    /// The temporary file is on disk but still has its temporary name.
    Synced,
    /// The record has its final name; the writer has not returned yet.
    Renamed,
}

/// Decides where the writer stops. Production code never stops ([`NoWriteFaults`]).
pub(crate) trait WriteFaults {
    /// True stops the writer at `stage` as if the process died there: nothing is cleaned up.
    fn stop_at(&mut self, stage: WriteStage) -> bool;
}

pub(crate) struct NoWriteFaults;

impl WriteFaults for NoWriteFaults {
    fn stop_at(&mut self, _stage: WriteStage) -> bool {
        false
    }
}

/// Returned by a writer that [`WriteFaults`] stopped.
#[derive(Debug)]
pub(crate) struct SimulatedCrash(pub WriteStage);

impl Display for SimulatedCrash {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "writer stopped at {:?}", self.0)
    }
}

impl std::error::Error for SimulatedCrash {}

/// [`persist_run_record`] with injectable stops, for crash tests.
pub(crate) fn persist_run_record_with_faults(
    project_root: &Path,
    record: RunRecord,
    faults: &mut dyn WriteFaults,
) -> Result<(RunRecord, PathBuf)> {
    persist_with(project_root, record, random_suffix, faults)
}

/// Leaves the temporary file where it is, the way a killed process would, and reports the stop.
fn abandon(temp: tempfile::NamedTempFile, stage: WriteStage) -> anyhow::Error {
    let _ = temp.keep();
    anyhow::Error::new(SimulatedCrash(stage))
}

#[cfg(test)]
fn persist_with_suffixes(
    project_root: &Path,
    record: RunRecord,
    next_suffix: impl FnMut() -> String,
) -> Result<(RunRecord, PathBuf)> {
    persist_with(project_root, record, next_suffix, &mut NoWriteFaults)
}

fn persist_with(
    project_root: &Path,
    mut record: RunRecord,
    mut next_suffix: impl FnMut() -> String,
    faults: &mut dyn WriteFaults,
) -> Result<(RunRecord, PathBuf)> {
    let problems = record.problems();
    if !problems.is_empty() {
        bail!(
            "refusing to write an invalid Run_Record ({})",
            problems.join(", ")
        );
    }
    let prefix = record
        .run_id
        .split_once('-')
        .map(|(prefix, _)| prefix.to_string())
        .ok_or_else(|| anyhow!("run id {} has no suffix", record.run_id))?;
    let dir = runs_dir(project_root);
    fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;

    for attempt in 0..MAX_RUN_ID_ATTEMPTS {
        if attempt > 0 {
            record.run_id = format!("{prefix}-{}", next_suffix());
            if !is_run_id(&record.run_id) {
                bail!("generated an invalid run id {}", record.run_id);
            }
        }
        let target = record_path(&dir, &record.run_id);
        if fs::symlink_metadata(&target).is_ok() {
            continue;
        }
        let body = record.to_json()?;
        // Written in two halves only so a crash test can stop in between.
        let (head, rest) = body.as_bytes().split_at(body.len() / 2);
        let mut temp = tempfile::Builder::new()
            .prefix(".run-")
            .suffix(".tmp")
            .tempfile_in(&dir)
            .with_context(|| format!("creating a temporary file in {}", dir.display()))?;
        if faults.stop_at(WriteStage::TempCreated) {
            return Err(abandon(temp, WriteStage::TempCreated));
        }
        temp.write_all(head)
            .with_context(|| format!("writing {}", temp.path().display()))?;
        if faults.stop_at(WriteStage::HalfWritten) {
            return Err(abandon(temp, WriteStage::HalfWritten));
        }
        temp.write_all(rest)
            .with_context(|| format!("writing {}", temp.path().display()))?;
        if faults.stop_at(WriteStage::Written) {
            return Err(abandon(temp, WriteStage::Written));
        }
        temp.as_file()
            .sync_all()
            .with_context(|| format!("flushing {}", temp.path().display()))?;
        if faults.stop_at(WriteStage::Synced) {
            return Err(abandon(temp, WriteStage::Synced));
        }
        match temp.persist_noclobber(&target) {
            Ok(_) => {
                sync_dir(&dir);
                if faults.stop_at(WriteStage::Renamed) {
                    return Err(anyhow::Error::new(SimulatedCrash(WriteStage::Renamed)));
                }
                return Ok((record, target));
            }
            // Someone else took the name between the check and the move; the temporary file
            // is removed when `error` drops.
            Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(anyhow::Error::new(error.error)
                    .context(format!("moving the Run_Record to {}", target.display())))
            }
        }
    }
    bail!(
        "no free run id after {MAX_RUN_ID_ATTEMPTS} attempts in {}",
        dir.display()
    )
}

/// Makes the rename itself durable. Windows cannot open a directory for flushing.
#[cfg(unix)]
fn sync_dir(dir: &Path) {
    if let Ok(handle) = fs::File::open(dir) {
        let _ = handle.sync_all();
    }
}

#[cfg(not(unix))]
fn sync_dir(_dir: &Path) {}

/// Deletes the temporary files a writer killed mid-write left in `<project>/.modelforge/runs`,
/// once they are at least `older_than` old; younger ones may belong to a write in progress.
/// Readers never take these files for records, this only keeps the directory clean. Returns how
/// many were removed.
pub fn remove_orphaned_temp_files(project_root: &Path, older_than: Duration) -> usize {
    let Ok(entries) = fs::read_dir(runs_dir(project_root)) else {
        return 0;
    };
    let now = SystemTime::now();
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let is_temp = name
            .to_str()
            .is_some_and(|name| name.starts_with(".run-") && name.ends_with(".tmp"));
        if !is_temp {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let age = metadata
            .modified()
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .unwrap_or_default();
        if age >= older_than && fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// A Credential_Store entry: the credential value and the Secret_Reference (`${secret:<key>}`)
/// written in its place.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretValue {
    pub reference: String,
    pub value: String,
}

/// Replaces every Credential_Store value in the command, the dependency summary, the model and
/// runtime identifiers and the seed with its Secret_Reference (requirement 16.2). Paths and
/// hashes identify files and are left alone.
///
/// One left-to-right pass that prefers the longest value at each position, so a value that
/// contains another is replaced whole and inserted references are never scanned again.
pub fn redact_run_record(mut record: RunRecord, secrets: &[SecretValue]) -> RunRecord {
    let mut ordered: Vec<&SecretValue> = secrets
        .iter()
        .filter(|secret| !secret.value.is_empty())
        .collect();
    if ordered.is_empty() {
        return record;
    }
    ordered.sort_by_key(|secret| std::cmp::Reverse(secret.value.len()));

    let redact = |text: &mut String| {
        if let Some(redacted) = redact_text(text, &ordered) {
            *text = redacted;
        }
    };
    redact(&mut record.command);
    redact(&mut record.seed);
    redact(&mut record.config.provider);
    redact(&mut record.config.model);
    redact(&mut record.config.runtime);
    for dependency in &mut record.dependencies {
        redact(&mut dependency.name);
        redact(&mut dependency.version);
    }
    record
}

/// `None` when `text` holds no value, which is the common case and allocates nothing.
fn redact_text(text: &str, secrets: &[&SecretValue]) -> Option<String> {
    if !secrets
        .iter()
        .any(|secret| text.contains(secret.value.as_str()))
    {
        return None;
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    'scan: while !rest.is_empty() {
        for secret in secrets {
            if let Some(after) = rest.strip_prefix(secret.value.as_str()) {
                out.push_str(&secret.reference);
                rest = after;
                continue 'scan;
            }
        }
        let mut chars = rest.chars();
        if let Some(next) = chars.next() {
            out.push(next);
        }
        rest = chars.as_str();
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{FixedOffset, Timelike, Utc};
    use proptest::prelude::*;
    use serde_json::Value;

    fn repo_file(relative: &str) -> Value {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(relative);
        let raw = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("reading {}: {error}", path.display()));
        serde_json::from_str(&raw).unwrap_or_else(|error| panic!("{relative}: {error}"))
    }

    fn sample() -> RunRecord {
        RunRecord {
            schema_version: 1,
            run_id: "20260920T101530123-a1b2c3".to_string(),
            inputs: vec![FileHash {
                path: "data/附件1.xlsx".to_string(),
                sha256: "a".repeat(64),
            }],
            inputs_truncated: false,
            code: FileHash {
                path: "code/问题一.py".to_string(),
                sha256: "b".repeat(64),
            },
            config: RunConfig {
                provider: "openai".to_string(),
                model: "gpt-4o".to_string(),
                runtime: "python 3.12.4".to_string(),
            },
            command: "python \"code/问题一.py\"".to_string(),
            dependencies: vec![Dependency {
                name: "numpy".to_string(),
                version: "1.26.4".to_string(),
            }],
            seed: SEED_UNSET.to_string(),
            exit_code: Some(0),
            failure: None,
            started_at: "2026-09-20T10:15:30.123+08:00".to_string(),
            ended_at: "2026-09-20T10:15:31.456+08:00".to_string(),
            outputs: vec![FileHash {
                path: "results/q1.csv".to_string(),
                sha256: "c".repeat(64),
            }],
            outputs_truncated: false,
        }
    }

    fn sorted(mut values: Vec<String>) -> Vec<String> {
        values.sort();
        values
    }

    fn file_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn serialized_fields_match_the_schema_in_order() {
        let schema = repo_file("schemas/run-record.schema.json");
        let properties: Vec<&str> = schema["properties"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        let json = sample().to_json().unwrap();
        let value: Value = serde_json::from_str(&json).unwrap();
        let mut written: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        let mut expected = properties;
        written.sort_unstable();
        expected.sort_unstable();
        assert_eq!(written, expected);

        // Top-level keys are the only ones indented by two spaces in the pretty output. The
        // schema object keeps its declaration order only with serde_json's preserve_order, so
        // compare against the documented order instead.
        let order = [
            "schemaVersion",
            "runId",
            "inputs",
            "inputsTruncated",
            "code",
            "config",
            "command",
            "dependencies",
            "seed",
            "exitCode",
            "failure",
            "startedAt",
            "endedAt",
            "outputs",
            "outputsTruncated",
        ];
        let positions: Vec<usize> = order
            .iter()
            .map(|key| json.find(&format!("\n  \"{key}\":")).unwrap())
            .collect();
        assert!(positions.windows(2).all(|pair| pair[0] < pair[1]), "{json}");
        assert!(json.ends_with("}\n"));

        let required: Vec<&str> = schema["required"]
            .as_array()
            .unwrap()
            .iter()
            .map(|key| key.as_str().unwrap())
            .collect();
        let expected_required: Vec<&str> = order
            .iter()
            .copied()
            .filter(|key| *key != "failure")
            .collect();
        assert_eq!(required, expected_required);
    }

    // Feature: mathmodel-parity-and-beyond, Property 36: Run_Record JSON 往返
    // Cross-language half: records generated on the desktop side read back unchanged here.
    #[test]
    fn shared_vectors_round_trip() {
        let vectors = repo_file("fixtures/run-record-vectors.json");
        let records = vectors["records"].as_array().unwrap();
        assert_eq!(records.len(), 100);
        for (index, value) in records.iter().enumerate() {
            let text = serde_json::to_string_pretty(value).unwrap();
            let record = RunRecord::from_json(&text)
                .unwrap_or_else(|error| panic!("record {index}: {error:#}"));
            assert_eq!(
                serde_json::to_value(&record).unwrap(),
                *value,
                "record {index}"
            );
            let again = RunRecord::from_json(&record.to_json().unwrap()).unwrap();
            assert_eq!(again, record, "record {index}");
        }
    }

    #[test]
    fn shared_invalid_vectors_are_rejected() {
        let vectors = repo_file("fixtures/run-record-vectors.json");
        for vector in vectors["invalid"].as_array().unwrap() {
            let name = vector["name"].as_str().unwrap();
            let text = serde_json::to_string(&vector["record"]).unwrap();
            assert!(RunRecord::from_json(&text).is_err(), "{name} was accepted");
            // Where serde accepts the shape, the semantic checks name the same fields as the
            // desktop does.
            if let Ok(record) = serde_json::from_str::<RunRecord>(&text) {
                let expected: Vec<String> = vector["invalid"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|field| field.as_str().unwrap().to_string())
                    .collect();
                assert!(vector["missing"].as_array().unwrap().is_empty(), "{name}");
                assert_eq!(sorted(record.problems()), sorted(expected), "{name}");
            }
        }
    }

    #[test]
    fn exit_code_is_required_but_failure_is_optional() {
        let mut value = serde_json::to_value(sample()).unwrap();
        value.as_object_mut().unwrap().remove("failure");
        let without_failure = serde_json::to_string(&value).unwrap();
        assert_eq!(RunRecord::from_json(&without_failure).unwrap(), sample());

        value.as_object_mut().unwrap().remove("exitCode");
        let without_exit_code = serde_json::to_string(&value).unwrap();
        assert!(RunRecord::from_json(&without_exit_code).is_err());
    }

    #[test]
    fn list_caps_and_truncation() {
        let mut over = sample();
        over.outputs = (0..=MAX_RECORDED_FILES)
            .map(|index| FileHash {
                path: format!("results/{index}.csv"),
                sha256: "c".repeat(64),
            })
            .collect();
        over.outputs_truncated = true;
        assert_eq!(over.problems(), vec!["outputs".to_string()]);

        let mut under = over.clone();
        under.outputs.truncate(MAX_RECORDED_FILES - 1);
        assert_eq!(under.problems(), vec!["outputsTruncated".to_string()]);

        let mut full = over;
        full.outputs.truncate(MAX_RECORDED_FILES);
        assert!(full.problems().is_empty());
    }

    #[test]
    fn run_ids_and_timestamps_have_the_documented_format() {
        let at = FixedOffset::east_opt(8 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 9, 20, 10, 15, 30)
            .unwrap()
            .with_nanosecond(123_000_000)
            .unwrap();
        assert_eq!(run_id_for(&at, "a1b2c3"), "20260920T101530123-a1b2c3");
        assert_eq!(format_timestamp(&at), "2026-09-20T10:15:30.123+08:00");
        assert_eq!(
            format_timestamp(&at.with_timezone(&Utc)),
            "2026-09-20T02:15:30.123+00:00"
        );
        assert!(is_run_timestamp(&format_timestamp(&at.with_timezone(&Utc))));

        let generated = new_run_id(&at);
        assert!(is_run_id(&generated), "{generated}");
        assert!(generated.starts_with("20260920T101530123-"));

        assert!(!is_run_timestamp("2026-02-29T10:15:30.123+08:00"));
        assert!(is_run_timestamp("2028-02-29T10:15:30.123Z"));
        assert!(!is_run_timestamp("2026-09-20T10:15:30.123+24:00"));
        assert!(!is_run_timestamp("2026-09-20T10:15:30.1234+08:00"));
    }

    #[test]
    fn persist_writes_one_complete_file_and_redraws_taken_names() {
        let project = tempfile::tempdir().unwrap();
        let (written, path) = persist_run_record(project.path(), sample()).unwrap();
        assert_eq!(written, sample());
        assert_eq!(
            path,
            runs_dir(project.path()).join("20260920T101530123-a1b2c3.json")
        );
        let text = fs::read_to_string(&path).unwrap();
        assert_eq!(text, sample().to_json().unwrap());

        // Same run id again: the first redraw collides with a record that already exists too.
        let taken = sample();
        let mut clash = taken.clone();
        clash.run_id = "20260920T101530123-zzzzzz".to_string();
        persist_run_record(project.path(), clash).unwrap();
        let mut suffixes = vec!["yyyyyy".to_string(), "zzzzzz".to_string()];
        let (second, second_path) =
            persist_with_suffixes(project.path(), taken, || suffixes.pop().unwrap()).unwrap();
        assert_eq!(second.run_id, "20260920T101530123-yyyyyy");
        assert_eq!(
            RunRecord::from_json(&fs::read_to_string(&second_path).unwrap()).unwrap(),
            second
        );

        // No temporary file is left behind.
        assert_eq!(
            file_names(&runs_dir(project.path())),
            vec![
                "20260920T101530123-a1b2c3.json".to_string(),
                "20260920T101530123-yyyyyy.json".to_string(),
                "20260920T101530123-zzzzzz.json".to_string(),
            ]
        );
    }

    #[test]
    fn persist_refuses_invalid_records() {
        let project = tempfile::tempdir().unwrap();
        let mut record = sample();
        record.exit_code = Some(1);
        let error = persist_run_record(project.path(), record).unwrap_err();
        assert!(error.to_string().contains("failure"), "{error:#}");
        assert!(!runs_dir(project.path()).exists());
    }

    #[test]
    fn allocated_run_ids_avoid_existing_records() {
        let project = tempfile::tempdir().unwrap();
        let at = Utc.with_ymd_and_hms(2026, 9, 20, 2, 15, 30).unwrap();
        let first = allocate_run_id(project.path(), &at);
        assert!(is_run_id(&first));
        let mut record = sample();
        record.run_id = first.clone();
        persist_run_record(project.path(), record).unwrap();
        // Retried until free; with 36^6 suffixes a repeat of `first` is practically impossible.
        assert_ne!(allocate_run_id(project.path(), &at), first);
    }

    #[test]
    fn redaction_prefers_the_longest_value_and_skips_empty_ones() {
        let secrets = vec![
            SecretValue {
                reference: "${secret:short}".to_string(),
                value: "sk-123".to_string(),
            },
            SecretValue {
                reference: "${secret:long}".to_string(),
                value: "sk-123456".to_string(),
            },
            SecretValue {
                reference: "${secret:empty}".to_string(),
                value: String::new(),
            },
        ];
        let mut record = sample();
        record.command = "run --key sk-123456 --other sk-123".to_string();
        let redacted = redact_run_record(record, &secrets);
        assert_eq!(
            redacted.command,
            "run --key ${secret:long} --other ${secret:short}"
        );
        assert_eq!(redacted.inputs, sample().inputs);
    }

    /// One piece of a free-text field: plain text, or the credential with this index.
    #[derive(Debug, Clone)]
    enum Part {
        Filler(String),
        Secret(usize),
    }

    fn render(parts: &[Part], secrets: &[SecretValue], redacted: bool) -> String {
        parts
            .iter()
            .map(|part| match part {
                Part::Filler(text) => text.clone(),
                // `|` never occurs in a credential, so no value can match across a boundary.
                Part::Secret(index) => {
                    let secret = &secrets[*index];
                    let shown = if redacted {
                        &secret.reference
                    } else {
                        &secret.value
                    };
                    format!("|{shown}|")
                }
            })
            .collect()
    }

    /// Credentials start with an uppercase marker that fillers, paths, hashes, run ids,
    /// timestamps and Secret_References never contain, and include quotes, backslashes,
    /// spaces, Chinese and emoji.
    fn secret_value() -> impl Strategy<Value = String> {
        "[A-Za-z0-9中文🔑\"\\\\ _-]{6,16}".prop_map(|tail| format!("SEC{tail}"))
    }

    fn parts(secret_count: usize) -> impl Strategy<Value = Vec<Part>> {
        prop::collection::vec(
            prop_oneof![
                "[a-z0-9 ./=\"-]{0,8}".prop_map(Part::Filler),
                (0..secret_count).prop_map(Part::Secret),
            ],
            0..6,
        )
    }

    type RedactionCase = (
        Vec<SecretValue>,
        Vec<Vec<Part>>,
        Vec<(Vec<Part>, Vec<Part>)>,
    );

    fn redaction_case() -> impl Strategy<Value = RedactionCase> {
        // A map keeps the values distinct, so each value has exactly one reference.
        prop::collection::btree_map(secret_value(), "[a-z0-9_]{1,12}", 1..5).prop_flat_map(
            |entries| {
                let secrets: Vec<SecretValue> = entries
                    .into_iter()
                    .map(|(value, key)| SecretValue {
                        reference: format!("${{secret:{key}}}"),
                        value,
                    })
                    .collect();
                let count = secrets.len();
                (
                    Just(secrets),
                    prop::collection::vec(parts(count), 5),
                    prop::collection::vec((parts(count), parts(count)), 0..4),
                )
            },
        )
    }

    fn with_fields(
        secrets: &[SecretValue],
        fields: &[Vec<Part>],
        dependencies: &[(Vec<Part>, Vec<Part>)],
        redacted: bool,
    ) -> RunRecord {
        let text = |parts: &[Part]| render(parts, secrets, redacted);
        let mut record = sample();
        record.command = text(&fields[0]);
        record.seed = text(&fields[1]);
        record.config = RunConfig {
            provider: text(&fields[2]),
            model: text(&fields[3]),
            runtime: text(&fields[4]),
        };
        record.dependencies = dependencies
            .iter()
            .map(|(name, version)| Dependency {
                name: text(name),
                version: text(version),
            })
            .collect();
        record
    }

    // Feature: mathmodel-parity-and-beyond, Property 37: Run_Record 不含凭据原文
    proptest! {
        #![proptest_config(ProptestConfig::with_cases(100))]

        #[test]
        fn redacted_records_contain_no_credential_value(
            (secrets, fields, dependencies) in redaction_case()
        ) {
            let original = with_fields(&secrets, &fields, &dependencies, false);
            let expected = with_fields(&secrets, &fields, &dependencies, true);

            let redacted = redact_run_record(original, &secrets);
            prop_assert_eq!(&redacted, &expected);
            prop_assert!(redacted.problems().is_empty());

            let json = redacted.to_json().unwrap();
            for secret in &secrets {
                prop_assert!(!json.contains(&secret.value), "raw {:?} in {}", secret.value, json);
                let escaped = serde_json::to_string(&secret.value).unwrap();
                let escaped = escaped.trim_matches('"');
                prop_assert!(!json.contains(escaped), "escaped {:?} in {}", escaped, json);
            }
        }
    }
}
