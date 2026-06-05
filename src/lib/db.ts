import Database from "better-sqlite3";
import path from "node:path";
import type { BookRating, DataQualityReport } from "./types";

export type BookSortKey =
  | "title"
  | "publishYear"
  | "hardcoverRating"
  | "hardcoverRatingsCount"
  | "bookmarksScore"
  | "bookmarksReviewCount"
  | "combinedScore";

export type BookQuery = {
  minYear?: number;
  maxYear?: number;
  minHardcoverRatings?: number;
  search?: string;
  requireBookmarks?: boolean;
  requireHardcover?: boolean;
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
  hardcoverRating: "hardcover_rating",
  hardcoverRatingsCount: "hardcover_ratings_count",
  bookmarksScore: "bookmarks_score",
  bookmarksReviewCount: "bookmarks_review_count",
  combinedScore:
    "case when hardcover_rating is not null and bookmarks_score is not null then ((hardcover_rating * 20.0) + bookmarks_score) / 2.0 else null end",
};

export const MIN_HARDCOVER_RATINGS = 25;
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
      title text not null,
      authors text,
      publish_year integer,
      genres text,
      hardcover_rating real,
      hardcover_ratings_count integer,
      hardcover_url text,
      hardcover_status text not null default 'pending',
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

    create index if not exists idx_books_publish_year on books (publish_year);
    create index if not exists idx_books_hardcover_rating on books (hardcover_rating);
    create index if not exists idx_books_hardcover_ratings_count on books (hardcover_ratings_count);
    create index if not exists idx_books_bookmarks_score on books (bookmarks_score);
    create index if not exists idx_books_title on books (title);
  `);
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

  if (typeof query.minHardcoverRatings === "number" && query.minHardcoverRatings > 0) {
    conditions.push("hardcover_ratings_count >= ?");
    params.push(query.minHardcoverRatings);
  } else {
    conditions.push(
      "(hardcover_ratings_count is null or hardcover_ratings_count >= ?)",
    );
    params.push(MIN_HARDCOVER_RATINGS);
  }

  if (query.requireHardcover) {
    conditions.push(
      "hardcover_rating is not null and hardcover_ratings_count is not null",
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
        sum(case when hardcover_status = 'matched' then 1 else 0 end) as hardcoverMatched,
        max(updated_at) as latestUpdate
      from books
      where bookmarks_status = 'matched'
    `,
    )
    .get(year) as {
    totalBooks: number;
    currentYearBooks: number | null;
    bookmarksMatched: number | null;
    hardcoverMatched: number | null;
    latestUpdate: string | null;
  };

  return {
    totalBooks: row.totalBooks,
    currentYearBooks: row.currentYearBooks ?? 0,
    bookmarksMatched: row.bookmarksMatched ?? 0,
    hardcoverMatched: row.hardcoverMatched ?? 0,
    latestUpdate: row.latestUpdate,
  };
}

export function mapBookRow(row: Record<string, unknown>): BookRating {
  const hardcoverRating = nullableNumber(row.hardcover_rating);
  const bookmarksScore = nullableNumber(row.bookmarks_score);

  return {
    id: row.id as string,
    isbn13: row.isbn13 as string,
    title: row.title as string,
    authors: nullableString(row.authors),
    publishYear: nullableNumber(row.publish_year),
    genres: nullableString(row.genres),
    hardcoverRating,
    hardcoverRatingsCount: nullableNumber(row.hardcover_ratings_count),
    hardcoverUrl: nullableString(row.hardcover_url),
    hardcoverStatus: row.hardcover_status as BookRating["hardcoverStatus"],
    bookmarksGrade: nullableString(row.bookmarks_grade),
    bookmarksReviewCount: nullableNumber(row.bookmarks_review_count),
    raveCount: (row.rave_count as number) ?? 0,
    positiveCount: (row.positive_count as number) ?? 0,
    mixedCount: (row.mixed_count as number) ?? 0,
    panCount: (row.pan_count as number) ?? 0,
    bookmarksScore,
    combinedScore: combinedScore(hardcoverRating, bookmarksScore),
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
  hardcoverRating: number | null,
  bookmarksScore: number | null,
) {
  if (
    hardcoverRating === null ||
    bookmarksScore === null ||
    bookmarksScore <= 0
  ) {
    return null;
  }

  return Math.round(((hardcoverRating * 20 + bookmarksScore) / 2) * 100) / 100;
}
