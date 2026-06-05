#!/usr/bin/env bash
# Poll ingest progress; publish+push only when titled book count grows.
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

stats() {
  npx tsx -e "
    import { openRawDatabase, countRawRows } from './src/lib/ingest/database.ts';
    import Database from 'better-sqlite3';
    const raw = openRawDatabase('data/book-ratings.raw.sqlite');
    const rawCounts = {
      total: countRawRows(raw),
      bmMatched: countRawRows(raw, \"bookmarks_status = 'matched'\"),
      grMatched: countRawRows(raw, \"reader_status = 'matched'\"),
      grPending: countRawRows(raw, \"bookmarks_status = 'matched' and reader_status = 'pending'\"),
      grReady: countRawRows(raw, \"bookmarks_status = 'matched' and reader_status != 'pending'\"),
    };
    raw.close();
    let published = 0;
    let titled = 0;
    let withGr = 0;
    try {
      const pub = new Database('data/book-ratings.sqlite', { readonly: true });
      published = (pub.prepare('select count(*) as c from books').get() as { c: number }).c;
      titled = (pub.prepare(\"select count(*) as c from books where title not like 'ISBN %'\").get() as { c: number }).c;
      withGr = (pub.prepare('select count(*) as c from books where reader_rating is not null').get() as { c: number }).c;
      pub.close();
    } catch {}
    console.log(JSON.stringify({ ...rawCounts, published, titled, withGr }));
  "
}

last_titled() {
  if [[ -f "$STATE" ]]; then
    cat "$STATE"
  else
    echo "0"
  fi
}

save_titled() {
  echo "$1" > "$STATE"
}

tick() {
  local json titled last count
  json="$(stats)"
  log "status $json"
  titled="$(echo "$json" | npx tsx -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).titled)')"
  last="$(last_titled)"

  npm run db:publish >>"$LOG" 2>&1
  npm run db:validate >>"$LOG" 2>&1 || true

  count="$(npx tsx -e "
    import Database from 'better-sqlite3';
    const db = new Database('data/book-ratings.sqlite', { readonly: true });
    const row = db.prepare(\"select count(*) as c from books where title not like 'ISBN %'\").get() as { c: number };
    db.close();
    console.log(row.c);
  ")"

  if [[ "$count" != "$last" && "$count" -gt 0 ]]; then
    log "titled books changed: $last -> $count; committing"
    git add data/book-ratings.sqlite
    if git diff --cached --quiet; then
      log "no sqlite diff after publish"
    else
      git commit -m "Refresh book ratings database ($count titled books)."
      git push
      log "pushed $count titled books to origin"
    fi
    save_titled "$count"
  else
    log "no titled-book change (titled=$count last=$last); skipping push"
  fi
}

log "watch-ingest starting (interval=${INTERVAL}s)"
tick

while true; do
  sleep "$INTERVAL"
  echo "AGENT_LOOP_TICK_book_ingest {\"prompt\":\"Poll book-ratings ingest\"}"
  tick
done
