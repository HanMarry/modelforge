#!/usr/bin/env bash
# Runs beside the Rust tests. Some runs of "Build and Test Rust Project" end after about 50
# minutes with "The hosted runner lost communication with the server" (a healthy run takes
# 15-20), which discards the whole log, so nobody can tell which test or build step caused it.
# The usual reason a runner stops answering is memory: once RAM is gone the machine swaps so hard
# that the runner process misses its heartbeats.
#
# This script prints memory, swap and disk use every few minutes (and every tick once memory
# gets low), and kills the largest process before the machine reaches that point. The killed
# test binary or compiler then fails the step with its name in the log instead of taking the
# runner down.
set -u

min_available_mb="${WATCHDOG_MIN_AVAILABLE_MB:-1024}"
low_available_mb="${WATCHDOG_LOW_AVAILABLE_MB:-3072}"
interval_secs="${WATCHDOG_INTERVAL_SECS:-30}"
report_every="${WATCHDOG_REPORT_EVERY:-6}"

meminfo_mb() {
  awk -v key="$1:" '$1 == key { print int($2 / 1024) }' /proc/meminfo
}

tick=0
while sleep "$interval_secs"; do
  tick=$((tick + 1))
  available_mb="$(meminfo_mb MemAvailable)"
  # Never act on a reading that is not there.
  [[ "$available_mb" =~ ^[0-9]+$ ]] || continue
  swap_used_mb=$(($(meminfo_mb SwapTotal) - $(meminfo_mb SwapFree)))
  disk_free="$(df -h --output=avail / | tail -n 1 | tr -d ' ')"

  if ((tick % report_every == 0 || available_mb < low_available_mb)); then
    echo "[watchdog $(date -u +%H:%M:%S)] memory available ${available_mb} MiB, swap used ${swap_used_mb} MiB, disk free ${disk_free}"
    ps -eo pid=,rss=,etime=,args= --sort=-rss | head -n 3 |
      awk '{ printf "[watchdog]   pid %s  %d MiB  %s  ", $1, $2 / 1024, $3; $1 = $2 = $3 = ""; print substr($0, 4, 200) }'
  fi

  if ((available_mb < min_available_mb)); then
    read -r pid rss args < <(ps -eo pid=,rss=,args= --sort=-rss | head -n 1)
    echo "::error title=Memory almost exhausted::only ${available_mb} MiB left; killing pid ${pid} ($((rss / 1024)) MiB): ${args:0:300}"
    kill -KILL "$pid" 2>/dev/null || true
  fi
done
