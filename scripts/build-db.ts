import path from "node:path";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import type { BookRating } from "../src/lib/types";
import { combinedScore } from "../src/lib/db";
import {
  enrichWithBookmarks,
  fetchBookmarksIsbnList,
} from "../src/lib/ingest/bookmarks";
import { openWritableDatabase, replaceBooks } from "../src/lib/ingest/database";
import { enrichWithHardcover } from "../src/lib/ingest/hardcover";
import { enrichWithOpenLibrary } from "../src/lib/ingest/openlibrary";
import { sampleBooks } from "./sample-data";

const args = new Set(process.argv.slice(2));
const databasePath =
  process.env.BOOK_RATINGS_DB ??
  path.join(process.cwd(), "data", "book-ratings.sqlite");

async function main() {
  const books = args.has("--sample")
    ? sampleBooks
    : await buildFromLiveSources();

  const database = openWritableDatabase(databasePath);
  replaceBooks(database, books);
  database.close();

  console.log(`Wrote ${books.length} books to ${databasePath}`);
}

async function buildFromLiveSources(): Promise<BookRating[]> {
  console.log("Loading Book Marks ISBN catalog...");
  const isbnList = await fetchBookmarksIsbnList();
  console.log(`Found ${isbnList.length} unique ISBN-13 entries.`);

  const maxCatalog = Number(process.env.BOOKMARKS_CATALOG_LIMIT ?? "500");
  const catalog = isbnList.slice(0, maxCatalog);
  const updatedAt = new Date().toISOString();

  let books: BookRating[] = catalog.map((isbn13) => ({
    id: isbn13,
    isbn13,
    title: `ISBN ${isbn13}`,
    authors: null,
    publishYear: null,
    genres: null,
    hardcoverRating: null,
    hardcoverRatingsCount: null,
    hardcoverUrl: null,
    hardcoverStatus: "pending",
    bookmarksGrade: null,
    bookmarksReviewCount: null,
    raveCount: 0,
    positiveCount: 0,
    mixedCount: 0,
    panCount: 0,
    bookmarksScore: null,
    combinedScore: null,
    bookmarksUrl: null,
    bookmarksStatus: "pending",
    updatedAt,
  }));

  const cachedBookmarks = loadExistingBookmarksCache(databasePath);
  let reusedBookmarks = 0;
  books = books.map((book) => {
    const cached = cachedBookmarks.get(book.isbn13);
    if (!cached) {
      return book;
    }

    reusedBookmarks += 1;
    return {
      ...book,
      ...cached,
      combinedScore: combinedScore(
        book.hardcoverRating ?? cached.hardcoverRating ?? null,
        cached.bookmarksScore ?? null,
      ),
      updatedAt,
    };
  });
  console.log(`Reusing ${reusedBookmarks} prior Book Marks attempts.`);

  const bookmarksLimit = Number(
    process.env.BOOKMARKS_MAX_LOOKUPS ?? String(books.length),
  );
  const pendingBookmarks = books.filter(
    (book) => book.bookmarksStatus === "pending",
  );
  const bookmarkLookupLimit = Math.min(bookmarksLimit, pendingBookmarks.length);
  console.log(`Looking up ${bookmarkLookupLimit} Book Marks widgets.`);

  await enrichWithBookmarks(pendingBookmarks, {
    maxLookups: bookmarkLookupLimit,
    delayMs: Number(process.env.BOOKMARKS_DELAY_MS ?? "500"),
  });

  books = books
    .map((book) => ({
      ...book,
      combinedScore: combinedScore(book.hardcoverRating, book.bookmarksScore),
    }))
    .filter((book) => book.bookmarksStatus === "matched");

  console.log(`Keeping ${books.length} books with Book Marks reviews.`);

  const openLibraryLimit = Number(
    process.env.OPENLIBRARY_MAX_LOOKUPS ?? String(books.length),
  );
  console.log(`Enriching up to ${openLibraryLimit} books with Open Library metadata.`);
  await enrichWithOpenLibrary(books, {
    maxLookups: openLibraryLimit,
    delayMs: Number(process.env.OPENLIBRARY_DELAY_MS ?? "200"),
  });

  const hardcoverLimit = Number(
    process.env.HARDCOVER_MAX_LOOKUPS ?? String(books.length),
  );
  console.log(`Enriching up to ${hardcoverLimit} books with Hardcover ratings.`);
  await enrichWithHardcover(books, {
    maxLookups: hardcoverLimit,
    delayMs: Number(process.env.HARDCOVER_DELAY_MS ?? "300"),
  });

  return books.map((book) => ({
    ...book,
    combinedScore: combinedScore(book.hardcoverRating, book.bookmarksScore),
    updatedAt,
  }));
}

function loadExistingBookmarksCache(databasePath: string) {
  const cache = new Map<string, Partial<BookRating>>();

  if (!existsSync(databasePath)) {
    return cache;
  }

  const database = new Database(databasePath, { readonly: true });
  const rows = database
    .prepare(
      `
      select
        isbn13,
        bookmarks_grade,
        bookmarks_review_count,
        rave_count,
        positive_count,
        mixed_count,
        pan_count,
        bookmarks_score,
        bookmarks_url,
        bookmarks_status,
        hardcover_rating,
        hardcover_ratings_count,
        hardcover_url,
        hardcover_status,
        title,
        authors,
        publish_year
      from books
      where bookmarks_status != 'pending'
    `,
    )
    .all() as Array<Record<string, unknown>>;

  database.close();

  for (const row of rows) {
    cache.set(row.isbn13 as string, {
      title: row.title as string,
      authors: (row.authors as string | null) ?? null,
      publishYear: (row.publish_year as number | null) ?? null,
      bookmarksGrade: (row.bookmarks_grade as string | null) ?? null,
      bookmarksReviewCount: (row.bookmarks_review_count as number | null) ?? null,
      raveCount: (row.rave_count as number) ?? 0,
      positiveCount: (row.positive_count as number) ?? 0,
      mixedCount: (row.mixed_count as number) ?? 0,
      panCount: (row.pan_count as number) ?? 0,
      bookmarksScore: (row.bookmarks_score as number | null) ?? null,
      bookmarksUrl: (row.bookmarks_url as string | null) ?? null,
      bookmarksStatus: row.bookmarks_status as BookRating["bookmarksStatus"],
      hardcoverRating: (row.hardcover_rating as number | null) ?? null,
      hardcoverRatingsCount:
        (row.hardcover_ratings_count as number | null) ?? null,
      hardcoverUrl: (row.hardcover_url as string | null) ?? null,
      hardcoverStatus: row.hardcover_status as BookRating["hardcoverStatus"],
    });
  }

  return cache;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
