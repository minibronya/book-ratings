"use client";

import { useEffect, useMemo, useState } from "react";
import type { BookRating } from "@/lib/types";
import { VerdictBreakdown } from "@/components/VerdictBreakdown";
import { YearRangeSlider } from "@/components/YearRangeSlider";

type SortKey =
  | "title"
  | "publishYear"
  | "combinedScore"
  | "readerRating"
  | "readerRatingsCount"
  | "bookmarksScore"
  | "bookmarksReviewCount";

type Props = {
  title: string;
  description: string;
  latestUpdate: string | null;
};

type YearBounds = {
  min: number;
  max: number;
};

type BookResponse = {
  books: BookRating[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  genreOptions: string[];
  yearBounds: YearBounds;
};

const MIN_PUBLISH_YEAR = 1990;

const readerRatingCountThresholds = [
  1000, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000,
];

const criticReviewThresholds = [3, 5, 10, 15, 20, 25];

const combinedScoreThresholds = [70, 75, 80, 85, 90];

const columns: { key: SortKey; label: string }[] = [
  { key: "title", label: "Book" },
  { key: "publishYear", label: "Year" },
  { key: "combinedScore", label: "Combined" },
  { key: "readerRating", label: "Goodreads" },
  { key: "readerRatingsCount", label: "GR Ratings" },
  { key: "bookmarksScore", label: "Critics" },
  { key: "bookmarksReviewCount", label: "Critic Reviews" },
];

function formatScore(value: number | null) {
  return value === null ? "—" : value.toFixed(1);
}

function formatRating(value: number | null) {
  return value === null ? "—" : value.toFixed(2);
}

const BOOK_CLUB_GENRE = "Book Club";

export function BookTable({ title, description, latestUpdate }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("combinedScore");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [query, setQuery] = useState("");
  const [genre, setGenre] = useState("");
  const [exactGenre, setExactGenre] = useState(false);
  const [minRatings, setMinRatings] = useState("");
  const [minCriticReviews, setMinCriticReviews] = useState("");
  const [minCombinedScore, setMinCombinedScore] = useState("");
  const [yearRange, setYearRange] = useState<[number, number] | null>(null);
  const [page, setPage] = useState(1);
  const [randomPickActive, setRandomPickActive] = useState(false);
  const [randomNonce, setRandomNonce] = useState(0);
  const [response, setResponse] = useState<BookResponse>({
    books: [],
    total: 0,
    page: 1,
    pageSize: 50,
    pageCount: 1,
    genreOptions: [],
    yearBounds: { min: MIN_PUBLISH_YEAR, max: new Date().getFullYear() },
  });
  const [loadedEndpoint, setLoadedEndpoint] = useState("");

  const filterKey = useMemo(
    () =>
      JSON.stringify({
        exactGenre,
        genre,
        minCombinedScore,
        minCriticReviews,
        minRatings,
        query,
        yearRange,
      }),
    [exactGenre, genre, minCombinedScore, minCriticReviews, minRatings, query, yearRange],
  );

  useEffect(() => {
    setRandomPickActive(false);
  }, [filterKey]);

  const resetFilters = () => {
    setSortKey("combinedScore");
    setSortDir("desc");
    setQuery("");
    setGenre("");
    setExactGenre(false);
    setMinRatings("");
    setMinCriticReviews("");
    setMinCombinedScore("");
    setYearRange(null);
    setPage(1);
    setRandomPickActive(false);
  };

  const bounds = response.yearBounds;
  const sliderValue: [number, number] = yearRange ?? [bounds.min, bounds.max];
  const updatedLabel = latestUpdate
    ? new Date(latestUpdate).toLocaleDateString()
    : "Pending";

  const endpoint = useMemo(() => {
    const params = new URLSearchParams({
      requireBookmarks: "true",
    });

    if (yearRange) {
      params.set("minYear", String(yearRange[0]));
      params.set("maxYear", String(yearRange[1]));
    }

    if (genre) {
      params.set("genre", genre);
      if (exactGenre) {
        params.set("genreExact", "true");
      }
    }

    if (minRatings) {
      params.set("minReaderRatings", minRatings);
    }

    if (minCriticReviews) {
      params.set("minBookmarksReviews", minCriticReviews);
    }

    if (minCombinedScore) {
      params.set("minCombinedScore", minCombinedScore);
    }

    if (query.trim()) {
      params.set("search", query.trim());
    }

    if (randomPickActive) {
      params.set("randomPick", "true");
      params.set("randomNonce", String(randomNonce));
    } else {
      params.set("sort", sortKey);
      params.set("sortDir", sortDir);
      params.set("page", String(page));
      params.set("pageSize", "50");
    }

    return `/api/books?${params.toString()}`;
  }, [
    exactGenre,
    genre,
    minCombinedScore,
    minCriticReviews,
    minRatings,
    page,
    query,
    randomNonce,
    randomPickActive,
    sortDir,
    sortKey,
    yearRange,
  ]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const result = await fetch(endpoint).then((res) => res.json());
      if (!cancelled) {
        setResponse(result);
        setLoadedEndpoint(endpoint);
      }
    }

    load().catch(() => {
      if (!cancelled) {
        setResponse((current) => ({ ...current, books: [] }));
      }
    });

    return () => {
      cancelled = true;
    };
  }, [endpoint]);

  function toggleSort(key: SortKey) {
    if (randomPickActive) {
      return;
    }

    setPage(1);
    if (sortKey === key) {
      setSortDir((current) => (current === "desc" ? "asc" : "desc"));
      return;
    }

    setSortKey(key);
    setSortDir("desc");
  }

  function toggleRandomPick() {
    if (randomPickActive) {
      setRandomPickActive(false);
      return;
    }

    setRandomNonce((current) => current + 1);
    setRandomPickActive(true);
    setPage(1);
  }

  const genreOptions = randomPickActive
    ? (response.books[0]?.genres ?? "")
        .split(",")
        .map((genre) => genre.trim())
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b))
    : response.genreOptions;

  return (
    <section className="panel">
      <div className="panelHeader">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <span className="panelMeta">
          <span>
            {randomPickActive
              ? `Random pick from ${response.total.toLocaleString()} books`
              : `${response.total.toLocaleString()} books`}
            {loadedEndpoint === endpoint ? "" : " · loading"}
          </span>
          <span>Updated {updatedLabel}</span>
        </span>
      </div>

      <div className="controls">
        <label>
          Search
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
            placeholder="Title or author..."
          />
        </label>

        <label>
          Genre
          <select
            value={genre}
            onChange={(event) => {
              setGenre(event.target.value);
              setPage(1);
              if (!event.target.value) {
                setExactGenre(false);
              }
            }}
          >
            <option value="">
              {randomPickActive ? "Genres of pick" : "All genres"}
            </option>
            {genreOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        {genre ? (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={exactGenre}
              onChange={(event) => {
                setExactGenre(event.target.checked);
                setPage(1);
              }}
            />
            Only this genre
          </label>
        ) : null}

        <label>
          Min combined score
          <select
            value={minCombinedScore}
            onChange={(event) => {
              setMinCombinedScore(event.target.value);
              setPage(1);
            }}
          >
            <option value="">Any score</option>
            {combinedScoreThresholds.map((threshold) => (
              <option key={threshold} value={String(threshold)}>
                {threshold}+
              </option>
            ))}
          </select>
        </label>

        <label>
          Min Goodreads ratings
          <select
            value={minRatings}
            onChange={(event) => {
              setMinRatings(event.target.value);
              setPage(1);
            }}
          >
            <option value="">Any count</option>
            {readerRatingCountThresholds.map((threshold) => (
              <option key={threshold} value={String(threshold)}>
                {threshold.toLocaleString()}+
              </option>
            ))}
          </select>
        </label>

        <label>
          Min critic reviews
          <select
            value={minCriticReviews}
            onChange={(event) => {
              setMinCriticReviews(event.target.value);
              setPage(1);
            }}
          >
            <option value="">Any count</option>
            {criticReviewThresholds.map((threshold) => (
              <option key={threshold} value={String(threshold)}>
                {threshold}+
              </option>
            ))}
          </select>
        </label>

        <label className="checkbox">
          <input
            type="checkbox"
            checked={genre === BOOK_CLUB_GENRE}
            onChange={(event) => {
              setGenre(event.target.checked ? BOOK_CLUB_GENRE : "");
              setExactGenre(false);
              setPage(1);
            }}
          />
          Book Club
        </label>

        <div className="sliderControl">
          <YearRangeSlider
            min={bounds.min}
            max={bounds.max}
            value={sliderValue}
            onChange={(value) => {
              setYearRange(value);
              setPage(1);
            }}
          />
        </div>

        <button
          type="button"
          className={`randomPickButton${randomPickActive ? " active" : ""}`}
          aria-pressed={randomPickActive}
          onClick={toggleRandomPick}
        >
          Pick at Random
        </button>

        <button type="button" className="resetButton" onClick={resetFilters}>
          Reset filters
        </button>
      </div>

      <div className="tableScroller">
        <table>
          <thead>
            <tr>
              <th>Verdicts</th>
              {columns.map((column) => (
                <th key={column.key}>
                  <button
                    type="button"
                    onClick={() => toggleSort(column.key)}
                    disabled={randomPickActive}
                  >
                    {column.label}
                    {sortKey === column.key ? (sortDir === "desc" ? " ↓" : " ↑") : ""}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {response.books.map((book) => (
              <tr key={book.id}>
                <td>
                  <VerdictBreakdown
                    raveCount={book.raveCount}
                    positiveCount={book.positiveCount}
                    mixedCount={book.mixedCount}
                    panCount={book.panCount}
                  />
                  {book.bookmarksGrade ? (
                    <span>{book.bookmarksGrade}</span>
                  ) : null}
                </td>
                <td>
                  <strong>{book.title}</strong>
                  {book.authors ? <span>{book.authors}</span> : null}
                </td>
                <td>{book.publishYear ?? "—"}</td>
                <td>{formatScore(book.combinedScore)}</td>
                <td>{formatRating(book.readerRating)}</td>
                <td>{book.readerRatingsCount?.toLocaleString() ?? "—"}</td>
                <td>{formatScore(book.bookmarksScore)}</td>
                <td>{book.bookmarksReviewCount ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {randomPickActive ? (
        <div className="pagination">
          <span>Showing 1 random book</span>
        </div>
      ) : (
        <div className="pagination">
          <span>
            Page {response.page} of {response.pageCount}
          </span>
          <div>
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((current) => Math.max(current - 1, 1))}
            >
              Previous
            </button>
            <button
              type="button"
              disabled={page >= response.pageCount}
              onClick={() =>
                setPage((current) => Math.min(current + 1, response.pageCount))
              }
            >
              Next
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
