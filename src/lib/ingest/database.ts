import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ensureSchema } from "../db";
import type { BookmarksStatus, BookRating, ReaderStatus } from "../types";

export type RawBookRow = {
  isbn13: string;
  title: string;
  authors: string | null;
  publishYear: number | null;
  genres: string | null;
  goodreadsId: string | null;
  readerRating: number | null;
  readerRatingsCount: number | null;
  readerUrl: string | null;
  readerStatus: ReaderStatus;
  bookmarksGrade: string | null;
  bookmarksReviewCount: number | null;
  raveCount: number;
  positiveCount: number;
  mixedCount: number;
  panCount: number;
  bookmarksScore: number | null;
  bookmarksUrl: string | null;
  bookmarksStatus: BookmarksStatus;
  updatedAt: string;
};

export function openWritableDatabase(databasePath: string) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  database.pragma("journal_mode = DELETE");
  ensureSchema(database);
  return database;
}

export function openRawDatabase(databasePath: string) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  database.pragma("journal_mode = DELETE");
  ensureRawSchema(database);
  return database;
}

export function ensureRawSchema(database: Database.Database) {
  database.exec(`
    create table if not exists raw_books (
      isbn13 text primary key,
      title text not null,
      authors text,
      publish_year integer,
      genres text,
      goodreads_id text,
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

    create index if not exists idx_raw_books_bookmarks_status on raw_books (bookmarks_status);
    create index if not exists idx_raw_books_reader_status on raw_books (reader_status);
    create index if not exists idx_raw_books_goodreads_id on raw_books (goodreads_id);
  `);
}

export function upsertRawRow(database: Database.Database, row: RawBookRow) {
  database
    .prepare(
      `
      insert into raw_books (
        isbn13,
        title,
        authors,
        publish_year,
        genres,
        goodreads_id,
        reader_rating,
        reader_ratings_count,
        reader_url,
        reader_status,
        bookmarks_grade,
        bookmarks_review_count,
        rave_count,
        positive_count,
        mixed_count,
        pan_count,
        bookmarks_score,
        bookmarks_url,
        bookmarks_status,
        updated_at
      ) values (
        @isbn13,
        @title,
        @authors,
        @publishYear,
        @genres,
        @goodreadsId,
        @readerRating,
        @readerRatingsCount,
        @readerUrl,
        @readerStatus,
        @bookmarksGrade,
        @bookmarksReviewCount,
        @raveCount,
        @positiveCount,
        @mixedCount,
        @panCount,
        @bookmarksScore,
        @bookmarksUrl,
        @bookmarksStatus,
        @updatedAt
      )
      on conflict(isbn13) do update set
        title = excluded.title,
        authors = excluded.authors,
        publish_year = excluded.publish_year,
        genres = excluded.genres,
        goodreads_id = excluded.goodreads_id,
        reader_rating = excluded.reader_rating,
        reader_ratings_count = excluded.reader_ratings_count,
        reader_url = excluded.reader_url,
        reader_status = excluded.reader_status,
        bookmarks_grade = excluded.bookmarks_grade,
        bookmarks_review_count = excluded.bookmarks_review_count,
        rave_count = excluded.rave_count,
        positive_count = excluded.positive_count,
        mixed_count = excluded.mixed_count,
        pan_count = excluded.pan_count,
        bookmarks_score = excluded.bookmarks_score,
        bookmarks_url = excluded.bookmarks_url,
        bookmarks_status = excluded.bookmarks_status,
        updated_at = excluded.updated_at
    `,
    )
    .run(row);
}

export function seedRawCatalog(
  database: Database.Database,
  isbnList: string[],
  updatedAt: string,
) {
  const insert = database.prepare(`
    insert into raw_books (isbn13, title, updated_at)
    values (?, ?, ?)
    on conflict(isbn13) do nothing
  `);

  const write = database.transaction((isbns: string[]) => {
    for (const isbn13 of isbns) {
      insert.run(isbn13, `ISBN ${isbn13}`, updatedAt);
    }
  });

  write(isbnList);
}

export function readRawRows(
  database: Database.Database,
  whereClause = "1 = 1",
  params: unknown[] = [],
) {
  const rows = database
    .prepare(
      `
      select *
      from raw_books
      where ${whereClause}
      order by isbn13 asc
    `,
    )
    .all(...params) as Array<Record<string, unknown>>;

  return rows.map(mapRawRow);
}

export function countRawRows(
  database: Database.Database,
  whereClause = "1 = 1",
  params: unknown[] = [],
) {
  const row = database
    .prepare(`select count(*) as count from raw_books where ${whereClause}`)
    .get(...params) as { count: number };

  return row.count;
}

export function replaceBooks(database: Database.Database, books: BookRating[]) {
  const insert = database.prepare(`
    insert into books (
      id,
      isbn13,
      goodreads_id,
      title,
      authors,
      publish_year,
      genres,
      reader_rating,
      reader_ratings_count,
      reader_url,
      reader_status,
      bookmarks_grade,
      bookmarks_review_count,
      rave_count,
      positive_count,
      mixed_count,
      pan_count,
      bookmarks_score,
      bookmarks_url,
      bookmarks_status,
      updated_at
    ) values (
      @id,
      @isbn13,
      @goodreadsId,
      @title,
      @authors,
      @publishYear,
      @genres,
      @readerRating,
      @readerRatingsCount,
      @readerUrl,
      @readerStatus,
      @bookmarksGrade,
      @bookmarksReviewCount,
      @raveCount,
      @positiveCount,
      @mixedCount,
      @panCount,
      @bookmarksScore,
      @bookmarksUrl,
      @bookmarksStatus,
      @updatedAt
    )
  `);

  const write = database.transaction((records: BookRating[]) => {
    database.prepare("delete from books").run();
    for (const book of records) {
      insert.run(book);
    }
  });

  write(books);
}

function mapRawRow(row: Record<string, unknown>): RawBookRow {
  return {
    isbn13: row.isbn13 as string,
    title: row.title as string,
    authors: nullableString(row.authors),
    publishYear: nullableNumber(row.publish_year),
    genres: nullableString(row.genres),
    goodreadsId: nullableString(row.goodreads_id),
    readerRating: nullableNumber(row.reader_rating),
    readerRatingsCount: nullableNumber(row.reader_ratings_count),
    readerUrl: nullableString(row.reader_url),
    readerStatus: row.reader_status as ReaderStatus,
    bookmarksGrade: nullableString(row.bookmarks_grade),
    bookmarksReviewCount: nullableNumber(row.bookmarks_review_count),
    raveCount: (row.rave_count as number) ?? 0,
    positiveCount: (row.positive_count as number) ?? 0,
    mixedCount: (row.mixed_count as number) ?? 0,
    panCount: (row.pan_count as number) ?? 0,
    bookmarksScore: nullableNumber(row.bookmarks_score),
    bookmarksUrl: nullableString(row.bookmarks_url),
    bookmarksStatus: row.bookmarks_status as BookmarksStatus,
    updatedAt: row.updated_at as string,
  };
}

function nullableString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function nullableNumber(value: unknown) {
  return typeof value === "number" ? value : null;
}
