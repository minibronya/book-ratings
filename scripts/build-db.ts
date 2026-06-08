import path from "node:path";
import type { BookRating } from "../src/lib/types";
import { combinedScore, currentPublishYear } from "../src/lib/db";
import { fetchBookmarksByIsbn, fetchBookmarksIsbnList } from "../src/lib/ingest/bookmarks";
import {
  openRawDatabase,
  openWritableDatabase,
  readRawRows,
  replaceBooks,
  seedRawCatalog,
  upsertRawRow,
  type RawBookRow,
} from "../src/lib/ingest/database";
import {
  cleanStoredGenres,
  fetchGoodreadsWithRetry,
  storeRawGenres,
  type GoodreadsParseResult,
} from "../src/lib/ingest/goodreads";
import { sampleBooks } from "./sample-data";

const args = new Set(process.argv.slice(2));
const databasePath =
  process.env.BOOK_RATINGS_DB ??
  path.join(process.cwd(), "data", "book-ratings.sqlite");
const rawDatabasePath =
  process.env.BOOK_RATINGS_RAW_DB ??
  path.join(process.cwd(), "data", "book-ratings.raw.sqlite");

const CONCURRENCY = Number(process.env.INGEST_CONCURRENCY ?? "4");
const INTER_BATCH_MS = Number(process.env.INGEST_INTER_BATCH_MS ?? "250");
const MAX_BLOCKED_BATCHES = Number(process.env.GOODREADS_MAX_BLOCKED_BATCHES ?? "3");

async function main() {
  if (args.has("--sample")) {
    const database = openWritableDatabase(databasePath);
    replaceBooks(database, sampleBooks);
    database.close();
    console.log(`Wrote ${sampleBooks.length} books to ${databasePath}`);
    return;
  }

  if (args.has("--ingest") || args.has("--publish")) {
    if (args.has("--ingest")) {
      await ingestCatalog();
    }
    if (args.has("--publish")) {
      await publishCatalog();
    }
    return;
  }

  await ingestCatalog();
  await publishCatalog();
}

async function ingestCatalog() {
  console.log("Loading Book Marks ISBN catalog...");
  const isbnList = await fetchBookmarksIsbnList();
  const catalogLimit = Number(process.env.BOOKMARKS_CATALOG_LIMIT ?? "0");
  const catalog = catalogLimit > 0 ? isbnList.slice(0, catalogLimit) : isbnList;
  console.log(`Catalog size: ${catalog.length} ISBNs.`);

  const updatedAt = new Date().toISOString();
  const rawDatabase = openRawDatabase(rawDatabasePath);
  seedRawCatalog(rawDatabase, catalog, updatedAt);

  // 1) Backlog: rows that already have Book Marks but still need Goodreads.
  await ingestGoodreadsBacklog(rawDatabase, updatedAt);
  // 2) New rows: fetch Book Marks then Goodreads so each published row is complete.
  await ingestNewBookmarks(rawDatabase, updatedAt);

  rawDatabase.close();
}

async function ingestGoodreadsBacklog(
  rawDatabase: ReturnType<typeof openRawDatabase>,
  updatedAt: string,
) {
  const pending = readRawRows(
    rawDatabase,
    "bookmarks_status = 'matched' and reader_status in ('pending', 'error')",
  );
  const maxLookups = Number(
    process.env.GOODREADS_MAX_LOOKUPS ?? String(pending.length),
  );
  const rows = pending.slice(0, Math.min(maxLookups, pending.length));
  if (rows.length === 0) {
    return;
  }

  console.log(`Goodreads backlog: ${rows.length} rows (concurrency ${CONCURRENCY}).`);
  await processGoodreads(rawDatabase, rows, updatedAt);
}

async function ingestNewBookmarks(
  rawDatabase: ReturnType<typeof openRawDatabase>,
  updatedAt: string,
) {
  const pending = readRawRows(rawDatabase, "bookmarks_status = 'pending'");
  const maxLookups = Number(
    process.env.BOOKMARKS_MAX_LOOKUPS ?? String(pending.length),
  );
  const rows = pending.slice(0, Math.min(maxLookups, pending.length));
  if (rows.length === 0) {
    return;
  }

  console.log(`Book Marks: ${rows.length} rows (concurrency ${CONCURRENCY}).`);

  let processed = 0;
  let matched = 0;
  let blockedBatches = 0;

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    const bookmarkResults = await Promise.all(
      batch.map((row) => fetchBookmarksByIsbn(row.isbn13)),
    );

    const merged: RawBookRow[] = batch.map((row, idx) => {
      const result = bookmarkResults[idx];
      return {
        ...row,
        bookmarksGrade: result.grade,
        bookmarksReviewCount: result.reviewCount,
        raveCount: result.counts.rave,
        positiveCount: result.counts.positive,
        mixedCount: result.counts.mixed,
        panCount: result.counts.pan,
        bookmarksScore: result.bookmarksScore,
        bookmarksUrl: result.url,
        bookmarksStatus: result.status,
        updatedAt,
      };
    });

    // Only the matched ones need Goodreads; persist the rest immediately.
    const needGoodreads = merged.filter((row) => row.bookmarksStatus === "matched");
    for (const row of merged) {
      if (row.bookmarksStatus !== "matched") {
        upsertRawRow(rawDatabase, row);
      }
    }

    if (needGoodreads.length > 0) {
      const goodreadsResults = await Promise.all(
        needGoodreads.map((row) => fetchGoodreadsWithRetry(row.isbn13)),
      );
      const allBlocked = goodreadsResults.every((r) => r.status === "blocked");
      goodreadsResults.forEach((result, idx) => {
        upsertRawRow(rawDatabase, mergeGoodreads(needGoodreads[idx], result, updatedAt));
      });
      matched += needGoodreads.length;

      if (allBlocked) {
        blockedBatches += 1;
        if (blockedBatches >= MAX_BLOCKED_BATCHES) {
          console.log(
            `Stopping Book Marks ingest after ${blockedBatches} fully-blocked Goodreads batches.`,
          );
          return;
        }
      } else {
        blockedBatches = 0;
      }
    }

    processed += batch.length;
    if (processed % 100 === 0 || processed === rows.length) {
      console.log(
        `Book Marks processed: ${processed}/${rows.length} (${matched} bookmark-matched).`,
      );
    }

    if (INTER_BATCH_MS > 0) {
      await sleep(INTER_BATCH_MS);
    }
  }
}

async function processGoodreads(
  rawDatabase: ReturnType<typeof openRawDatabase>,
  rows: RawBookRow[],
  updatedAt: string,
) {
  let processed = 0;
  let matched = 0;
  let blockedBatches = 0;

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((row) => fetchGoodreadsWithRetry(row.isbn13)),
    );

    const allBlocked = results.every((r) => r.status === "blocked");
    results.forEach((result, idx) => {
      if (result.status === "matched") {
        matched += 1;
      }
      upsertRawRow(rawDatabase, mergeGoodreads(batch[idx], result, updatedAt));
    });

    if (allBlocked) {
      blockedBatches += 1;
      if (blockedBatches >= MAX_BLOCKED_BATCHES) {
        console.log(
          `Stopping Goodreads backlog after ${blockedBatches} fully-blocked batches.`,
        );
        return;
      }
    } else {
      blockedBatches = 0;
    }

    processed += batch.length;
    if (processed % 100 === 0 || processed === rows.length) {
      const rate = Math.round((matched / processed) * 100);
      console.log(
        `Goodreads processed: ${processed}/${rows.length} (${matched} matched, ${rate}%).`,
      );
    }

    if (INTER_BATCH_MS > 0) {
      await sleep(INTER_BATCH_MS);
    }
  }
}

function mergeGoodreads(
  row: RawBookRow,
  result: GoodreadsParseResult,
  updatedAt: string,
): RawBookRow {
  const genres = storeRawGenres(result.genres);
  return {
    ...row,
    title: result.title ?? row.title,
    authors: result.authors ?? row.authors,
    publishYear: result.publishYear ?? row.publishYear,
    genres: genres ?? row.genres,
    goodreadsId: result.goodreadsId,
    readerRating: result.readerRating,
    readerRatingsCount: result.readerRatingsCount,
    readerUrl: result.readerUrl,
    readerStatus: result.status === "blocked" ? "error" : result.status,
    updatedAt,
  };
}

async function publishCatalog() {
  const rawDatabase = openRawDatabase(rawDatabasePath);
  const matched = readRawRows(
    rawDatabase,
    "bookmarks_status = 'matched' and reader_status != 'pending' and title not like 'ISBN %'",
  );
  rawDatabase.close();

  const updatedAt = new Date().toISOString();
  const maxYear = currentPublishYear();
  const deduped = dedupeBooks(
    matched
      .filter(
        (row) => row.publishYear === null || row.publishYear <= maxYear,
      )
      .map((row) => rawRowToBook(row, updatedAt)),
  );

  const database = openWritableDatabase(databasePath);
  replaceBooks(database, deduped);
  database.close();

  const withGoodreads = deduped.filter((book) => book.readerRating !== null).length;
  const withTitles = deduped.filter((book) => !book.title.startsWith("ISBN ")).length;

  console.log(`Published ${deduped.length} books to ${databasePath}`);
  console.log(
    `Raw ready rows: ${matched.length}; with titles: ${withTitles}; with Goodreads ratings: ${withGoodreads}`,
  );
}

function rawRowToBook(row: RawBookRow, updatedAt: string): BookRating {
  const readerRating = row.readerRating;
  const bookmarksScore = row.bookmarksScore;

  return {
    id: row.goodreadsId ?? row.isbn13,
    isbn13: row.isbn13,
    goodreadsId: row.goodreadsId,
    title: row.title,
    authors: row.authors,
    publishYear: row.publishYear,
    genres: cleanStoredGenres(row.genres),
    readerRating,
    readerRatingsCount: row.readerRatingsCount,
    readerUrl: row.readerUrl,
    readerStatus: row.readerStatus,
    bookmarksGrade: row.bookmarksGrade,
    bookmarksReviewCount: row.bookmarksReviewCount,
    raveCount: row.raveCount,
    positiveCount: row.positiveCount,
    mixedCount: row.mixedCount,
    panCount: row.panCount,
    bookmarksScore,
    combinedScore: combinedScore(readerRating, bookmarksScore),
    bookmarksUrl: row.bookmarksUrl,
    bookmarksStatus: row.bookmarksStatus,
    updatedAt,
  };
}

function dedupeBooks(books: BookRating[]) {
  const byKey = new Map<string, BookRating>();

  for (const book of books) {
    const key = book.goodreadsId ?? book.isbn13;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, book);
      continue;
    }

    const existingReviews = existing.bookmarksReviewCount ?? 0;
    const candidateReviews = book.bookmarksReviewCount ?? 0;
    const existingReader = existing.readerRatingsCount ?? 0;
    const candidateReader = book.readerRatingsCount ?? 0;

    if (
      candidateReviews > existingReviews ||
      (candidateReviews === existingReviews && candidateReader > existingReader)
    ) {
      byKey.set(key, book);
    }
  }

  return [...byKey.values()].map((book) => ({
    ...book,
    id: book.goodreadsId ?? book.isbn13,
  }));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
