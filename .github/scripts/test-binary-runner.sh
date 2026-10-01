#!/usr/bin/env bash
# Cargo target runner for the CI test binaries (set as CARGO_TARGET_<TRIPLE>_RUNNER): runs one
# test binary with a time limit. Cargo itself has none, so a hanging test used to run into the
# step's timeout, and a test that took the runner down left no clue at all.
#
# When the limit is hit this prints the tests that had started but not finished (libtest prints a
# test's line only when the test ends), the binary's threads (libtest names each test's thread
# after the test) and, when gdb is available, their backtraces; then it kills the binary's
# process group and exits 124, which fails the step with the binary's name.
#
# The binary's stdout and stderr both go to stdout (CI merges them anyway).
#
# Usage (by cargo): test-binary-runner.sh <binary> [args...]
# Environment: TEST_BINARY_TIMEOUT_SECS (default 900).
set -u

bin="$1"
shift
limit="${TEST_BINARY_TIMEOUT_SECS:-900}"
out="$(mktemp "${RUNNER_TEMP:-/tmp}/test-binary.XXXXXX")"
trap 'rm -f "$out"' EXIT

# Job control gives the binary its own process group, which a timeout kills as a whole.
set -m
"$bin" "$@" > "$out" 2>&1 < /dev/null &
pid=$!
set +m
# Streams the output as it is written and exits once the binary is gone and all of it is out.
tail -n +1 -s 0.1 -f --pid="$pid" "$out" &
tailer=$!
sleep "$limit" &
timer=$!

forward() { kill -"$1" -- "-$pid" 2> /dev/null || kill -"$1" "$pid" 2> /dev/null; }
trap 'forward TERM' TERM
trap 'forward INT' INT

report() {
  local name="${bin##*/}" listed finished
  echo "::error title=Test binary timed out::${name} was still running after ${limit}s"
  # Only libtest harnesses (target/<profile>/deps/*) understand --list.
  if [[ "$bin" == */deps/* ]]; then
    listed="$("$bin" "$@" --list 2> /dev/null < /dev/null | sed -n 's/: test$//p' | sort)"
    finished="$(sed 's/\x1b\[[0-9;]*m//g' "$out" | sed -n -E 's/^test (.+) \.\.\. .*/\1/p' | sort)"
    echo "Tests of ${name} that had not finished:"
    comm -23 <(printf '%s\n' "$listed") <(printf '%s\n' "$finished") | head -n 60 | sed 's/^/  /'
  fi
  echo "Threads of ${name} (pid ${pid}):"
  cat /proc/"$pid"/task/*/comm 2> /dev/null | sort | uniq -c | sort -rn | head -n 60 |
    awk '{ printf "  %s x%s\n", $2, $1 }'
  if command -v gdb > /dev/null && sudo -n true 2> /dev/null; then
    echo "::group::Backtraces of ${name}"
    sudo -n timeout 120 gdb -p "$pid" -batch -ex 'thread apply all bt 30' 2> /dev/null < /dev/null |
      grep -E '^(Thread|#)' | cut -c 1-240 | head -n 600
    echo "::endgroup::"
  fi
}

while :; do
  ended=""
  wait -n -p ended "$pid" "$timer"
  status=$?
  # A trapped signal interrupts wait without any job having ended (wait unsets the variable).
  [[ -z "${ended:-}" ]] || break
done

if [[ "$ended" == "$timer" ]]; then
  report "$@"
  forward KILL
  wait "$pid" 2> /dev/null
  wait "$tailer" 2> /dev/null
  exit 124
fi
kill "$timer" 2> /dev/null
wait "$timer" 2> /dev/null
wait "$tailer" 2> /dev/null
if ((status > 128 && status < 160)); then
  # Ended by a signal: end the same way, so cargo reports the signal.
  trap - TERM INT EXIT
  rm -f "$out"
  kill -s "$((status - 128))" $$
fi
exit "$status"
