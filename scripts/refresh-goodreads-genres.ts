import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { openRawDatabase } from "../src/lib/ingest/database";
import {
  fetchGoodreadsWithRetry,
  hasBlocklistedGenreInStored,
  storeRawGenres,
  type GoodreadsParseResult,
} from "../src/lib/ingest/goodreads";

const publishedDatabasePath =
  process.env.BOOK_RATINGS_DB ??
  path.join(process.cwd(), "data", "book-ratings.sqlite");
const rawDatabasePath =
  process.env.BOOK_RATINGS_RAW_DB ??
  path.join(process.cwd(), "data", "book-ratings.raw.sqlite");

const CONCURRENCY = Number(process.env.INGEST_CONCURRENCY ?? "12");
const REQUEST_DELAY_MS = Number(process.env.INGEST_REQUEST_DELAY_MS ?? "0");
// Abort the chunk if this many consecutive results come back blocked (the WAF
// token refresh is failing to recover); the loop will then back off.
const MAX_CONSECUTIVE_BLOCKS = Number(
  process.env.GOODREADS_MAX_CONSECUTIVE_BLOCKS ?? "20",
);
const MAX_LOOKUPS = Number(process.env.REFRESH_MAX_LOOKUPS ?? "3000");
const LOG_EVERY = Number(process.env.REFRESH_LOG_EVERY ?? "100");
// After this many transient errors (timeouts), give up on a book and mark it
// terminal so the run can finish instead of retrying it forever.
const MAX_ERROR_ATTEMPTS = Number(process.env.REFRESH_MAX_ERROR_ATTEMPTS ?? "4");

// Exit codes consumed by refresh-loop.sh.
const EXIT_CHUNK_OK = 0; // chunk processed, more may remain
const EXIT_ALL_DONE = 2; // nothing pending at start
const EXIT_THROTTLED = 3; // stopped early due to sustained blocking

type PublishedBook = {
  isbn13: string;
  goodreadsId: string;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logLine(message: string) {
  console.log(message);
  if (!process.stdout.isTTY && typeof process.stdout.fd === "number") {
    try {
      fs.fsyncSync(process.stdout.fd);
    } catch {
      // stdout may not be fsync-able when piped
    }
  }
}

async function main() {
  const published = new Database(publishedDatabasePath, { readonly: true });
  const books = published
    .prepare(
      `
      select isbn13, goodreads_id as goodreadsId
      from books
      where goodreads_id is not null
      order by goodreads_id asc
    `,
    )
    .all() as PublishedBook[];
  published.close();

  const rawDatabase = openRawDatabase(rawDatabasePath);
  rawDatabase.exec(`
    create table if not exists genre_refresh_log (
      goodreads_id text primary key,
      status text not null,
      attempts integer not null default 0,
      refreshed_at text not null
    );
  `);
  // Migrate older tables that predate the attempts column.
  const hasAttempts = (
    rawDatabase.prepare("pragma table_info(genre_refresh_log)").all() as Array<{
      name: string;
    }>
  ).some((c) => c.name === "attempts");
  if (!hasAttempts) {
    rawDatabase.exec(
      "alter table genre_refresh_log add column attempts integer not null default 0",
    );
  }

  const lookupGenres = rawDatabase.prepare(
    "select genres from raw_books where goodreads_id = ? limit 1",
  );
  const logMap = new Map<string, { status: string; attempts: number }>(
    (
      rawDatabase
        .prepare("select goodreads_id, status, attempts from genre_refresh_log")
        .all() as Array<{ goodreads_id: string; status: string; attempts: number }>
    ).map((row) => [row.goodreads_id, { status: row.status, attempts: row.attempts }]),
  );

  // A book is "pending" if its raw genres still look like the old cleaned set
  // (no blocklisted shelves) AND we haven't reached a terminal outcome for it.
  // A logged "error" is only terminal once it has exhausted its retry budget;
  // blocked attempts are never logged, so they always remain pending.
  const allPending = books.filter((book) => {
    const entry = logMap.get(book.goodreadsId);
    if (entry) {
      const terminal =
        entry.status !== "error" || entry.attempts >= MAX_ERROR_ATTEMPTS;
      if (terminal) {
        return false;
      }
    }
    const row = lookupGenres.get(book.goodreadsId) as
      | { genres: string | null }
      | undefined;
    return !hasBlocklistedGenreInStored(row?.genres ?? null);
  });

  if (allPending.length === 0) {
    logLine("Nothing to refresh. ALL_DONE");
    rawDatabase.close();
    process.exit(EXIT_ALL_DONE);
  }

  const pending = allPending.slice(0, Math.min(MAX_LOOKUPS, allPending.length));

  logLine(
    `Refreshing Goodreads genres: chunk of ${pending.length} (${allPending.length} pending of ${books.length} total).`,
  );
  logLine(
    `Settings: concurrency=${CONCURRENCY}, request-delay=${REQUEST_DELAY_MS}ms, log every ${LOG_EVERY}.`,
  );

  const updateGenres = rawDatabase.prepare(`
    update raw_books
    set genres = ?, updated_at = ?
    where goodreads_id = ?
  `);
  const logOutcome = rawDatabase.prepare(`
    insert into genre_refresh_log (goodreads_id, status, attempts, refreshed_at)
    values (?, ?, ?, ?)
    on conflict(goodreads_id) do update set
      status = excluded.status,
      attempts = excluded.attempts,
      refreshed_at = excluded.refreshed_at
  `);

  const updatedAt = new Date().toISOString();
  let processed = 0;
  let updated = 0;
  let failed = 0;
  let consecutiveBlocks = 0;
  let exitCode = EXIT_CHUNK_OK;
  let aborted = false;
  let nextIndex = 0;

  const recordOutcome = rawDatabase.transaction(
    (book: PublishedBook, result: GoodreadsParseResult) => {
      if (result.status === "matched") {
        const genres = storeRawGenres(result.genres);
        if (genres) {
          const change = updateGenres.run(genres, updatedAt, book.goodreadsId);
          if (change.changes > 0) {
            updated += change.changes;
          }
          logOutcome.run(book.goodreadsId, "matched", 0, updatedAt);
        } else {
          failed += 1;
          logOutcome.run(book.goodreadsId, "no_genres", 0, updatedAt);
        }
      } else if (result.status === "blocked") {
        // WAF block: never logged; backoff + token refresh handles recovery.
        failed += 1;
      } else if (result.status === "error") {
        // Transient timeout/network error: record an attempt so a permanently
        // failing book eventually becomes terminal instead of looping forever.
        failed += 1;
        const attempts = (logMap.get(book.goodreadsId)?.attempts ?? 0) + 1;
        logOutcome.run(book.goodreadsId, "error", attempts, updatedAt);
      } else {
        // not_found / not_reviewed: server responded, terminal.
        failed += 1;
        logOutcome.run(book.goodreadsId, result.status, 0, updatedAt);
      }
    },
  );

  async function worker() {
    while (!aborted) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= pending.length) {
        return;
      }
      const book = pending[i];
      const result = await fetchGoodreadsWithRetry(book.isbn13);

      recordOutcome(book, result);
      processed += 1;

      if (result.status === "blocked") {
        consecutiveBlocks += 1;
        if (consecutiveBlocks >= MAX_CONSECUTIVE_BLOCKS) {
          logLine(
            `THROTTLED: ${consecutiveBlocks} consecutive blocked results; WAF token refresh not recovering. Backing off.`,
          );
          exitCode = EXIT_THROTTLED;
          aborted = true;
          return;
        }
      } else if (result.status !== "error") {
        consecutiveBlocks = 0;
      }

      if (processed % LOG_EVERY === 0 || processed === pending.length) {
        logLine(
          `Processed ${processed}/${pending.length} this chunk (${updated} rows updated, ${failed} failed).`,
        );
      }

      if (REQUEST_DELAY_MS > 0) {
        await sleep(REQUEST_DELAY_MS);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker),
  );

  const remaining = allPending.length - updated;
  rawDatabase.close();

  logLine(
    `Chunk done. ${processed} processed, ${updated} rows updated, ${failed} failed. ~${Math.max(remaining, 0)} pending remain.`,
  );

  process.exit(exitCode);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
