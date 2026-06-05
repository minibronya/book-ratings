import { NextResponse } from "next/server";
import { queryBooks, type BookSortKey } from "@/lib/db";

export const dynamic = "force-dynamic";

const sortKeys = new Set<BookSortKey>([
  "title",
  "publishYear",
  "readerRating",
  "readerRatingsCount",
  "combinedScore",
  "bookmarksScore",
  "bookmarksReviewCount",
]);

export function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const requestedSort = params.get("sort") ?? "combinedScore";
  const minYear = parseInteger(params.get("minYear"));
  const maxYear = parseInteger(params.get("maxYear"));
  const minReaderRatings = parseInteger(params.get("minReaderRatings"));
  const page = parseInteger(params.get("page")) ?? 1;
  const pageSize = parseInteger(params.get("pageSize")) ?? 50;
  const requireBookmarks = params.get("requireBookmarks") !== "false";
  const requireReader = params.get("requireReader") === "true";
  const genre = params.get("genre") ?? "";
  const genreExact = params.get("genreExact") === "true";
  const search = params.get("search") ?? "";
  const sortDir = params.get("sortDir") === "asc" ? "asc" : "desc";

  const result = queryBooks({
    minYear: minYear ?? undefined,
    maxYear: maxYear ?? undefined,
    minReaderRatings: minReaderRatings ?? undefined,
    page,
    pageSize,
    requireBookmarks,
    requireReader,
    genre,
    genreExact,
    search,
    sort: sortKeys.has(requestedSort as BookSortKey)
      ? (requestedSort as BookSortKey)
      : "combinedScore",
    sortDir,
  });

  return NextResponse.json(result, {
    headers: {
      "cache-control": "public, max-age=60, stale-while-revalidate=300",
    },
  });
}

function parseInteger(value: string | null) {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}
