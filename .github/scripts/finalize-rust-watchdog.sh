#!/usr/bin/env bash
# Gives the Rust watchdog's reports (memory-watchdog.sh: the "rust-watchdog" commit status and the
# "rust-watchdog-log" check runs) a final state once the job they belong to has ended.
#
# The watchdog finishes its own reports when its step ends. When the runner is lost nothing on it
# runs any more, and the reports used to stay "pending" / "in progress" for good. ci.yml runs this
# in a separate job after the Rust job, whatever that job's result. It finishes:
#   - check runs of this run (external_id "<run id>-<attempt>", attempts up to this one), and
#     older check runs without an external_id (from before reports named their run) that started
#     more than STALE_SECS ago;
#   - the commit status, when it is still pending and was posted by this run (target_url), or has
#     no target_url and was last updated more than STALE_SECS ago.
# Check runs can only be changed by the app that created them, so this needs the workflow's
# GITHUB_TOKEN, not a personal token. Run outside a workflow run (GITHUB_RUN_ID unset), it only
# finishes the old, stale reports of a commit.
#
# Environment: GH_TOKEN (statuses: write, checks: write), GITHUB_REPOSITORY, WATCHDOG_STATUS_SHA,
# JOB_RESULT (the Rust job's result), GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, STALE_SECS (default 7200);
# DRY_RUN=1 only prints what it would change.
set -euo pipefail

repo="${GITHUB_REPOSITORY:?}"
sha="${WATCHDOG_STATUS_SHA:?}"
result="${JOB_RESULT:-unknown}"
run_id="${GITHUB_RUN_ID:-}"
attempt="${GITHUB_RUN_ATTEMPT:-0}"
stale_secs="${STALE_SECS:-7200}"
dry_run="${DRY_RUN:-}"
now="$(date -u +%s)"
# Fields are joined with the unit separator: unlike a tab it is not IFS whitespace, so empty
# fields survive `read`.
sep=$'\x1f'

older_than_stale() { (($(date -u -d "$1" +%s) < now - stale_secs)); }

if [[ "$result" == success ]]; then
  note="job succeeded, but the watchdog's final report never arrived"
else
  note="job ended '${result}' before the watchdog stopped (runner lost or step killed)"
fi

finished=0
text="$(mktemp)"
trap 'rm -f "$text"' EXIT

check_runs="$(gh api --paginate \
  "repos/${repo}/commits/${sha}/check-runs?check_name=rust-watchdog-log&filter=all&per_page=100" \
  --jq '.check_runs[] | select(.status != "completed")
    | [(.id | tostring), (.external_id // ""), .started_at, (.output.summary // "" | gsub("[\n\u001f]"; " "))]
    | join("\u001f")')"
while IFS="$sep" read -r id external started summary; do
  [[ -n "$id" ]] || continue
  mine=""
  if [[ -n "$run_id" && "$external" =~ ^${run_id}-([0-9]+)$ ]] && ((BASH_REMATCH[1] <= attempt)); then
    mine="this run"
  elif [[ -z "$external" ]] && older_than_stale "$started"; then
    mine="stale"
  fi
  if [[ -z "$mine" ]]; then
    echo "check run ${id} (${external:-no external_id}, started ${started}) belongs to another run; left alone"
    continue
  fi
  if [[ -n "$dry_run" ]]; then
    echo "would finalize check run ${id} (${mine}); last summary: ${summary}"
    continue
  fi
  # The output is replaced as a whole: keep the test output the watchdog last uploaded.
  gh api "repos/${repo}/check-runs/${id}" --jq '.output.text // ""' > "$text"
  jq -n --arg summary "Finalized after the job ended: ${note}. Last watchdog report: ${summary}" \
    --rawfile text "$text" \
    '{status: "completed", conclusion: "neutral",
      output: {title: "Rust test output (last lines)", summary: $summary, text: $text}}' |
    gh api -X PATCH "repos/${repo}/check-runs/${id}" --input - > /dev/null
  echo "check run ${id} (${mine}) finalized"
  finished=$((finished + 1))
done <<< "$check_runs"

status="$(gh api "repos/${repo}/commits/${sha}/status" \
  --jq '.statuses[] | select(.context == "rust-watchdog")
    | [.state, (.target_url // ""), .updated_at, (.description // "" | gsub("[\n\u001f]"; " "))]
    | join("\u001f")')"
if [[ -n "$status" ]]; then
  IFS="$sep" read -r state target updated description <<< "$status"
  mine=""
  if [[ "$state" == pending ]]; then
    if [[ -n "$run_id" && "$target" =~ /actions/runs/${run_id}/attempts/([0-9]+)$ ]] &&
      ((BASH_REMATCH[1] <= attempt)); then
      mine="this run"
    elif [[ -z "$target" ]] && older_than_stale "$updated"; then
      mine="stale"
    fi
  fi
  if [[ -n "$mine" ]]; then
    final_state=error
    [[ "$result" != success ]] || final_state=success
    # GitHub keeps descriptions to 140 characters.
    message="$(printf 'final: job %s, watchdog never stopped. last: %s' "$result" "$description" | cut -c 1-140)"
    if [[ -n "$dry_run" ]]; then
      echo "would set status rust-watchdog (${mine}) to ${final_state}: ${message}"
      exit 0
    fi
    fields=(-f state="$final_state" -f context=rust-watchdog -f description="$message")
    [[ -z "$target" ]] || fields+=(-f target_url="$target")
    gh api -X POST "repos/${repo}/statuses/${sha}" "${fields[@]}" > /dev/null
    echo "status rust-watchdog (${mine}) set to ${final_state}: ${message}"
    finished=$((finished + 1))
  else
    echo "status rust-watchdog is ${state} (${target:-no target_url}, updated ${updated}); left alone"
  fi
fi
echo "finalized ${finished} report(s) on ${sha}"
