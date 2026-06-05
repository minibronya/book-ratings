import Database from "better-sqlite3";
import path from "node:path";
import type { BookRating, DataQualityReport } from "./types";

export type BookSortKey =
  | "title"
  | "publishYear"
  | "readerRating"
  | "readerRatingsCount"
  | "bookmarksScore"
  | "bookmarksReviewCount"
  | "combinedScore";

export type BookQuery = {
  minYear?: number;
  maxYear?: number;
  minReaderRatings?: number;
  search?: string;
  requireBookmarks?: boolean;
  requireReader?: boolean;
  genre?: string;
  genreExact?: boolean;
  sort?: BookSortKey;
  sortDir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
};

const sortColumns: Record<BookSortKey, string> = {
  title: "title",
  publishYear: "publish_year",
  readerRating: "reader_rating",
  readerRatingsCount: "reader_ratings_count",
  bookmarksScore: "bookmarks_score",
  bookmarksReviewCount: "bookmarks_review_count",
  combinedScore:
    "case when reader_rating is not null and bookmarks_score is not null then ((reader_rating * 20.0) + bookmarks_score) / 2.0 else null end",
};

export const MIN_BOOKMARKS_REVIEWS = 1;
export const MIN_PUBLISH_YEAR = 1990;

const databasePath =
  process.env.BOOK_RATINGS_DB ??
  path.join(process.cwd(), "data", "book-ratings.sqlite");

let db: Database.Database | null = null;

export function getDb() {
  if (!db) {
    db = new Database(databasePath, { fileMustExist: true, readonly: true });
  }

  return db;
}

export function closeDb() {
  db?.close();
  db = null;
}

export function ensureSchema(database: Database.Database) {
  database.exec(`
    create table if not exists books (
      id text primary key,
      isbn13 text not null,
      goodreads_id text,
      title text not null,
      authors text,
      publish_year integer,
      genres text,
      reader_rating real,
      reader_ratings_count integer,
      reader_url text,
      reader_status text not null default 'pending',
      bookmarks_grade text,
      bookmarks_review_count integer,
      rave_count integer not null default 0,
      positive_count integer not null default 0,
      mixed_count integer not null default 0,
      pan_count integer not null default 0,
      bookmarks_score real,
      bookmarks_url text,
      bookmarks_status text not null default 'pending',
      updated_at text not null
    );
  `);
  migratePublishedSchema(database);
  database.exec(`
    create index if not exists idx_books_publish_year on books (publish_year);
    create index if not exists idx_books_reader_rating on books (reader_rating);
    create index if not exists idx_books_reader_ratings_count on books (reader_ratings_count);
    create index if not exists idx_books_bookmarks_score on books (bookmarks_score);
    create index if not exists idx_books_title on books (title);
  `);
}

function migratePublishedSchema(database: Database.Database) {
  const columns = database
    .prepare("pragma table_info(books)")
    .all() as Array<{ name: string }>;
  if (columns.length === 0) {
    return;
  }

  const names = new Set(columns.map((column) => column.name));
  const renames: Array<[string, string]> = [
    ["hardcover_rating", "reader_rating"],
    ["hardcover_ratings_count", "reader_ratings_count"],
    ["hardcover_url", "reader_url"],
    ["hardcover_status", "reader_status"],
    ["work_key", "goodreads_id"],
  ];

  for (const [from, to] of renames) {
    if (names.has(from) && !names.has(to)) {
      database.exec(`alter table books rename column ${from} to ${to}`);
      names.delete(from);
      names.add(to);
    }
  }

  if (!names.has("goodreads_id")) {
    database.exec(`alter table books add column goodreads_id text`);
  }
}

export function queryBooks(query: BookQuery = {}) {
  const pageSize = Math.min(Math.max(query.pageSize ?? 50, 1), 100);
  const page = Math.max(query.page ?? 1, 1);
  const offset = (page - 1) * pageSize;
  const sort = query.sort ?? "combinedScore";
  const sortColumn = sortColumns[sort];

  const baseConditions = [
    "bookmarks_status = 'matched'",
    "bookmarks_review_count >= ?",
    "(publish_year is null or publish_year >= ?)",
  ];
  const baseParams: (number | string)[] = [
    MIN_BOOKMARKS_REVIEWS,
    MIN_PUBLISH_YEAR,
  ];

  const conditions = [...baseConditions];
  const params = [...baseParams];

  if (typeof query.minYear === "number") {
    conditions.push("publish_year >= ?");
    params.push(query.minYear);
  }

  if (typeof query.maxYear === "number") {
    conditions.push("publish_year <= ?");
    params.push(query.maxYear);
  }

  if (typeof query.minReaderRatings === "number" && query.minReaderRatings > 0) {
    conditions.push("reader_ratings_count >= ?");
    params.push(query.minReaderRatings);
  }

  if (query.requireReader) {
    conditions.push(
      "reader_rating is not null and reader_ratings_count is not null",
    );
  }

  if (query.requireBookmarks) {
    conditions.push("bookmarks_score is not null and bookmarks_score > 0");
  }

  if (query.search?.trim()) {
    conditions.push("(title like ? or authors like ?)");
    const term = `%${query.search.trim()}%`;
    params.push(term, term);
  }

  const genreFacetConditions = [...conditions];
  const genreFacetParams = [...params];

  if (query.genre?.trim()) {
    if (query.genreExact) {
      conditions.push("genres = ?");
      params.push(query.genre.trim());
    } else {
      conditions.push("(',' || genres || ',') like ?");
      params.push(`%,${query.genre.trim()},%`);
    }
  }

  const whereClause = conditions.join(" and ");
  const countRow = getDb()
    .prepare(`select count(*) as count from books where ${whereClause}`)
    .get(...params) as { count: number };

  const direction = query.sortDir === "asc" ? "asc" : "desc";
  const orderExpression =
    sort === "title"
      ? `${sortColumn} collate nocase ${direction}`
      : `${sortColumn} ${direction} nulls last`;

  const rows = getDb()
    .prepare(
      `
      select *
      from books
      where ${whereClause}
      order by ${orderExpression}, title collate nocase asc
      limit ? offset ?
    `,
    )
    .all(...params, pageSize, offset) as Record<string, unknown>[];

  return {
    books: rows.map(mapBookRow),
    total: countRow.count,
    page,
    pageSize,
    pageCount: Math.max(Math.ceil(countRow.count / pageSize), 1),
    genreOptions: collectGenreOptions(genreFacetConditions, genreFacetParams),
    yearBounds: collectYearBounds(baseConditions, baseParams),
  };
}

function collectYearBounds(
  baseConditions: string[],
  baseParams: (number | string)[],
) {
  const row = getDb()
    .prepare(
      `
      select min(publish_year) as minYear, max(publish_year) as maxYear
      from books
      where ${baseConditions.join(" and ")} and publish_year is not null
    `,
    )
    .get(...baseParams) as { minYear: number | null; maxYear: number | null };

  const fallback = new Date().getFullYear();
  return {
    min: row.minYear ?? MIN_PUBLISH_YEAR,
    max: row.maxYear ?? fallback,
  };
}

function collectGenreOptions(
  baseConditions: string[],
  baseParams: (number | string)[],
) {
  const rows = getDb()
    .prepare(
      `
      select distinct genres
      from books
      where ${baseConditions.join(" and ")} and genres is not null
    `,
    )
    .all(...baseParams) as { genres: string | null }[];

  const genres = new Set<string>();
  for (const row of rows) {
    if (!row.genres) {
      continue;
    }

    for (const genre of row.genres.split(",")) {
      const trimmed = genre.trim();
      if (trimmed) {
        genres.add(trimmed);
      }
    }
  }

  return [...genres].sort((a, b) => a.localeCompare(b));
}

export function readDataQuality(year = new Date().getFullYear()): DataQualityReport {
  const row = getDb()
    .prepare(
      `
      select
        count(*) as totalBooks,
        sum(case when publish_year = ? then 1 else 0 end) as currentYearBooks,
        sum(case when bookmarks_status = 'matched' then 1 else 0 end) as bookmarksMatched,
        sum(case when reader_rating is not null then 1 else 0 end) as readerMatched,
        max(updated_at) as latestUpdate
      from books
      where bookmarks_status = 'matched'
    `,
    )
    .get(year) as {
    totalBooks: number;
    currentYearBooks: number | null;
    bookmarksMatched: number | null;
    readerMatched: number | null;
    latestUpdate: string | null;
  };

  return {
    totalBooks: row.totalBooks,
    currentYearBooks: row.currentYearBooks ?? 0,
    bookmarksMatched: row.bookmarksMatched ?? 0,
    readerMatched: row.readerMatched ?? 0,
    latestUpdate: row.latestUpdate,
  };
}

export function mapBookRow(row: Record<string, unknown>): BookRating {
  const readerRating = nullableNumber(row.reader_rating);
  const bookmarksScore = nullableNumber(row.bookmarks_score);

  return {
    id: row.id as string,
    isbn13: row.isbn13 as string,
    goodreadsId: nullableString(row.goodreads_id),
    title: row.title as string,
    authors: nullableString(row.authors),
    publishYear: nullableNumber(row.publish_year),
    genres: nullableString(row.genres),
    readerRating,
    readerRatingsCount: nullableNumber(row.reader_ratings_count),
    readerUrl: nullableString(row.reader_url),
    readerStatus: row.reader_status as BookRating["readerStatus"],
    bookmarksGrade: nullableString(row.bookmarks_grade),
    bookmarksReviewCount: nullableNumber(row.bookmarks_review_count),
    raveCount: (row.rave_count as number) ?? 0,
    positiveCount: (row.positive_count as number) ?? 0,
    mixedCount: (row.mixed_count as number) ?? 0,
    panCount: (row.pan_count as number) ?? 0,
    bookmarksScore,
    combinedScore: combinedScore(readerRating, bookmarksScore),
    bookmarksUrl: nullableString(row.bookmarks_url),
    bookmarksStatus: row.bookmarks_status as BookRating["bookmarksStatus"],
    updatedAt: row.updated_at as string,
  };
}

function nullableString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function nullableNumber(value: unknown) {
  return typeof value === "number" ? value : null;
}

export function combinedScore(
  readerRating: number | null,
  bookmarksScore: number | null,
) {
  if (readerRating === null || bookmarksScore === null || bookmarksScore <= 0) {
    return null;
  }

  return Math.round(((readerRating * 20 + bookmarksScore) / 2) * 100) / 100;
}
