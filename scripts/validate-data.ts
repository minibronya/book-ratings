import path from "node:path";
import Database from "better-sqlite3";
import { MIN_BOOKMARKS_REVIEWS, MIN_PUBLISH_YEAR } from "../src/lib/db";

const databasePath =
  process.env.BOOK_RATINGS_DB ??
  path.join(process.cwd(), "data", "book-ratings.sqlite");

const database = new Database(databasePath, { readonly: true });

const row = database
  .prepare(
    `
    select
      count(*) as total,
      sum(case when bookmarks_score is null then 1 else 0 end) as missingScore,
      sum(case when bookmarks_review_count < ? then 1 else 0 end) as lowReviewCount,
      sum(case when publish_year is not null and publish_year < ? then 1 else 0 end) as oldBooks,
      sum(case when reader_rating is not null then 1 else 0 end) as readerMatched
    from books
    where bookmarks_status = 'matched'
  `,
  )
  .get(MIN_BOOKMARKS_REVIEWS, MIN_PUBLISH_YEAR) as {
  total: number;
  missingScore: number;
  lowReviewCount: number;
  oldBooks: number;
  readerMatched: number;
};

database.close();

console.log("Validation summary:");
console.log(`  matched books: ${row.total}`);
const readerMatched = row.readerMatched ?? 0;
console.log(`  goodreads matched: ${readerMatched} (${row.total === 0 ? 0 : Math.round((readerMatched / row.total) * 100)}%)`);
console.log(`  missing bookmarks_score: ${row.missingScore}`);
console.log(`  review count below minimum: ${row.lowReviewCount}`);
console.log(`  publish year before ${MIN_PUBLISH_YEAR}: ${row.oldBooks}`);

if (row.missingScore > 0 || row.lowReviewCount > 0) {
  process.exit(1);
}
