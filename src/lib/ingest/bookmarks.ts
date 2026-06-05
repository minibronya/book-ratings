import * as cheerio from "cheerio";
import type { BookmarksStatus, BookmarksVerdict, ReviewCounts } from "../types";

const BOOKMARKS_WIDGET_BASE = "https://lithub.com/book-widget";
const BOOKMARKS_ISBN_LIST_URL =
  "https://s26162.pcdn.co/bookmarks-isbn-list.json";

export const BOOKMARKS_RATING_POINTS: Record<BookmarksVerdict, number> = {
  rave: 100,
  positive: 80,
  mixed: 60,
  pan: 30,
};

const VERDICTS: BookmarksVerdict[] = ["rave", "positive", "mixed", "pan"];

export type BookmarksParseResult = {
  grade: string | null;
  reviewCount: number | null;
  counts: ReviewCounts;
  bookmarksScore: number | null;
};

export type BookmarksFetchResult = BookmarksParseResult & {
  url: string;
  status: BookmarksStatus;
};

export function computeBookmarksScore(counts: ReviewCounts): number | null {
  const total = VERDICTS.reduce((sum, key) => sum + counts[key], 0);
  if (total === 0) {
    return null;
  }

  const weighted = VERDICTS.reduce(
    (sum, key) => sum + counts[key] * BOOKMARKS_RATING_POINTS[key],
    0,
  );

  return Math.round((weighted / total) * 100) / 100;
}

export function emptyReviewCounts(): ReviewCounts {
  return { rave: 0, positive: 0, mixed: 0, pan: 0 };
}

export function formatIsbnForWidget(isbn13: string) {
  const digits = isbn13.replace(/\D/g, "");
  if (digits.length !== 13) {
    throw new Error(`Expected ISBN-13, got ${isbn13}`);
  }

  return `${digits.slice(0, 3)}-${digits.slice(3)}`;
}

export function bookmarksWidgetUrl(isbn13: string) {
  const formatted = formatIsbnForWidget(isbn13);
  return `${BOOKMARKS_WIDGET_BASE}/${formatted}/0/0/`;
}

export async function fetchBookmarksIsbnList() {
  const response = await fetch(BOOKMARKS_ISBN_LIST_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    throw new Error(`Book Marks ISBN list failed: ${response.status}`);
  }

  const raw = (await response.json()) as string[];
  return dedupeIsbn13List(raw);
}

export function dedupeIsbn13List(raw: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of raw) {
    const digits = value.replace(/\D/g, "");
    if (digits.length !== 13 || seen.has(digits)) {
      continue;
    }

    seen.add(digits);
    result.push(digits);
  }

  return result;
}

export function parseBookmarksWidget(html: string): BookmarksParseResult {
  const $ = cheerio.load(html);
  const counts = emptyReviewCounts();

  $(".review").each((_, element) => {
    const verdict = $(element)
      .find(".stat_total")
      .first()
      .text()
      .trim()
      .toLowerCase();

    if (VERDICTS.includes(verdict as BookmarksVerdict)) {
      counts[verdict as BookmarksVerdict] += 1;
    }
  });

  const summaryText = $(".rating-summary").first().text().replace(/\s+/g, " ");
  const summaryMatch = summaryText.match(
    /Say\s+(\w+)\s+Based on\s+(\d+)\s+reviews?/i,
  );

  const grade = summaryMatch?.[1] ?? null;
  const reviewCount = summaryMatch
    ? Number(summaryMatch[2])
    : Object.values(counts).reduce((sum, value) => sum + value, 0) || null;

  return {
    grade,
    reviewCount: Number.isFinite(reviewCount) ? reviewCount : null,
    counts,
    bookmarksScore: computeBookmarksScore(counts),
  };
}

export async function fetchBookmarksByIsbn(
  isbn13: string,
): Promise<BookmarksFetchResult> {
  const url = bookmarksWidgetUrl(isbn13);

  try {
    const response = await fetch(url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (compatible; book-ratings/0.1; +https://example.com)",
        accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (response.status === 403 || response.status === 429) {
      return { ...emptyParse(), url, status: "blocked" };
    }

    if (response.status === 404) {
      return { ...emptyParse(), url, status: "not_found" };
    }

    if (!response.ok) {
      return { ...emptyParse(), url, status: "error" };
    }

    const html = await response.text();
    const parsed = parseBookmarksWidget(html);
    const totalReviews = Object.values(parsed.counts).reduce(
      (sum, value) => sum + value,
      0,
    );

    if (totalReviews === 0) {
      return { ...parsed, url, status: "not_reviewed" };
    }

    return { ...parsed, url, status: "matched" };
  } catch {
    return { ...emptyParse(), url, status: "error" };
  }
}

export async function enrichWithBookmarks(
  books: Array<{ isbn13: string } & Record<string, unknown>>,
  options: { delayMs?: number; maxLookups?: number } = {},
) {
  const delayMs = options.delayMs ?? 500;
  const maxLookups = options.maxLookups ?? Number.POSITIVE_INFINITY;
  let lookups = 0;
  let matches = 0;

  for (const book of books) {
    if (lookups >= maxLookups) {
      break;
    }

    const result = await fetchBookmarksByIsbn(book.isbn13);
    Object.assign(book, {
      bookmarksGrade: result.grade,
      bookmarksReviewCount: result.reviewCount,
      raveCount: result.counts.rave,
      positiveCount: result.counts.positive,
      mixedCount: result.counts.mixed,
      panCount: result.counts.pan,
      bookmarksScore: result.bookmarksScore,
      bookmarksUrl: result.url,
      bookmarksStatus: result.status,
    });

    lookups += 1;
    if (result.status === "matched") {
      matches += 1;
    }

    if (lookups % 25 === 0) {
      const matchRate = Math.round((matches / lookups) * 100);
      console.log(
        `Book Marks lookups: ${lookups}/${maxLookups} (${matches} matched, ${matchRate}%)`,
      );
    }

    await sleep(delayMs);
  }

  return books;
}

function emptyParse(): BookmarksParseResult {
  return {
    grade: null,
    reviewCount: null,
    counts: emptyReviewCounts(),
    bookmarksScore: null,
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
