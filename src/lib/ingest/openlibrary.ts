export type OpenLibraryResult = {
  title: string | null;
  authors: string | null;
  publishYear: number | null;
};

type OpenLibraryEdition = {
  title?: string;
  authors?: Array<{ key?: string; name?: string }>;
  publish_date?: string;
};

export async function fetchOpenLibraryByIsbn(
  isbn13: string,
): Promise<OpenLibraryResult> {
  const url = `https://openlibrary.org/isbn/${isbn13}.json`;

  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return emptyOpenLibraryResult();
    }

    const edition = (await response.json()) as OpenLibraryEdition;
    const title = edition.title?.trim() || null;
    const authors =
      edition.authors
        ?.map((author) => author.name?.trim())
        .filter((name): name is string => Boolean(name))
        .join(", ") || null;
    const publishYear = parsePublishYear(edition.publish_date);

    return { title, authors, publishYear };
  } catch {
    return emptyOpenLibraryResult();
  }
}

export async function enrichWithOpenLibrary<T extends { isbn13: string }>(
  books: T[],
  options: { delayMs?: number; maxLookups?: number } = {},
) {
  const delayMs = options.delayMs ?? 200;
  const maxLookups = options.maxLookups ?? Number.POSITIVE_INFINITY;
  let lookups = 0;

  for (const book of books) {
    if (lookups >= maxLookups) {
      break;
    }

    const needsTitle = !(book as { title?: string }).title;
    const needsAuthors = !(book as { authors?: string | null }).authors;
    const needsYear = !(book as { publishYear?: number | null }).publishYear;

    if (!needsTitle && !needsAuthors && !needsYear) {
      continue;
    }

    const result = await fetchOpenLibraryByIsbn(book.isbn13);
    Object.assign(book, {
      ...(needsTitle && result.title ? { title: result.title } : {}),
      ...(needsAuthors && result.authors ? { authors: result.authors } : {}),
      ...(needsYear && result.publishYear
        ? { publishYear: result.publishYear }
        : {}),
    });

    lookups += 1;
    if (lookups % 100 === 0) {
      console.log(`Open Library lookups: ${lookups}/${maxLookups}`);
    }

    await sleep(delayMs);
  }

  return books;
}

function parsePublishYear(publishDate: string | undefined) {
  if (!publishDate) {
    return null;
  }

  const match = publishDate.match(/\b(19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

function emptyOpenLibraryResult(): OpenLibraryResult {
  return { title: null, authors: null, publishYear: null };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
