#!/usr/bin/env bash
# PID 1 of rust-test-sandbox.sh's PID namespace. Restores the caller's environment, runs the
# command, reaps whatever the command orphans (the init of a PID namespace inherits every orphan
# in it; if it did not reap them they would stay zombies) and exits with the command's status.
#
# As the namespace's init it only receives the signals it has handlers for, so a test that
# signals every process it can (kill(-1, ...)) cannot end it; that test takes down the command
# instead, which fails the step with its output intact.
#
# Usage: rust-test-sandbox-init.sh <NUL-separated environment file> <directory> command [args...]
env_file="$1"
dir="$2"
shift 2

while IFS= read -r -d '' entry; do
  # Names bash cannot export (exported functions, read-only variables) are skipped.
  export "$entry" 2> /dev/null || true
done < "$env_file"
cd "$dir" || exit 125

"$@" &
child=$!
# Cancellation from outside reaches the init only through a handler.
trap 'kill -TERM "$child" 2> /dev/null' TERM INT HUP

status=0
wait "$child" || status=$?
# A trapped signal makes wait return early; wait until the command has really ended.
while kill -0 "$child" 2> /dev/null; do
  status=0
  wait "$child" || status=$?
done
exit "$status"
