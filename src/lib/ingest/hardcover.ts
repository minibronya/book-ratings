import type { HardcoverStatus } from "../types";

const HARDCOVER_GRAPHQL_URL = "https://api.hardcover.app/v1/graphql";

const BOOK_BY_ISBN_QUERY = `
  query BookByIsbn($isbn: String!) {
    books(
      where: {
        editions: {
          _or: [
            { isbn_13: { _eq: $isbn } }
            { isbn_10: { _eq: $isbn } }
          ]
        }
      }
      limit: 1
    ) {
      id
      title
      slug
      rating
      ratings_count
      release_year
      cached_contributors
    }
  }
`;

export type HardcoverResult = {
  title: string | null;
  authors: string | null;
  publishYear: number | null;
  hardcoverRating: number | null;
  hardcoverRatingsCount: number | null;
  hardcoverUrl: string | null;
  status: HardcoverStatus;
};

type HardcoverBook = {
  id: number;
  title: string;
  slug: string | null;
  rating: number | null;
  ratings_count: number | null;
  release_year: number | null;
  cached_contributors?: Array<{ author?: { name?: string } }> | null;
};

export function hardcoverApiToken() {
  return process.env.HARDCOVER_API_TOKEN?.trim() || null;
}

export async function fetchHardcoverByIsbn(isbn13: string): Promise<HardcoverResult> {
  const token = hardcoverApiToken();
  if (!token) {
    return emptyHardcoverResult("skipped");
  }

  try {
    const response = await fetch(HARDCOVER_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: token,
      },
      body: JSON.stringify({
        query: BOOK_BY_ISBN_QUERY,
        variables: { isbn: isbn13 },
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (response.status === 401 || response.status === 403) {
      return emptyHardcoverResult("error");
    }

    if (response.status === 429) {
      return emptyHardcoverResult("error");
    }

    if (!response.ok) {
      return emptyHardcoverResult("error");
    }

    const payload = (await response.json()) as {
      data?: { books?: HardcoverBook[] };
      errors?: Array<{ message: string }>;
    };

    if (payload.errors?.length) {
      return emptyHardcoverResult("error");
    }

    const book = payload.data?.books?.[0];
    if (!book) {
      return emptyHardcoverResult("not_found");
    }

    const authors = formatContributors(book.cached_contributors);
    const slug = book.slug ?? String(book.id);

    return {
      title: book.title ?? null,
      authors,
      publishYear: book.release_year ?? null,
      hardcoverRating: book.rating ?? null,
      hardcoverRatingsCount: book.ratings_count ?? null,
      hardcoverUrl: `https://hardcover.app/books/${slug}`,
      status: "matched",
    };
  } catch {
    return emptyHardcoverResult("error");
  }
}

export async function enrichWithHardcover<T extends { isbn13: string }>(
  books: T[],
  options: { delayMs?: number; maxLookups?: number } = {},
) {
  const token = hardcoverApiToken();
  if (!token) {
    console.log("HARDCOVER_API_TOKEN not set; skipping Hardcover enrichment.");
    return books.map((book) => ({
      ...book,
      hardcoverStatus: "skipped" as const,
    }));
  }

  const delayMs = options.delayMs ?? 300;
  const maxLookups = options.maxLookups ?? Number.POSITIVE_INFINITY;
  let lookups = 0;
  let matches = 0;

  for (const book of books) {
    if (lookups >= maxLookups) {
      break;
    }

    const result = await fetchHardcoverByIsbn(book.isbn13);
    Object.assign(book, {
      hardcoverRating: result.hardcoverRating,
      hardcoverRatingsCount: result.hardcoverRatingsCount,
      hardcoverUrl: result.hardcoverUrl,
      hardcoverStatus: result.status,
      ...(result.title && !(book as { title?: string }).title
        ? { title: result.title }
        : {}),
      ...(result.authors && !(book as { authors?: string }).authors
        ? { authors: result.authors }
        : {}),
      ...(result.publishYear &&
      !(book as { publishYear?: number | null }).publishYear
        ? { publishYear: result.publishYear }
        : {}),
    });

    lookups += 1;
    if (result.status === "matched") {
      matches += 1;
    }

    if (lookups % 50 === 0) {
      const matchRate = Math.round((matches / lookups) * 100);
      console.log(
        `Hardcover lookups: ${lookups}/${maxLookups} (${matches} matched, ${matchRate}%)`,
      );
    }

    await sleep(delayMs);
  }

  return books;
}

function formatContributors(
  contributors: HardcoverBook["cached_contributors"],
) {
  if (!contributors?.length) {
    return null;
  }

  const names = contributors
    .map((entry) => entry.author?.name?.trim())
    .filter((name): name is string => Boolean(name));

  return names.length > 0 ? names.join(", ") : null;
}

function emptyHardcoverResult(status: HardcoverStatus): HardcoverResult {
  return {
    title: null,
    authors: null,
    publishYear: null,
    hardcoverRating: null,
    hardcoverRatingsCount: null,
    hardcoverUrl: null,
    status,
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
