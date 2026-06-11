#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."

LOG="data/refresh-genres.log"
mkdir -p data
touch "$LOG"

# Tunables (env-overridable).
CONCURRENCY="${INGEST_CONCURRENCY:-3}"
INTER_BATCH_MS="${INGEST_INTER_BATCH_MS:-400}"
CHUNK="${REFRESH_MAX_LOOKUPS:-1500}"
BACKOFF_BASE_SEC="${REFRESH_BACKOFF_BASE_SEC:-600}"   # 10 min after first throttle
BACKOFF_MAX_SEC="${REFRESH_BACKOFF_MAX_SEC:-1800}"    # cap at 30 min
SHORT_SLEEP_SEC="${REFRESH_SHORT_SLEEP_SEC:-20}"      # between clean chunks
PUSH_ON_DONE="${REFRESH_PUSH_ON_DONE:-1}"

# Exit codes emitted by refresh-goodreads-genres.ts.
EXIT_CHUNK_OK=0
EXIT_ALL_DONE=2
EXIT_THROTTLED=3

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

echo "" >>"$LOG"
echo "=== refresh-loop start $(ts) (concurrency=$CONCURRENCY chunk=$CHUNK) ===" >>"$LOG"

backoff="$BACKOFF_BASE_SEC"

while true; do
  INGEST_CONCURRENCY="$CONCURRENCY" \
  INGEST_INTER_BATCH_MS="$INTER_BATCH_MS" \
  REFRESH_MAX_LOOKUPS="$CHUNK" \
    npm run db:refresh-genres >>"$LOG" 2>&1
  code=$?

  case "$code" in
    "$EXIT_ALL_DONE")
      echo "All genres refreshed at $(ts)." >>"$LOG"
      break
      ;;
    "$EXIT_THROTTLED")
      echo "Throttled; backing off ${backoff}s at $(ts)." >>"$LOG"
      sleep "$backoff"
      backoff=$(( backoff * 2 ))
      if (( backoff > BACKOFF_MAX_SEC )); then backoff="$BACKOFF_MAX_SEC"; fi
      ;;
    "$EXIT_CHUNK_OK")
      backoff="$BACKOFF_BASE_SEC"
      sleep "$SHORT_SLEEP_SEC"
      ;;
    *)
      echo "Chunk exited with unexpected code ${code} at $(ts); retrying after ${SHORT_SLEEP_SEC}s." >>"$LOG"
      sleep "$SHORT_SLEEP_SEC"
      ;;
  esac
done

echo "Publishing catalog with refreshed genres at $(ts)..." >>"$LOG"
npm run db:publish >>"$LOG" 2>&1
npm run db:validate >>"$LOG" 2>&1

if [[ "$PUSH_ON_DONE" == "1" ]]; then
  echo "Committing and pushing published DB at $(ts)..." >>"$LOG"
  git add data/book-ratings.sqlite >>"$LOG" 2>&1
  if git diff --cached --quiet; then
    echo "No published DB changes to commit." >>"$LOG"
  else
    git commit --trailer "Co-authored-by: Cursor <cursoragent@cursor.com>" -m "Refresh Goodreads genres for full published catalog" >>"$LOG" 2>&1
    git push >>"$LOG" 2>&1 && echo "Pushed at $(ts)." >>"$LOG" || echo "Push failed at $(ts); commit is local." >>"$LOG"
  fi
fi

echo "refresh-loop complete $(ts)." >>"$LOG"
