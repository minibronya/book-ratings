import type { ReaderStatus } from "../types";

const GOODREADS_ISBN_URL = "https://www.goodreads.com/book/isbn";

export const GENRE_BLOCKLIST = new Set(
  [
    "audiobook",
    "audio",
    "audible",
    "adult",
    "owned",
    "to read",
    "to-read",
    "currently reading",
    "favorites",
    "favourites",
    "kindle",
    "ebook",
    "e-book",
    "library",
    "series",
    "book",
  ].map((genre) => genre.toLowerCase()),
);

export type GoodreadsParseResult = {
  title: string | null;
  authors: string | null;
  publishYear: number | null;
  genres: string[];
  readerRating: number | null;
  readerRatingsCount: number | null;
  goodreadsId: string | null;
  readerUrl: string | null;
  status: ReaderStatus;
};

type JsonLdBook = {
  name?: string;
  author?: Array<{ name?: string }> | { name?: string };
  aggregateRating?: {
    ratingValue?: number | string;
    ratingCount?: number | string;
  };
};

export function splitGenres(genres: string | null) {
  if (!genres) {
    return [];
  }

  return genres
    .split(",")
    .map((genre) => genre.trim())
    .filter(Boolean);
}

/** Persist everything Goodreads returned; filter later at publish time. */
export function storeRawGenres(names: string[]): string | null {
  const kept: string[] = [];

  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed) {
      continue;
    }

    if (!kept.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) {
      kept.push(trimmed);
    }
  }

  return kept.length > 0 ? kept.join(",") : null;
}

export function cleanGenres(names: string[]): string | null {
  const kept: string[] = [];

  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed || GENRE_BLOCKLIST.has(trimmed.toLowerCase())) {
      continue;
    }

    if (!kept.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) {
      kept.push(trimmed);
    }

    if (kept.length >= 5) {
      break;
    }
  }

  return kept.length > 0 ? kept.join(",") : null;
}

export function cleanStoredGenres(genres: string | null) {
  return cleanGenres(splitGenres(genres));
}

export function parseGoodreadsPage(html: string, isbn13: string): GoodreadsParseResult {
  const embeddedIsbn = extractEmbeddedIsbn13(html);
  if (embeddedIsbn && embeddedIsbn !== isbn13) {
    return emptyGoodreadsResult("not_found");
  }

  const jsonLd = parseJsonLd(html);
  if (!jsonLd) {
    return emptyGoodreadsResult("not_found");
  }

  const goodreadsId = extractGoodreadsId(html);
  const rawGenres = extractBookGenres(html);
  const aggregateRating = jsonLd.aggregateRating;
  const ratingsCount = toNumber(aggregateRating?.ratingCount);
  const ratingValue = toNumber(aggregateRating?.ratingValue);

  return {
    title: jsonLd.name?.trim() || null,
    authors: formatAuthors(jsonLd.author),
    publishYear: extractPublishYear(html),
    genres: rawGenres,
    readerRating:
      ratingsCount && ratingsCount > 0 && ratingValue !== null
        ? Math.round(ratingValue * 100) / 100
        : null,
    readerRatingsCount: ratingsCount,
    goodreadsId,
    readerUrl: goodreadsId
      ? `https://www.goodreads.com/book/show/${goodreadsId}`
      : null,
    status: "matched",
  };
}

export async function fetchGoodreadsByIsbn(
  isbn13: string,
): Promise<GoodreadsParseResult> {
  const url = `${GOODREADS_ISBN_URL}/${isbn13}`;

  try {
    const response = await fetch(url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "accept-language": "en-US,en;q=0.9",
        accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });

    if (response.status === 403 || response.status === 429) {
      return emptyGoodreadsResult("blocked");
    }

    if (!response.ok) {
      return emptyGoodreadsResult("error");
    }

    const html = await response.text();
    return parseGoodreadsPage(html, isbn13);
  } catch {
    return emptyGoodreadsResult("error");
  }
}

export async function fetchGoodreadsWithRetry(
  isbn13: string,
  options: { retryDelayMs?: number } = {},
): Promise<GoodreadsParseResult> {
  const first = await fetchGoodreadsByIsbn(isbn13);
  if (first.status !== "error") {
    return first;
  }

  await sleep(options.retryDelayMs ?? 500);
  return fetchGoodreadsByIsbn(isbn13);
}

export async function enrichGoodreadsRows<
  T extends { isbn13: string; readerStatus: ReaderStatus },
>(
  rows: T[],
  options: {
    delayMs?: number;
    maxLookups?: number;
    maxConsecutiveBlocks?: number;
    onProcessed: (row: T, result: GoodreadsParseResult) => void;
  },
) {
  const delayMs = options.delayMs ?? 1000;
  const maxLookups = options.maxLookups ?? Number.POSITIVE_INFINITY;
  const maxConsecutiveBlocks = options.maxConsecutiveBlocks ?? 5;
  let lookups = 0;
  let matches = 0;
  let consecutiveBlocks = 0;

  for (const row of rows) {
    if (lookups >= maxLookups) {
      break;
    }

    const result = await fetchGoodreadsByIsbn(row.isbn13);
    options.onProcessed(row, result);

    lookups += 1;
    if (result.status === "matched") {
      matches += 1;
      consecutiveBlocks = 0;
    } else if (result.status === "blocked") {
      consecutiveBlocks += 1;
      if (consecutiveBlocks >= maxConsecutiveBlocks) {
        console.log(
          `Stopping Goodreads ingest after ${maxConsecutiveBlocks} consecutive blocks.`,
        );
        break;
      }
    } else {
      consecutiveBlocks = 0;
    }

    if (lookups % 25 === 0) {
      const matchRate = Math.round((matches / lookups) * 100);
      console.log(
        `Goodreads lookups: ${lookups}/${maxLookups} (${matches} matched, ${matchRate}%)`,
      );
    }

    await sleep(delayMs);
  }

  return { lookups, matches, stoppedForBlocks: consecutiveBlocks >= maxConsecutiveBlocks };
}

function parseJsonLd(html: string): JsonLdBook | null {
  const match = html.match(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
  );
  if (!match) {
    return null;
  }

  try {
    return JSON.parse(match[1]) as JsonLdBook;
  } catch {
    return null;
  }
}

export function extractEmbeddedIsbn13(html: string) {
  const match = html.match(/"isbn13":"(\d{13})"/);
  return match?.[1] ?? null;
}

function extractGoodreadsId(html: string) {
  const showMatch = html.match(/goodreads\.com\/book\/show\/(\d+)/);
  if (showMatch) {
    return showMatch[1];
  }

  const legacyMatch = html.match(/"legacyId":(\d+)/);
  return legacyMatch?.[1] ?? null;
}

function extractBookGenres(html: string) {
  const match = html.match(/"bookGenres":\[([\s\S]*?)\]/);
  if (!match) {
    return [];
  }

  return [...match[1].matchAll(/"name":"([^"]+)"/g)].map((entry) => entry[1]);
}

function extractPublishYear(html: string) {
  const pubTime = html.match(/"publicationTime":(\d+)/);
  if (pubTime) {
    const year = new Date(Number(pubTime[1])).getFullYear();
    if (year >= 1000 && year <= 2100) {
      return year;
    }
  }

  const firstPublished = html.match(
    /First published(?:\s+\w+\s+\d{1,2},)?\s+(\d{4})/,
  );
  if (firstPublished) {
    return Number(firstPublished[1]);
  }

  return null;
}

function formatAuthors(
  author: JsonLdBook["author"],
): string | null {
  if (!author) {
    return null;
  }

  const authors = Array.isArray(author) ? author : [author];
  const names = authors
    .map((entry) => entry.name?.trim())
    .filter((name): name is string => Boolean(name));

  return names.length > 0 ? names.join(", ") : null;
}

function toNumber(value: number | string | undefined) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function emptyGoodreadsResult(status: ReaderStatus): GoodreadsParseResult {
  return {
    title: null,
    authors: null,
    publishYear: null,
    genres: [],
    readerRating: null,
    readerRatingsCount: null,
    goodreadsId: null,
    readerUrl: null,
    status,
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
