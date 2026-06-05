import { BookDashboard } from "@/components/BookDashboard";
import { readDataQuality } from "@/lib/db";

export default function Home() {
  const currentYear = new Date().getFullYear();
  const quality = readDataQuality(currentYear);
  const bookmarksRate =
    quality.totalBooks === 0
      ? 0
      : Math.round((quality.bookmarksMatched / quality.totalBooks) * 100);
  const readerRate =
    quality.totalBooks === 0
      ? 0
      : Math.round((quality.readerMatched / quality.totalBooks) * 100);

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Book rankings</p>
        <h1>Find the best-reviewed books.</h1>
        <p>
          Rank books by Goodreads reader ratings and Book Marks critic scores,
          with rave / positive / mixed / pan breakdowns.
        </p>
      </section>

      <section className="stats" aria-label="Data quality">
        <article>
          <span>Total books</span>
          <strong>{quality.totalBooks.toLocaleString()}</strong>
        </article>
        <article>
          <span>{currentYear} releases</span>
          <strong>{quality.currentYearBooks.toLocaleString()}</strong>
        </article>
        <article>
          <span>Book Marks matched</span>
          <strong>{bookmarksRate}%</strong>
        </article>
        <article>
          <span>Goodreads matched</span>
          <strong>{readerRate}%</strong>
        </article>
        <article>
          <span>Updated</span>
          <strong>
            {quality.latestUpdate
              ? new Date(quality.latestUpdate).toLocaleDateString()
              : "Pending"}
          </strong>
        </article>
      </section>

      <BookDashboard currentYear={currentYear} />
    </main>
  );
}
