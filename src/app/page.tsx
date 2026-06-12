import { BookDashboard } from "@/components/BookDashboard";
import { readDataQuality } from "@/lib/db";

export default function Home() {
  const quality = readDataQuality();

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

      <BookDashboard latestUpdate={quality.latestUpdate} />
    </main>
  );
}
