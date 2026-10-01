#!/usr/bin/env bash
# Root-side monitor for the "hosted runner lost communication" investigation
# (.github/workflows/diag-rust-runner-loss.yml).
#
# It runs as root in its own session. A test running as the runner user cannot signal it
# (kill(-1, ...) reaches every process of the sender's user, setsid'd or not, but not root's),
# and it does not depend on the runner: it reports through a check run, which outlives both the
# runner and the job log GitHub discards when a runner is lost.
#
# What it records, all kept under DIAG_DIR:
#   signals.log  bpftrace (signals.bt): kill-family syscalls with sender and raw target, signal
#                deliveries with the target's name, processes ending by a signal, runner exits,
#                OOM victims, and 5-second fork / TCP-connect rates
#   samples.log  every 2 s: memory, swap, dirty pages, load, threads, processes, open files,
#                TCP sockets, conntrack entries, free disk, runner processes, running test binaries
#   journal.log, dmesg.log  kernel and systemd messages (OOM kills, hung tasks, systemd-oomd)
#   ps-*.txt, runner-diag-tail.txt  snapshots taken when the runner's processes disappear
#
# Environment: DIAG_DIR, DIAG_SCRIPTS (directory of signals.bt), DIAG_TEST_LOG (test output),
# DIAG_RUNNER_USER (default runner); DIAG_TOKEN (checks: write), DIAG_SHA, DIAG_CHECK_NAME,
# GITHUB_REPOSITORY and GITHUB_API_URL enable the check run.
set -u

dir="${DIAG_DIR:?DIAG_DIR is required}"
scripts="${DIAG_SCRIPTS:?DIAG_SCRIPTS is required}"
test_log="${DIAG_TEST_LOG:-/dev/null}"
runner_user="${DIAG_RUNNER_USER:-runner}"
check_name="${DIAG_CHECK_NAME:-diag-rust-runner-loss}"
api="${GITHUB_API_URL:-https://api.github.com}/repos/${GITHUB_REPOSITORY:-}"
mkdir -p "$dir"
echo "$$" > "$dir/monitor.pid"

started="$(date -u +%H:%M:%S)"
check_id=""
runner_seen=0
runner_gone_at=""
runner_diag_dir=""
last_post=0
suspicious_seen=0

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >> "$dir/monitor.log"; }

# The runner's processes, by command line (the apphost path ends in bin/Runner.<name>).
listener_re='(^|/)Runner\.Listener( |$)'
worker_re='(^|/)Runner\.Worker( |$)'

# Lines that point at the runner-loss mechanisms under investigation.
suspicious_re='kill\((-1|0), |to pid=[0-9]+ comm=Runner\.|exit pid=[0-9]+ comm=Runner\.|oom victim'

start_bpftrace() {
  local script pid
  for script in "$scripts/signals.bt" "$scripts/signals-min.bt"; do
    bpftrace -B line "$script" > "$dir/signals.log" 2> "$dir/bpftrace.err" &
    pid=$!
    for _ in $(seq 1 90); do
      sleep 1
      if grep -q 'bpftrace attached' "$dir/signals.log" 2> /dev/null; then
        log "bpftrace attached with $(basename "$script") (pid $pid)"
        return 0
      fi
      kill -0 "$pid" 2> /dev/null || break
    done
    log "bpftrace failed with $(basename "$script"): $(tail -n 8 "$dir/bpftrace.err" | tr '\n' ' ')"
    kill "$pid" 2> /dev/null
  done
  # Last resort: the audit subsystem records kill() calls without BTF or BPF.
  log "falling back to auditd"
  if ! command -v auditctl > /dev/null; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq auditd >> "$dir/monitor.log" 2>&1 || true
  fi
  auditctl -a always,exit -F arch=b64 -S kill -F a1!=0 -k diag_kill >> "$dir/monitor.log" 2>&1 || true
  tail -n 0 -F /var/log/audit/audit.log 2> /dev/null |
    grep --line-buffered -E 'diag_kill|type=OBJ_PID' >> "$dir/signals.log" &
}

meminfo_mb() { awk -v key="$1:" '$1 == key { print int($2 / 1024) }' /proc/meminfo; }

# Test binaries (target/<profile>/deps/<name>-<hash>) running now, with age, threads, open
# files and resident memory.
running_tests() {
  local pid exe name age threads fds rss
  for pid in $(pgrep -f '/target/[^/ ]+/deps/[^/ ]+' 2> /dev/null); do
    exe="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2> /dev/null | cut -d ' ' -f 1)"
    [[ "$exe" == */deps/* ]] || continue
    name="${exe##*/}"
    age="$(ps -o etimes= -p "$pid" 2> /dev/null | tr -d ' ')"
    threads="$(awk '/^Threads:/ { print $2 }' "/proc/$pid/status" 2> /dev/null)"
    rss="$(awk '/^VmRSS:/ { print int($2 / 1024) }' "/proc/$pid/status" 2> /dev/null)"
    fds="$(find "/proc/$pid/fd" -mindepth 1 -maxdepth 1 2> /dev/null | wc -l)"
    printf '%s(%ss thr %s fd %s %sM) ' "${name%-*}" "${age:-?}" "${threads:-?}" "${fds:-?}" "${rss:-?}"
  done
}

count() {
  local n
  n="$("$@" 2> /dev/null)" || true
  printf '%s' "${n:-0}"
}

sample() {
  local avail swap dirty load threads procs user_procs files tcp tcp6 conntrack disk listener worker
  avail="$(meminfo_mb MemAvailable)"
  swap=$(($(meminfo_mb SwapTotal) - $(meminfo_mb SwapFree)))
  dirty=$(($(meminfo_mb Dirty) + $(meminfo_mb Writeback)))
  read -r load _ _ threads _ < /proc/loadavg
  threads="${threads#*/}"
  procs="$(find /proc -mindepth 1 -maxdepth 1 -name '[0-9]*' 2> /dev/null | wc -l)"
  user_procs="$(count pgrep -c -u "$runner_user")"
  files="$(cut -f 1 /proc/sys/fs/file-nr)"
  tcp="$(awk '/^TCP:/ { printf "inuse %s tw %s alloc %s", $3, $7, $9 }' /proc/net/sockstat)"
  tcp6="$(awk '/^TCP6:/ { print $3 }' /proc/net/sockstat6 2> /dev/null)"
  conntrack="$(cat /proc/sys/net/netfilter/nf_conntrack_count 2> /dev/null || echo -)"
  disk="$(df -P -m / | awk 'NR == 2 { print $4 }')"
  listener="$(count pgrep -c -f "$listener_re")"
  worker="$(count pgrep -c -f "$worker_re")"
  printf '%s mem %sM swap %sM dirty %sM load %s thr %s procs %s user %s files %s tcp(%s v6 %s) ct %s disk %sM listener %s worker %s | %s| %s\n' \
    "$(date -u +%H:%M:%S)" "$avail" "$swap" "$dirty" "$load" "$threads" "$procs" "$user_procs" \
    "$files" "$tcp" "${tcp6:-?}" "$conntrack" "$disk" "$listener" "$worker" "$(running_tests)" \
    "$(tail -n 300 "$test_log" 2> /dev/null | sed 's/\x1b\[[0-9;]*m//g' |
      grep -a -E '^test .* \.\.\. |Running |^round ' | tail -n 1 | cut -c 1-100)"
}

snapshot_processes() {
  ps -eo pid,ppid,pgid,sid,user,stat,etimes,nlwp,rss,args --sort=start_time 2> /dev/null |
    cut -c 1-220 | tail -n 120 > "$1"
}

# Secrets never leave the machine: tokens in any form, and log lines that mention credentials.
redact() {
  sed -E 's/gh[pousr]_[A-Za-z0-9_]{16,}/***/g; s/(Bearer|token|Token|TOKEN)[ =:]+[^ ]+/\1 ***/g'
}

check_runner() {
  local listener pid
  listener="$(pgrep -f "$listener_re" 2> /dev/null | head -n 1)"
  if [[ -n "$listener" ]]; then
    runner_seen=1
    if [[ -z "$runner_diag_dir" ]]; then
      pid="$listener"
      runner_diag_dir="$(dirname "$(dirname "$(readlink -f "/proc/$pid/exe")")")/_diag"
      log "Runner.Listener pid $pid, diag dir $runner_diag_dir, cgroup $(tr '\n' ' ' < "/proc/$pid/cgroup")"
    fi
    return 0
  fi
  if ((runner_seen)) && [[ -z "$runner_gone_at" ]]; then
    runner_gone_at="$(date -u +%H:%M:%S)"
    log "Runner.Listener is gone"
    snapshot_processes "$dir/ps-at-runner-gone.txt"
    {
      local f
      for f in $(ls -t "$runner_diag_dir"/Runner_*.log 2> /dev/null | head -n 1) \
        $(ls -t "$runner_diag_dir"/Worker_*.log 2> /dev/null | head -n 1); do
        echo "--- $f"
        tail -n 60 "$f" | grep -a -v -i -E 'token|authorization|bearer|secret|password|credential|cookie'
      done
    } > "$dir/runner-diag-tail.txt" 2>&1
    return 1
  fi
}

compose() {
  local runner_state=alive
  [[ -z "$runner_gone_at" ]] || runner_state="GONE since ${runner_gone_at} UTC"
  {
    echo "monitor started ${started} UTC on $(hostname); runner: ${runner_state}"
    echo
    echo "== suspicious: kill(-1|0, ...), signals to or exits of Runner.*, OOM victims"
    grep -a -E "$suspicious_re" "$dir/signals.log" 2> /dev/null | tail -n 60
    echo
    echo "== signal records (last 80, rates omitted)"
    grep -a -v 'rate5s' "$dir/signals.log" 2> /dev/null | tail -n 80
    echo
    echo "== fork / TCP connect rates (last 12)"
    grep -a 'rate5s' "$dir/signals.log" 2> /dev/null | tail -n 12
    echo
    echo "== samples (last 40)"
    tail -n 40 "$dir/samples.log" 2> /dev/null
    echo
    echo "== test output (last 40)"
    tail -n 40 "$test_log" 2> /dev/null | sed 's/\x1b\[[0-9;]*m//g'
    echo
    echo "== journal (last 40)"
    tail -n 40 "$dir/journal.log" 2> /dev/null
    if [[ -n "$runner_gone_at" ]]; then
      echo
      echo "== processes when Runner.Listener went away"
      cat "$dir/ps-at-runner-gone.txt"
      echo
      echo "== runner _diag logs (tail, credential lines dropped)"
      cat "$dir/runner-diag-tail.txt"
    fi
  } 2> /dev/null | cut -c 1-400 | redact | tail -c 60000
}

post() {
  local final="${1:-}" summary body method url status_json conclusion
  [[ -n "${DIAG_TOKEN:-}" && -n "${DIAG_SHA:-}" && -n "${GITHUB_REPOSITORY:-}" ]] || return 0
  compose > "$dir/check-text.txt"
  summary="$(tail -n 1 "$dir/samples.log" 2> /dev/null | cut -c 1-500 | redact)"
  [[ -n "$runner_gone_at" ]] && summary="RUNNER GONE since ${runner_gone_at} UTC | ${summary}"
  if [[ "$final" == final ]]; then
    conclusion="$(cat "$dir/conclusion" 2> /dev/null || echo neutral)"
    status_json="$(jq -n --arg c "$conclusion" '{status: "completed", conclusion: $c}')"
  else
    status_json='{"status":"in_progress"}'
  fi
  body="$(jq -n --arg name "$check_name" --arg sha "$DIAG_SHA" --arg summary "${summary:-starting}" \
    --rawfile text "$dir/check-text.txt" --argjson state "$status_json" --arg id "$check_id" \
    '$state + {name: $name, output: {title: "Runner-loss diagnostics", summary: $summary, text: $text}}
      + (if $id == "" then {head_sha: $sha} else {} end)')" || return 0
  url="${api}/check-runs"
  method=POST
  if [[ -n "$check_id" ]]; then
    url="${url}/${check_id}"
    method=PATCH
  fi
  printf '%s' "$body" | curl -sS -m 20 -X "$method" \
    -H "Authorization: Bearer ${DIAG_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    "$url" --data-binary @- > "$dir/post-response.json" 2>> "$dir/monitor.log" || return 0
  if [[ -z "$check_id" ]]; then
    check_id="$(jq -r '.id // empty' "$dir/post-response.json" 2> /dev/null)" || check_id=""
    [[ -n "$check_id" ]] && log "check run ${check_id} created"
  fi
}

stop() {
  sample >> "$dir/samples.log"
  post final
  pkill -P "$$" 2> /dev/null
  exit 0
}
trap stop TERM INT

journalctl -f -n 0 -o short-iso-precise > "$dir/journal.log" 2>&1 &
dmesg -w -T > "$dir/dmesg.log" 2>&1 &
start_bpftrace
post

while true; do
  sample >> "$dir/samples.log"
  urgent=0
  check_runner || urgent=1
  if [[ $(($(date +%s) % 30)) -lt 2 ]]; then
    snapshot_processes "$dir/ps-latest.txt"
  fi
  n="$(grep -a -c -E "$suspicious_re" "$dir/signals.log" 2> /dev/null)" || n=0
  if ((n > suspicious_seen)); then
    suspicious_seen="$n"
    urgent=1
    log "suspicious signal records: $n"
  fi
  now="$(date +%s)"
  if ((now - last_post >= 30 || (urgent && now - last_post >= 10))); then
    post
    last_post="$now"
  fi
  sleep 2 &
  wait $!
done
