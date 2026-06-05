import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ensureSchema } from "../db";
import type { BookRating } from "../types";

export function openWritableDatabase(databasePath: string) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  database.pragma("journal_mode = DELETE");
  ensureSchema(database);
  return database;
}

export function replaceBooks(database: Database.Database, books: BookRating[]) {
  const insert = database.prepare(`
    insert into books (
      id,
      isbn13,
      title,
      authors,
      publish_year,
      genres,
      hardcover_rating,
      hardcover_ratings_count,
      hardcover_url,
      hardcover_status,
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
      @title,
      @authors,
      @publishYear,
      @genres,
      @hardcoverRating,
      @hardcoverRatingsCount,
      @hardcoverUrl,
      @hardcoverStatus,
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
