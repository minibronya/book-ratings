# Book Rankings

Rank books by **Goodreads** reader ratings and **Book Marks** critic reviews. Critic scores use a weighted average of individual verdicts:

| Verdict   | Points |
|-----------|--------|
| Rave      | 100    |
| Positive  | 80     |
| Mixed     | 60     |
| Pan       | 30     |

Combined score (when both sources exist): `(goodreads_rating × 20 + bookmarks_score) / 2`.

## Quick start

```bash
npm install
npm run db:seed
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Data pipeline

The ingest uses two SQLite files:

- `data/book-ratings.raw.sqlite` (gitignored) — crash-safe working store, one row per catalog ISBN
- `data/book-ratings.sqlite` (committed) — published, deduped dataset served by the app

### Sample data

```bash
npm run db:seed
```

### Live ingest (incremental / resumable)

```bash
npm run db:ingest    # Book Marks + Goodreads lookups into raw DB
npm run db:publish   # dedupe, whitelist genres, write published DB
npm run db:update    # ingest + publish
npm run db:validate
```

Each ingest run only processes rows still marked `pending`. Re-run until counts stop moving, then publish.

For the full ~50k catalog, use the resumable loop (publishes after each chunk):

```bash
BOOKMARKS_MAX_LOOKUPS=3000 GOODREADS_MAX_LOOKUPS=1500 ./scripts/ingest-loop.sh
```

Progress is logged to `data/ingest.log`. When a chunk finishes, commit `data/book-ratings.sqlite` and push to update the live site.

Environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `BOOKMARKS_CATALOG_LIMIT` | all ISBNs | Optional ceiling on catalog size |
| `BOOKMARKS_MAX_LOOKUPS` | all pending | Max Book Marks widget fetches per run |
| `BOOKMARKS_DELAY_MS` | `500` | Delay between Book Marks requests |
| `GOODREADS_MAX_LOOKUPS` | all pending | Max Goodreads page fetches per run |
| `GOODREADS_DELAY_MS` | `1000` | Delay between Goodreads requests |
| `GOODREADS_MAX_BLOCKS` | `5` | Stop run after N consecutive 403/429 responses |
| `BOOK_RATINGS_DB` | `data/book-ratings.sqlite` | Published database path |
| `BOOK_RATINGS_RAW_DB` | `data/book-ratings.raw.sqlite` | Raw working database path |

### Data sources

- **Book Marks** — ISBN catalog + widget HTML (critic grade, rave/positive/mixed/pan counts, per-review verdicts)
- **Goodreads** — `/book/isbn/{isbn}` HTML (JSON-LD ratings + Apollo `bookGenres`, title, author, year). No API key required.

Goodreads genres are filtered through a whitelist blocklist (drops shelves like `Audiobook`, `Book Club`, `Adult`, etc.) and capped at five per book.

Reader data is enrichment, not a gate: books with failed/blocked Goodreads lookups still publish with critic-only data.

## Checks

```bash
npm test
npm run lint
npm run build
```

## Deployment

The app deploys on Vercel with the pre-generated `data/book-ratings.sqlite` committed to git. After growing the dataset:

```bash
npm run db:publish
npm run db:validate
git add data/book-ratings.sqlite
git commit -m "Refresh book ratings database"
git push
```

Live site: https://book-ratings-one.vercel.app
