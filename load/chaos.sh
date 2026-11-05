#!/usr/bin/env sh
# Crashes one worker mid-load and reports when the restart policy brings it back.
set -eu

# Halfway through the load (k6 DURATION, default 10m), so the crash always hits events in flight.
half_duration_s() {
  duration="${DURATION:-10m}"
  amount="${duration%?}"
  case "$amount" in '' | *[!0-9]*) amount=bad ;; esac
  case "$amount:$duration" in
    bad:*) ;;
    *s) echo $((amount / 2)) && return ;;
    *m) echo $((amount * 30)) && return ;;
    *h) echo $((amount * 1800)) && return ;;
  esac
  echo "cannot read DURATION=$duration (use one unit: 90s, 1m, 2h) or set CHAOS_DELAY_S" >&2
  return 1
}
DELAY_S="${CHAOS_DELAY_S:-$(half_duration_s)}"
sleep "$DELAY_S"

worker=$(docker compose ps -q worker | head -n 1)
pid=$(docker inspect -f '{{.State.Pid}}' "$worker")
# SIGKILL from the Docker VM's pid namespace is a real crash: docker kill counts as a manual stop,
# and restart: unless-stopped would leave the worker down.
docker run --rm --pid=host alpine:3.20 kill -9 "$pid"
echo "$(date -u +%H:%M:%S) killed worker $(echo "$worker" | cut -c1-12) (pid $pid)"

waited=0
until [ "$(docker inspect -f '{{.State.Pid}}' "$worker")" != "$pid" ] &&
  [ "$(docker inspect -f '{{.State.Running}}' "$worker")" = true ]; do
  if [ "$waited" -ge 60 ]; then
    echo "$(date -u +%H:%M:%S) worker did not restart in 60s" >&2
    exit 1
  fi
  sleep 1
  waited=$((waited + 1))
done
echo "$(date -u +%H:%M:%S) worker restarted"
