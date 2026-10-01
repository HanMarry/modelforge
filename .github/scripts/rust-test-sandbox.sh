#!/usr/bin/env bash
# Runs a command (the Rust tests) as the calling user inside a sandbox, so that whatever a test
# does to processes or the machine ends as a failed step instead of a lost runner:
#
# - a new PID namespace: kill(-1, ...) from a test reaches only the sandbox (outside it, it
#   reaches every process of the runner user: Runner.Listener, Runner.Worker and any watchdog,
#   setsid'd or not), and so does a kill of the test's own or any other process group;
# - a transient systemd scope with memory, swap and task limits: a runaway test is OOM-killed or
#   fails to fork inside the scope instead of starving the runner;
# - an optional time limit, after which it prints what the sandbox was running and kills it.
#
# The command gets the caller's environment, minus tokens, and resource limits (ulimit).
# Without passwordless sudo, systemd-run, unshare and setpriv it runs the command directly.
#
# Usage: rust-test-sandbox.sh [--name NAME] [--timeout SECS] -- command [args...]
# Environment: SANDBOX_MEMORY_MAX (default 85%, of physical memory), SANDBOX_SWAP_MAX (default 2G),
#              SANDBOX_TASKS_MAX (default 8192).
set -u

name="rust-tests"
timeout_secs=0
while (($#)); do
  case "$1" in
    --name)
      name="$2"
      shift 2
      ;;
    --timeout)
      timeout_secs="$2"
      shift 2
      ;;
    --)
      shift
      break
      ;;
    *) break ;;
  esac
done
(($#)) || {
  echo "usage: $0 [--name NAME] [--timeout SECS] -- command [args...]" >&2
  exit 2
}

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for tool in systemd-run unshare setpriv prlimit; do
  if ! command -v "$tool" > /dev/null; then
    echo "::warning::rust-test-sandbox: $tool is missing; running without a sandbox"
    exec "$@"
  fi
done
if ! sudo -n true 2> /dev/null; then
  echo "::warning::rust-test-sandbox: no passwordless sudo; running without a sandbox"
  exec "$@"
fi

unit="${name}-$$-${RANDOM}"
env_file="$(mktemp "${RUNNER_TEMP:-/tmp}/sandbox-env.XXXXXX")"
trap 'rm -f "$env_file"' EXIT
# NUL-separated, so any value survives; tokens stay outside the sandbox.
env -0 | grep -z -v -E '^(WATCHDOG_TOKEN|GITHUB_TOKEN|GH_TOKEN|DIAG_TOKEN|ACTIONS_[A-Z_]*TOKEN[A-Z_]*)=' \
  > "$env_file"

# sudo may apply other limits; give the sandbox exactly the caller's.
limits=()
while read -r resource soft hard; do
  limits+=("--${resource,,}=${soft}:${hard}")
done < <(prlimit --pid $$ --noheadings --raw --output RESOURCE,SOFT,HARD)

limit_note=""
((timeout_secs <= 0)) || limit_note=", time limit ${timeout_secs}s"
echo "rust-test-sandbox: scope ${unit}.scope (MemoryMax ${SANDBOX_MEMORY_MAX:-85%}, MemorySwapMax ${SANDBOX_SWAP_MAX:-2G}, TasksMax ${SANDBOX_TASKS_MAX:-8192}), new PID namespace${limit_note}"
sudo -n systemd-run --scope --quiet --collect --unit="$unit" \
  -p MemoryMax="${SANDBOX_MEMORY_MAX:-85%}" \
  -p MemorySwapMax="${SANDBOX_SWAP_MAX:-2G}" \
  -p TasksMax="${SANDBOX_TASKS_MAX:-8192}" \
  unshare --pid --fork --kill-child --mount-proc \
  prlimit "${limits[@]}" -- \
  setpriv --reuid="$(id -u)" --regid="$(id -g)" --init-groups -- \
  /bin/bash "$here/rust-test-sandbox-init.sh" "$env_file" "$PWD" "$@" &
sandbox=$!

# Forward a cancellation (the runner sends SIGINT, then SIGTERM) to everything in the scope.
trap 'sudo -n systemctl kill --signal=SIGTERM "${unit}.scope" 2> /dev/null' INT TERM

alive() {
  local state
  state="$(awk '{ print $3 }' "/proc/$1/stat" 2> /dev/null)"
  [[ -n "$state" && "$state" != Z ]]
}

report() {
  local procs pid
  procs="/sys/fs/cgroup$(systemctl show -p ControlGroup --value "${unit}.scope" 2> /dev/null)/cgroup.procs"
  echo "::group::rust-test-sandbox: processes in ${unit}.scope"
  for pid in $(cat "$procs" 2> /dev/null); do
    ps -o pid=,ppid=,stat=,etimes=,nlwp=,rss=,args= -p "$pid" 2> /dev/null | cut -c 1-300
    if grep -q -a '/deps/' "/proc/$pid/cmdline" 2> /dev/null; then
      echo "  threads: $(cat /proc/"$pid"/task/*/comm 2> /dev/null | sort | uniq -c | sort -rn |
        awk '{ printf "%s x%s, ", $2, $1 }' | cut -c 1-1500)"
      if command -v gdb > /dev/null; then
        sudo -n timeout 120 gdb -p "$pid" -batch -ex 'thread apply all bt 25' 2> /dev/null |
          grep -E '^(Thread|#)' | cut -c 1-240 | head -n 400
      fi
    fi
  done
  echo "::endgroup::"
}

if ((timeout_secs > 0)); then
  deadline=$((SECONDS + timeout_secs))
  while alive "$sandbox"; do
    if ((SECONDS >= deadline)); then
      echo "::error title=Sandbox time limit::'$*' was still running after ${timeout_secs}s; killing it"
      report
      sudo -n systemctl kill --signal=SIGKILL "${unit}.scope" 2> /dev/null
      wait "$sandbox"
      exit 124
    fi
    sleep 5 &
    wait $!
  done
fi

status=0
wait "$sandbox" || status=$?
# A trapped signal makes wait return early; wait again for the real status.
while alive "$sandbox"; do
  status=0
  wait "$sandbox" || status=$?
done
if ((status > 128)); then
  echo "::warning::rust-test-sandbox: the sandbox ended by signal $((status - 128))"
fi
exit "$status"
