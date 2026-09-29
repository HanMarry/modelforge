//! Run_Record (spec mathmodel-parity-and-beyond, requirement 16): the record of one execution of
//! computation code inside a Project, stored as `<project>/.modelforge/runs/<run_id>.json`.
//!
//! - [`run_record`]: the record type, its validation, run ids, the atomic write and the
//!   credential redaction. The contract is `schemas/run-record.schema.json`.
//! - [`run_recorder`]: [`run_recorder::RunRecorder`] measures one execution (code and input
//!   hashes before it starts, output hashes after it ended) and writes its record.
//!
//! Every tool that runs computation code records through this crate: the modeling extension's
//! `run_script` in goose-mcp and the developer `shell` in goose (task 21.7). It depends on
//! neither, so both can depend on it.

pub mod run_record;
pub mod run_recorder;
