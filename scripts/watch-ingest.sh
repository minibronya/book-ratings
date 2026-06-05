#!/usr/bin/env bash
# Poll ingest progress, publish when raw data grows, commit+push published DB.
set -euo pipefail
cd "$(dirname "$0")/.."

INTERVAL="${WATCH_INTERVAL_SEC:-1200}"  # 20 minutes
LOG="data/watch.log"
STATE="data/.watch-state"
mkdir -p data
touch "$LOG"

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG"
}

counts() {
  npx tsx -e "
    import { openRawDatabase, countRawRows } from './src/lib/ingest/database.ts';
    import Database from 'better-sqlite3';
    const raw = openRawDatabase('data/book-ratings.raw.sqlite');
    const rawCounts = {
      total: countRawRows(raw),
      bmMatched: countRawRows(raw, \"bookmarks_status = 'matched'\"),
      grMatched: countRawRows(raw, \"reader_status = 'matched'\"),
      bmPending: countRawRows(raw, \"bookmarks_status = 'pending'\"),
      grPending: countRawRows(raw, \"bookmarks_status = 'matched' and reader_status = 'pending'\"),
    };
    raw.close();
    let published = 0;
    try {
      const pub = new Database('data/book-ratings.sqlite', { readonly: true });
      published = (pub.prepare(\"select count(*) as c from books\").get() as { c: number }).c;
      pub.close();
    } catch {}
    console.log(JSON.stringify({ ...rawCounts, published }));
  "
}

last_published() {
  if [[ -f "$STATE" ]]; then
    cat "$STATE"
  else
    echo "0"
  fi
}

save_published() {
  echo "$1" > "$STATE"
}

tick() {
  local stats published last count
  stats="$(counts)"
  published="$(echo "$stats" | npx tsx -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(j.published)')" || published=0
  last="$(last_published)"
  log "status $stats"

  npm run db:publish >>"$LOG" 2>&1
  npm run db:validate >>"$LOG" 2>&1 || true

  count="$(npx tsx -e "
    import Database from 'better-sqlite3';
    const db = new Database('data/book-ratings.sqlite', { readonly: true });
    const row = db.prepare('select count(*) as c from books').get() as { c: number };
    db.close();
    console.log(row.c);
  ")"

  if [[ "$count" != "$last" && "$count" -gt 0 ]]; then
    log "published count changed: $last -> $count; committing"
    git add data/book-ratings.sqlite
    if git diff --cached --quiet; then
      log "no sqlite diff after publish"
    else
      git commit -m "Refresh book ratings database ($count books)."
      git push
      log "pushed $count books to origin"
    fi
    save_published "$count"
  else
    log "no publishable change (count=$count last=$last)"
  fi
}

log "watch-ingest starting (interval=${INTERVAL}s)"
tick

while true; do
  sleep "$INTERVAL"
  echo "AGENT_LOOP_TICK_book_ingest {\"prompt\":\"Poll book-ratings ingest: run watch-ingest tick (publish/commit/push if count grew). Check data/watch.log and ingest.log.\"}"
  tick
done
