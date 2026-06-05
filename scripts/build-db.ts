import path from "node:path";
import type { BookRating } from "../src/lib/types";
import { combinedScore } from "../src/lib/db";
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
  cleanGenres,
  enrichGoodreadsRows,
  fetchGoodreadsByIsbn,
} from "../src/lib/ingest/goodreads";
import { sampleBooks } from "./sample-data";

const args = new Set(process.argv.slice(2));
const databasePath =
  process.env.BOOK_RATINGS_DB ??
  path.join(process.cwd(), "data", "book-ratings.sqlite");
const rawDatabasePath =
  process.env.BOOK_RATINGS_RAW_DB ??
  path.join(process.cwd(), "data", "book-ratings.raw.sqlite");

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
  const catalog =
    catalogLimit > 0 ? isbnList.slice(0, catalogLimit) : isbnList;
  console.log(`Catalog size: ${catalog.length} ISBNs.`);

  const updatedAt = new Date().toISOString();
  const rawDatabase = openRawDatabase(rawDatabasePath);
  seedRawCatalog(rawDatabase, catalog, updatedAt);

  await ingestBookmarks(rawDatabase, updatedAt);
  await ingestGoodreads(rawDatabase, updatedAt);
  rawDatabase.close();
}

async function ingestBookmarks(
  rawDatabase: ReturnType<typeof openRawDatabase>,
  updatedAt: string,
) {
  const pending = readRawRows(rawDatabase, "bookmarks_status = 'pending'");
  const maxLookups = Number(
    process.env.BOOKMARKS_MAX_LOOKUPS ?? String(pending.length),
  );
  const lookupLimit = Math.min(maxLookups, pending.length);
  console.log(`Looking up ${lookupLimit} Book Marks widgets.`);

  let lookups = 0;
  let matches = 0;
  const bookmarksDelayMs = Number(process.env.BOOKMARKS_DELAY_MS ?? "500");
  const goodreadsDelayMs = Number(process.env.GOODREADS_DELAY_MS ?? "1000");

  for (const row of pending.slice(0, lookupLimit)) {
    const result = await fetchBookmarksByIsbn(row.isbn13);
    let updatedRow: RawBookRow = {
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
    upsertRawRow(rawDatabase, updatedRow);

    lookups += 1;
    if (result.status === "matched") {
      matches += 1;
      if (updatedRow.readerStatus === "pending") {
        updatedRow = await applyGoodreads(updatedRow, updatedAt);
        upsertRawRow(rawDatabase, updatedRow);
        await sleep(goodreadsDelayMs);
      }
    }

    if (lookups % 25 === 0) {
      const matchRate = Math.round((matches / lookups) * 100);
      console.log(
        `Book Marks lookups: ${lookups}/${lookupLimit} (${matches} matched, ${matchRate}%)`,
      );
    }

    await sleep(bookmarksDelayMs);
  }
}

async function ingestGoodreads(
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
  const lookupLimit = Math.min(maxLookups, pending.length);
  console.log(`Looking up ${lookupLimit} Goodreads pages.`);

  await enrichGoodreadsRows(pending.slice(0, lookupLimit), {
    delayMs: Number(process.env.GOODREADS_DELAY_MS ?? "1000"),
    maxLookups: lookupLimit,
    maxConsecutiveBlocks: Number(process.env.GOODREADS_MAX_BLOCKS ?? "5"),
    onProcessed: (row, result) => {
      upsertRawRow(
        rawDatabase,
        mergeGoodreads(row, result, updatedAt),
      );
    },
  });
}

async function applyGoodreads(row: RawBookRow, updatedAt: string) {
  const result = await fetchGoodreadsByIsbn(row.isbn13);
  return mergeGoodreads(row, result, updatedAt);
}

function mergeGoodreads(
  row: RawBookRow,
  result: Awaited<ReturnType<typeof fetchGoodreadsByIsbn>>,
  updatedAt: string,
): RawBookRow {
  const genres = cleanGenres(result.genres);
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
    "bookmarks_status = 'matched' and reader_status != 'pending'",
  );
  rawDatabase.close();

  const updatedAt = new Date().toISOString();
  const deduped = dedupeBooks(
    matched.map((row) => rawRowToBook(row, updatedAt)),
  );

  const database = openWritableDatabase(databasePath);
  replaceBooks(database, deduped);
  database.close();

  const withGoodreads = deduped.filter((book) => book.readerRating !== null).length;
  const withTitles = deduped.filter(
    (book) => !book.title.startsWith("ISBN "),
  ).length;

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
    genres: row.genres,
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
