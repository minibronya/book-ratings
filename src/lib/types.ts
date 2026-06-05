export type BookmarksVerdict = "rave" | "positive" | "mixed" | "pan";

export type ReviewCounts = Record<BookmarksVerdict, number>;

export type BookmarksStatus =
  | "matched"
  | "not_found"
  | "not_reviewed"
  | "blocked"
  | "error"
  | "pending"
  | "skipped";

export type HardcoverStatus =
  | "matched"
  | "not_found"
  | "error"
  | "pending"
  | "skipped";

export type BookRating = {
  id: string;
  isbn13: string;
  title: string;
  authors: string | null;
  publishYear: number | null;
  genres: string | null;
  hardcoverRating: number | null;
  hardcoverRatingsCount: number | null;
  hardcoverUrl: string | null;
  hardcoverStatus: HardcoverStatus;
  bookmarksGrade: string | null;
  bookmarksReviewCount: number | null;
  raveCount: number;
  positiveCount: number;
  mixedCount: number;
  panCount: number;
  bookmarksScore: number | null;
  combinedScore: number | null;
  bookmarksUrl: string | null;
  bookmarksStatus: BookmarksStatus;
  updatedAt: string;
};

export type DataQualityReport = {
  totalBooks: number;
  currentYearBooks: number;
  bookmarksMatched: number;
  hardcoverMatched: number;
  latestUpdate: string | null;
};
