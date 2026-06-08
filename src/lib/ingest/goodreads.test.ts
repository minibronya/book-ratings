import { describe, expect, it } from "vitest";
import {
  cleanGenres,
  cleanStoredGenres,
  extractEmbeddedIsbn13,
  parseGoodreadsPage,
  storeRawGenres,
} from "./goodreads";

function pageWithBody(body: string) {
  return `<html><body>${body}</body></html>`;
}

const crawdadsSnippet = `
<script type="application/ld+json">{"@type":"Book","name":"Where the Crawdads Sing","author":[{"@type":"Person","name":"Delia Owens"}],"aggregateRating":{"@type":"AggregateRating","ratingValue":4.37,"ratingCount":3723645}}</script>
"isbn13":"9780735219090"
"legacyId":37703550
"publicationTime":1534230000000
"bookGenres":[{"__typename":"BookGenre","genre":{"name":"Fiction"}},{"__typename":"BookGenre","genre":{"name":"Book Club"}},{"__typename":"BookGenre","genre":{"name":"Historical Fiction"}},{"__typename":"BookGenre","genre":{"name":"Audiobook"}}]
https://www.goodreads.com/book/show/37703550-where-the-crawdads-sing
`;

describe("storeRawGenres", () => {
  it("keeps all scraped shelves without blocklist filtering", () => {
    expect(
      storeRawGenres([
        "Fiction",
        "Book Club",
        "Historical Fiction",
        "Audiobook",
        "Adult",
      ]),
    ).toBe("Fiction,Book Club,Historical Fiction,Audiobook,Adult");
  });
});

describe("cleanGenres", () => {
  it("drops non-genre shelves and keeps up to five", () => {
    expect(
      cleanGenres([
        "Fiction",
        "Book Club",
        "Historical Fiction",
        "Audiobook",
        "Mystery",
        "Romance",
        "Adult",
      ]),
    ).toBe("Fiction,Book Club,Historical Fiction,Mystery,Romance");
  });

  it("filters stored raw genres at publish time", () => {
    expect(
      cleanStoredGenres("Fiction,Book Club,Historical Fiction,Audiobook,Adult"),
    ).toBe("Fiction,Book Club,Historical Fiction");
  });
});

describe("extractEmbeddedIsbn13", () => {
  it("reads the embedded isbn13 from Apollo state", () => {
    expect(extractEmbeddedIsbn13(crawdadsSnippet)).toBe("9780735219090");
  });
});

describe("parseGoodreadsPage", () => {
  it("parses rating, metadata, and genres when isbn matches", () => {
    const parsed = parseGoodreadsPage(pageWithBody(crawdadsSnippet), "9780735219090");
    expect(parsed.status).toBe("matched");
    expect(parsed.title).toBe("Where the Crawdads Sing");
    expect(parsed.authors).toBe("Delia Owens");
    expect(parsed.publishYear).toBe(2018);
    expect(parsed.readerRating).toBe(4.37);
    expect(parsed.readerRatingsCount).toBe(3723645);
    expect(parsed.goodreadsId).toBe("37703550");
    expect(cleanGenres(parsed.genres)).toBe("Fiction,Book Club,Historical Fiction");
  });

  it("returns not_found when embedded isbn does not match", () => {
    const parsed = parseGoodreadsPage(pageWithBody(crawdadsSnippet), "9780593135204");
    expect(parsed.status).toBe("not_found");
    expect(parsed.readerRating).toBeNull();
  });

  it("returns not_found when JSON-LD is missing", () => {
    expect(parseGoodreadsPage(pageWithBody("<div>no data</div>"), "9780735219090")).toEqual({
      title: null,
      authors: null,
      publishYear: null,
      genres: [],
      readerRating: null,
      readerRatingsCount: null,
      goodreadsId: null,
      readerUrl: null,
      status: "not_found",
    });
  });
});
