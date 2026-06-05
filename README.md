# Book Rankings

Rank books by **Hardcover** reader ratings and **Book Marks** critic reviews. Critic scores use a weighted average of individual verdicts:

| Verdict   | Points |
|-----------|--------|
| Rave      | 100    |
| Positive  | 80     |
| Mixed     | 60     |
| Pan       | 30     |

Combined score (when both sources exist): `(hardcover_rating × 20 + bookmarks_score) / 2`.

## Quick start

```bash
npm install
npm run db:seed    # sample SQLite database (5 books)
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Building the database

### Sample data

```bash
npm run db:seed
```

### Live ingest

1. Optional: set `HARDCOVER_API_TOKEN` from [Hardcover account settings](https://hardcover.app/account/api).
2. Run a bounded ingest (defaults to 500 ISBNs from the Book Marks catalog):

```bash
BOOKMARKS_CATALOG_LIMIT=500 BOOKMARKS_MAX_LOOKUPS=500 npm run db:update
```

Environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `BOOKMARKS_CATALOG_LIMIT` | `500` | How many ISBNs from the Book Marks list to process |
| `BOOKMARKS_MAX_LOOKUPS` | all pending | Max Book Marks widget fetches per run |
| `BOOKMARKS_DELAY_MS` | `500` | Delay between Book Marks requests |
| `OPENLIBRARY_MAX_LOOKUPS` | all kept books | Open Library title/author/year lookups |
| `OPENLIBRARY_DELAY_MS` | `200` | Delay between Open Library requests |
| `HARDCOVER_MAX_LOOKUPS` | all kept books | Hardcover GraphQL lookups |
| `HARDCOVER_DELAY_MS` | `300` | Delay between Hardcover requests |
| `HARDCOVER_API_TOKEN` | — | Required for live Hardcover ratings |
| `BOOK_RATINGS_DB` | `data/book-ratings.sqlite` | Database path |

Validate:

```bash
npm run db:validate
```

## Data sources

- **Book Marks** — `bookmarks-isbn-list.json` catalog + per-ISBN widget HTML (grade, per-critic verdicts, rave/positive/mixed/pan counts).
- **Hardcover** — GraphQL API for community ratings (requires API token).
- **Open Library** — ISBN metadata for title, authors, and publish year.

## Tests

```bash
npm test
npm run lint
npm run build
```

Covers the Book Marks parser and weighted critic score (`100/80/60/30`).

## Deployment

The app deploys on Vercel as a Next.js build with a pre-generated SQLite database committed at `data/book-ratings.sqlite`. Regenerate locally when you want fresh data:

```bash
npm run db:update
npm run db:validate
git add data/book-ratings.sqlite
git commit -m "Refresh book ratings database"
git push
```

Vercel picks up pushes to `main` automatically once the project is linked.
