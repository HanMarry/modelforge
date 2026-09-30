#!/usr/bin/env bash
# Runs beside the Rust tests. Some runs of "Build and Test Rust Project" end after about 50
# minutes with "The hosted runner lost communication with the server" (a healthy run takes
# 15-20). GitHub then discards the whole log and the step's own time limit never fires, so the
# runner is starved or killed and nothing on it can tell us why.
#
# So besides printing to the log, this script reports every minute through a channel that
# outlives the runner: a commit status (context "rust-watchdog") on the commit under test, whose
# history shows memory, swap, disk, load, the process count and the test binaries running at
# the time, plus a check run ("rust-watchdog-log") holding the tail of the test output. It also
# kills the largest process when memory is almost gone, so that a runaway test fails the step
# with its name in the log instead of taking the runner down.
#
# In run 36699931665 the reports stopped mid-test with plenty of memory left, i.e. the watchdog
# died together with the tests. Start it in its own session (setsid) so that a test killing its
# process group, or the runner, does not take the watchdog along.
#
# Environment: WATCHDOG_TOKEN (a token with statuses: write and checks: write),
# WATCHDOG_STATUS_SHA (the commit to report on) and WATCHDOG_TEST_LOG (a file the test output is
# copied to) enable the reports; without them the script only logs.
set -u

min_available_mb="${WATCHDOG_MIN_AVAILABLE_MB:-1024}"
low_available_mb="${WATCHDOG_LOW_AVAILABLE_MB:-3072}"
interval_secs="${WATCHDOG_INTERVAL_SECS:-30}"
log_every="${WATCHDOG_LOG_EVERY:-6}"
status_every="${WATCHDOG_STATUS_EVERY:-2}"
status_sha="${WATCHDOG_STATUS_SHA:-}"

meminfo_mb() {
  awk -v key="$1:" '$1 == key { print int($2 / 1024) }' /proc/meminfo
}

# Posts a commit status; failures (a read-only token on a fork, a network hiccup) are ignored.
post_status() {
  local state="$1" description="$2"
  [[ -n "${WATCHDOG_TOKEN:-}" && -n "$status_sha" ]] || return 0
  # Only characters that need no JSON escaping, and GitHub's 140-character limit.
  description="$(printf '%s' "$description" | tr -cd '[:alnum:] ._:,()|/+=-' | cut -c 1-140)"
  curl -sS -o /dev/null -m 10 -X POST \
    -H "Authorization: Bearer ${WATCHDOG_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    "${GITHUB_API_URL:-https://api.github.com}/repos/${GITHUB_REPOSITORY}/statuses/${status_sha}" \
    -d "{\"state\":\"${state}\",\"context\":\"rust-watchdog\",\"description\":\"${description}\"}" ||
    true
}

# Test binaries (target/*/deps/<name>-<hash>) running now, as "name(seconds)".
running_tests() {
  ps -eo etimes=,args= |
    awk '$2 ~ /\/target\/[^\/]+\/deps\/[^\/]+$/ {
      n = split($2, parts, "/"); printf "%s(%ss) ", parts[n], $1 }' |
    cut -c 1-80
}

# Whether the runner and cargo are still there: tells a killed runner (cargo still running) from
# a killed process group (both gone) after the job has lost its runner.
runner_state() {
  local workers cargos
  workers="$(pgrep -c -f 'Runner\.Worker' 2>/dev/null)" || workers=0
  cargos="$(pgrep -c -x cargo 2>/dev/null)" || cargos=0
  printf 'runner.worker %s cargo %s' "$workers" "$cargos"
}

# The tail of the test output (WATCHDOG_TEST_LOG) in a check run named "rust-watchdog-log", so
# the last tests that finished are readable even when the runner and its log are gone.
test_log="${WATCHDOG_TEST_LOG:-}"
check_run_id=""
post_log() {
  local final="$1" body status_json
  [[ -n "${WATCHDOG_TOKEN:-}" && -n "$status_sha" && -n "$test_log" ]] || return 0
  command -v jq >/dev/null || return 0
  if [[ "$final" == final ]]; then
    status_json='{"status":"completed","conclusion":"neutral"}'
  else
    status_json='{"status":"in_progress"}'
  fi
  # head_sha only when creating the check run; an update takes the other fields.
  local sha=""
  [[ -n "$check_run_id" ]] || sha="$status_sha"
  body="$(tail -n 300 "$test_log" 2>/dev/null | tail -c 60000 |
    jq -Rs --arg sha "$sha" --arg summary "${last_line} | $(runner_state)" \
      --argjson state "$status_json" \
      '$state + {name: "rust-watchdog-log",
        output: {title: "Rust test output (last lines)", summary: $summary, text: .}}
        + (if $sha == "" then {} else {head_sha: $sha} end)')" ||
    return 0
  local url="${GITHUB_API_URL:-https://api.github.com}/repos/${GITHUB_REPOSITORY}/check-runs"
  local method=POST
  if [[ -n "$check_run_id" ]]; then
    url="${url}/${check_run_id}"
    method=PATCH
  fi
  local response
  response="$(printf '%s' "$body" | curl -sS -m 15 -X "$method" \
    -H "Authorization: Bearer ${WATCHDOG_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    "$url" --data-binary @-)" || return 0
  if [[ -z "$check_run_id" ]]; then
    check_run_id="$(printf '%s' "$response" | jq -r '.id // empty' 2>/dev/null)" || check_run_id=""
  fi
}

last_line="started"
stop() {
  post_status success "stopped $(date -u +%H:%M), last: ${last_line}"
  post_log final
  exit 0
}
trap stop TERM INT

post_status pending "started $(date -u +%H:%M)"
tick=0
while true; do
  # `wait` returns as soon as a signal arrives, unlike a foreground sleep.
  sleep "$interval_secs" &
  wait $!
  tick=$((tick + 1))
  available_mb="$(meminfo_mb MemAvailable)"
  # Never act on a reading that is not there.
  [[ "$available_mb" =~ ^[0-9]+$ ]] || continue
  swap_used_mb=$(($(meminfo_mb SwapTotal) - $(meminfo_mb SwapFree)))
  disk_free="$(df -h --output=avail / | tail -n 1 | tr -d ' ')"
  load="$(cut -d ' ' -f 1 /proc/loadavg)"
  processes="$(ps -e --no-headers | wc -l)"
  tests="$(running_tests)"
  workers="$(pgrep -c -f 'Runner\.Worker' 2>/dev/null)" || workers=0
  last_line="$(date -u +%H:%M) mem ${available_mb}M swap ${swap_used_mb}M disk ${disk_free} load ${load} procs ${processes} rw ${workers} | ${tests:-no test binary}"

  if ((tick % status_every == 0 || available_mb < low_available_mb)); then
    post_status pending "$last_line"
    post_log running
  fi
  if ((tick % log_every == 0 || available_mb < low_available_mb)); then
    echo "[watchdog] ${last_line}"
    ps -eo pid=,rss=,etime=,args= --sort=-rss | head -n 3 |
      awk '{ printf "[watchdog]   pid %s  %d MiB  %s  ", $1, $2 / 1024, $3; $1 = $2 = $3 = ""; print substr($0, 4, 200) }'
  fi

  if ((available_mb < min_available_mb)); then
    read -r pid rss args < <(ps -eo pid=,rss=,args= --sort=-rss | head -n 1)
    message="only ${available_mb} MiB left; killing pid ${pid} ($((rss / 1024)) MiB): ${args:0:300}"
    echo "::error title=Memory almost exhausted::${message}"
    post_status pending "OOM kill: ${message}"
    kill -KILL "$pid" 2>/dev/null || true
  fi
done
