#!/bin/bash
# A container has one PID 1 but we need three processes: the TA brain, the
# space, and the snapshot sync that makes an ephemeral filesystem durable.
# The container must DIE if either server dies, so Cloud Run replaces it
# instead of serving a half-working campus — but not before the sync has
# written a final snapshot.
#
# bash, not sh: `wait -n` is a bashism and it is the whole point of the file.
set -euo pipefail

TA_PID=""
SPACE_PID=""
SYNC_PID=""

# Never exit without giving the sync a chance to flush. Cloud Run sends
# SIGTERM here on scale-down, which is the ordinary end of a class.
flush_and_exit() {
  local status="${1:-0}"
  if [ -n "$SYNC_PID" ] && kill -0 "$SYNC_PID" 2>/dev/null; then
    echo "[start] final snapshot before exit"
    kill -TERM "$SYNC_PID" 2>/dev/null || true
    wait "$SYNC_PID" 2>/dev/null || true
  fi
  [ -n "$TA_PID" ] && kill "$TA_PID" 2>/dev/null || true
  [ -n "$SPACE_PID" ] && kill "$SPACE_PID" 2>/dev/null || true
  exit "$status"
}
trap 'flush_and_exit 0' TERM INT

# Pull last session's state down BEFORE anything reads it. A missing or
# unreachable snapshot is not fatal: sync.mjs exits 0 and we start fresh
# rather than putting the class behind a boot loop.
echo "[start] restoring state into ${DATA_DIR:-<unset>}"
node docker/sync.mjs restore

# BOTH servers read $PORT, and Cloud Run injects it for the public one. The
# TA is internal, so it gets an explicit port of its own — without this the
# two fight over the same one and the TA wins, silently.
TA_PORT="${TA_PORT:-3000}"
export TA_BASE_URL="http://127.0.0.1:${TA_PORT}"

echo "[start] launching virtual_ta on 127.0.0.1:${TA_PORT}"
( cd virtual_ta && PORT="$TA_PORT" exec node server/index.ts ) &
TA_PID=$!

# The space's first LLM call would fail against a TA that is still booting.
# Probe with node itself — the slim image has no curl or wget.
for i in $(seq 1 60); do
  if node -e "fetch('http://127.0.0.1:${TA_PORT}/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; then
    echo "[start] virtual_ta healthy after ~$((i / 2))s"
    break
  fi
  kill -0 "$TA_PID" 2>/dev/null || { echo "[start] virtual_ta exited during startup" >&2; exit 1; }
  if [ "$i" -eq 60 ]; then
    echo "[start] virtual_ta never became healthy" >&2
    kill "$TA_PID" 2>/dev/null || true
    exit 1
  fi
  sleep 0.5
done

echo "[start] launching virtual_space on 0.0.0.0:${PORT}"
( cd virtual_space && exec ./node_modules/.bin/tsx server/index.ts ) &
SPACE_PID=$!

# Only now start snapshotting: the servers have created their directories,
# and nothing before this point could have changed anything worth saving.
node docker/sync.mjs watch &
SYNC_PID=$!

# Exit as soon as EITHER server exits, carrying its status out with us.
set +e
wait -n "$TA_PID" "$SPACE_PID"
STATUS=$?
echo "[start] a server exited (status $STATUS) — shutting the container down" >&2
flush_and_exit "$STATUS"
