import { execSync } from "node:child_process";
import path from "node:path";
import Database from "better-sqlite3";
import { openRawDatabase } from "../src/lib/ingest/database";
import {
  fetchGoodreadsWithRetry,
  storeRawGenres,
} from "../src/lib/ingest/goodreads";

const publishedDatabasePath =
  process.env.BOOK_RATINGS_DB ??
  path.join(process.cwd(), "data", "book-ratings.sqlite");
const rawDatabasePath =
  process.env.BOOK_RATINGS_RAW_DB ??
  path.join(process.cwd(), "data", "book-ratings.raw.sqlite");

const CONCURRENCY = Number(process.env.INGEST_CONCURRENCY ?? "4");
const INTER_BATCH_MS = Number(process.env.INGEST_INTER_BATCH_MS ?? "250");

type PublishedBook = {
  isbn13: string;
  goodreadsId: string;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  console.log(`Refreshing Goodreads genres for ${books.length} published books.`);

  const rawDatabase = openRawDatabase(rawDatabasePath);
  const updateGenres = rawDatabase.prepare(`
    update raw_books
    set genres = ?, updated_at = ?
    where goodreads_id = ?
  `);

  const updatedAt = new Date().toISOString();
  let processed = 0;
  let updated = 0;
  let failed = 0;

  for (let i = 0; i < books.length; i += CONCURRENCY) {
    const batch = books.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((book) => fetchGoodreadsWithRetry(book.isbn13)),
    );

    rawDatabase.transaction(() => {
      results.forEach((result, idx) => {
        const book = batch[idx];
        processed += 1;
        if (result.status !== "matched") {
          failed += 1;
          return;
        }

        const genres = storeRawGenres(result.genres);
        if (!genres) {
          failed += 1;
          return;
        }

        const change = updateGenres.run(genres, updatedAt, book.goodreadsId);
        if (change.changes > 0) {
          updated += change.changes;
        }
      });
    })();

    if (processed % 200 === 0 || processed === books.length) {
      console.log(
        `Processed ${processed}/${books.length} books (${updated} raw rows updated, ${failed} failed).`,
      );
    }

    if (INTER_BATCH_MS > 0) {
      await sleep(INTER_BATCH_MS);
    }
  }

  rawDatabase.close();
  console.log(
    `Done. ${processed} books processed, ${updated} raw rows updated, ${failed} failed.`,
  );

  console.log("Publishing catalog with updated genres...");
  execSync("npm run db:publish", { stdio: "inherit" });
  execSync("npm run db:validate", { stdio: "inherit" });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
