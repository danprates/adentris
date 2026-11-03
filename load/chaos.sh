#!/usr/bin/env sh
# Crashes one worker mid-load and reports when the restart policy brings it back.
set -eu

DELAY_S="${CHAOS_DELAY_S:-180}"
sleep "$DELAY_S"

worker=$(docker compose ps -q worker | head -n 1)
pid=$(docker inspect -f '{{.State.Pid}}' "$worker")
# SIGKILL from the Docker VM's pid namespace is a real crash: docker kill counts as a manual stop,
# and restart: unless-stopped would leave the worker down.
docker run --rm --pid=host alpine:3.20 kill -9 "$pid"
echo "$(date -u +%H:%M:%S) killed worker $(echo "$worker" | cut -c1-12) (pid $pid)"

until [ "$(docker inspect -f '{{.State.Pid}}' "$worker")" != "$pid" ] &&
  [ "$(docker inspect -f '{{.State.Running}}' "$worker")" = true ]; do
  sleep 0.2
done
echo "$(date -u +%H:%M:%S) worker restarted"
