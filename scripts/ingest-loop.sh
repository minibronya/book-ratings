#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

LOG="data/ingest.log"
mkdir -p data
touch "$LOG"

chunk() {
  BOOKMARKS_MAX_LOOKUPS="${BOOKMARKS_MAX_LOOKUPS:-2000}" \
  GOODREADS_MAX_LOOKUPS="${GOODREADS_MAX_LOOKUPS:-2000}" \
  npm run db:ingest 2>&1 | tee -a "$LOG"
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

echo "Starting resumable ingest loop at $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a "$LOG"

while true; do
  chunk
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
