#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

LOG="data/ingest.log"
STALL_TIMEOUT_SEC="${INGEST_STALL_TIMEOUT_SEC:-600}"
STALL_CHECK_SEC="${INGEST_STALL_CHECK_SEC:-60}"
mkdir -p data
touch "$LOG"

bm_matched_count() {
  npx tsx -e "
    import { openRawDatabase, countRawRows } from './src/lib/ingest/database.ts';
    const db = openRawDatabase('data/book-ratings.raw.sqlite');
    const count = countRawRows(db, \"bookmarks_status = 'matched'\");
    db.close();
    console.log(count);
  "
}

pending() {
  npx tsx -e "
    import { openRawDatabase, countRawRows } from './src/lib/ingest/database.ts';
    const db = openRawDatabase('data/book-ratings.raw.sqlite');
    const total = countRawRows(db);
    const bm = countRawRows(db, \"bookmarks_status = 'pending'\");
    const gr = countRawRows(db, \"bookmarks_status = 'matched' and reader_status = 'pending'\");
    db.close();
    console.log(total + ' ' + bm + ' ' + gr);
  "
}

run_chunk_with_watchdog() {
  local chunk_pid
  local last_count
  local last_progress_at
  local now
  local current_count

  last_count="$(bm_matched_count)"
  last_progress_at="$(date +%s)"

  (
    BOOKMARKS_MAX_LOOKUPS="${BOOKMARKS_MAX_LOOKUPS:-2000}" \
    GOODREADS_MAX_LOOKUPS="${GOODREADS_MAX_LOOKUPS:-2000}" \
    npm run db:ingest
  ) >>"$LOG" 2>&1 &
  chunk_pid=$!

  while kill -0 "$chunk_pid" 2>/dev/null; do
    sleep "$STALL_CHECK_SEC"
    current_count="$(bm_matched_count)"
    if [[ "$current_count" -gt "$last_count" ]]; then
      last_count="$current_count"
      last_progress_at="$(date +%s)"
      continue
    fi

    now="$(date +%s)"
    if (( now - last_progress_at >= STALL_TIMEOUT_SEC )); then
      echo "STALL: no ingest progress for ${STALL_TIMEOUT_SEC}s (bm_matched=${current_count}); killing chunk pid ${chunk_pid}" | tee -a "$LOG"
      kill -TERM "$chunk_pid" 2>/dev/null || true
      sleep 5
      kill -KILL "$chunk_pid" 2>/dev/null || true
      wait "$chunk_pid" 2>/dev/null || true
      return 1
    fi
  done

  wait "$chunk_pid"
}

echo "Starting resumable ingest loop at $(date -u +%Y-%m-%dT%H:%M:%SZ) (stall timeout=${STALL_TIMEOUT_SEC}s)" | tee -a "$LOG"

while true; do
  if ! run_chunk_with_watchdog; then
    echo "Retrying ingest chunk after stall at $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a "$LOG"
    sleep 10
    continue
  fi

  npm run db:publish 2>&1 | tee -a "$LOG"
  read -r total bm_pending gr_pending <<< "$(pending)"
  echo "After chunk: total=$total bookmarks_pending=$bm_pending goodreads_pending=$gr_pending" | tee -a "$LOG"
  if [[ "$total" == "0" ]]; then
    echo "ERROR: raw catalog is empty" | tee -a "$LOG"
    exit 1
  fi
  if [[ "$bm_pending" == "0" && "$gr_pending" == "0" ]]; then
    echo "Ingest complete at $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a "$LOG"
    break
  fi
done

npm run db:publish 2>&1 | tee -a "$LOG"
npm run db:validate 2>&1 | tee -a "$LOG"

echo "Publish complete at $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a "$LOG"
