import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { openRawDatabase } from "../src/lib/ingest/database";
import {
  fetchGoodreadsWithRetry,
  hasBlocklistedGenreInStored,
  storeRawGenres,
} from "../src/lib/ingest/goodreads";

const publishedDatabasePath =
  process.env.BOOK_RATINGS_DB ??
  path.join(process.cwd(), "data", "book-ratings.sqlite");
const rawDatabasePath =
  process.env.BOOK_RATINGS_RAW_DB ??
  path.join(process.cwd(), "data", "book-ratings.raw.sqlite");

const CONCURRENCY = Number(process.env.INGEST_CONCURRENCY ?? "2");
const INTER_BATCH_MS = Number(process.env.INGEST_INTER_BATCH_MS ?? "750");
const JITTER_MS = Number(process.env.INGEST_JITTER_MS ?? "400");
const MAX_BLOCKED_BATCHES = Number(process.env.GOODREADS_MAX_BLOCKED_BATCHES ?? "3");
const MAX_DEAD_BATCHES = Number(process.env.GOODREADS_MAX_DEAD_BATCHES ?? "5");
const MAX_LOOKUPS = Number(process.env.REFRESH_MAX_LOOKUPS ?? "1500");
const LOG_EVERY = Number(process.env.REFRESH_LOG_EVERY ?? "50");

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
      refreshed_at text not null
    );
  `);

  const lookupGenres = rawDatabase.prepare(
    "select genres from raw_books where goodreads_id = ? limit 1",
  );
  const loggedIds = new Set(
    (
      rawDatabase
        .prepare("select goodreads_id from genre_refresh_log")
        .all() as Array<{ goodreads_id: string }>
    ).map((row) => row.goodreads_id),
  );

  // A book is "pending" if its raw genres still look like the old cleaned set
  // (no blocklisted shelves) AND we haven't already reached a terminal outcome
  // for it. Transient blocked/error attempts are intentionally NOT logged, so
  // they remain pending and get retried on a later chunk after backoff.
  const allPending = books.filter((book) => {
    if (loggedIds.has(book.goodreadsId)) {
      return false;
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
    `Settings: concurrency=${CONCURRENCY}, inter-batch=${INTER_BATCH_MS}ms (+0-${JITTER_MS}ms jitter), log every ${LOG_EVERY}.`,
  );

  const updateGenres = rawDatabase.prepare(`
    update raw_books
    set genres = ?, updated_at = ?
    where goodreads_id = ?
  `);
  const logOutcome = rawDatabase.prepare(`
    insert into genre_refresh_log (goodreads_id, status, refreshed_at)
    values (?, ?, ?)
    on conflict(goodreads_id) do update set
      status = excluded.status,
      refreshed_at = excluded.refreshed_at
  `);

  const updatedAt = new Date().toISOString();
  let processed = 0;
  let updated = 0;
  let failed = 0;
  let blockedBatches = 0;
  let deadBatches = 0;
  let exitCode = EXIT_CHUNK_OK;

  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    const batch = pending.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((book) => fetchGoodreadsWithRetry(book.isbn13)),
    );

    let batchBlocked = 0;
    let batchReachedServer = 0; // matched or not_found => server responded, not a block

    rawDatabase.transaction(() => {
      results.forEach((result, idx) => {
        const book = batch[idx];
        processed += 1;

        if (result.status === "blocked") {
          failed += 1;
          batchBlocked += 1;
          return; // do not log: retry later
        }

        if (result.status === "error") {
          failed += 1;
          return; // transient: do not log, retry later
        }

        if (result.status !== "matched") {
          // not_found / not_reviewed: server responded, terminal.
          batchReachedServer += 1;
          failed += 1;
          logOutcome.run(book.goodreadsId, result.status, updatedAt);
          return;
        }

        batchReachedServer += 1;
        const genres = storeRawGenres(result.genres);
        if (!genres) {
          failed += 1;
          logOutcome.run(book.goodreadsId, "no_genres", updatedAt);
          return;
        }

        const change = updateGenres.run(genres, updatedAt, book.goodreadsId);
        if (change.changes > 0) {
          updated += change.changes;
        }
        logOutcome.run(book.goodreadsId, "matched", updatedAt);
      });
    })();

    if (batchBlocked === batch.length && batch.length > 0) {
      blockedBatches += 1;
      if (blockedBatches >= MAX_BLOCKED_BATCHES) {
        logLine(
          `BLOCKED: ${blockedBatches} fully-blocked batches (403/429). Backing off.`,
        );
        exitCode = EXIT_THROTTLED;
        break;
      }
    } else {
      blockedBatches = 0;
    }

    if (batchReachedServer === 0) {
      deadBatches += 1;
      if (deadBatches >= MAX_DEAD_BATCHES) {
        logLine(
          `THROTTLED: ${deadBatches} consecutive batches reached no server. Backing off.`,
        );
        exitCode = EXIT_THROTTLED;
        break;
      }
    } else {
      deadBatches = 0;
    }

    if (processed <= CONCURRENCY || processed % LOG_EVERY === 0 || processed === pending.length) {
      logLine(
        `Processed ${processed}/${pending.length} this chunk (${updated} rows updated, ${failed} failed).`,
      );
    }

    if (INTER_BATCH_MS > 0 || JITTER_MS > 0) {
      await sleep(INTER_BATCH_MS + Math.floor(Math.random() * (JITTER_MS + 1)));
    }
  }

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
