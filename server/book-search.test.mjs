import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isIsbnQuery,
  lookupBooks,
  lookupSeries,
  mergeBookResults,
  normalizeGoogleVolumes,
  normalizeHardcoverBooks,
  normalizeIsbn,
  normalizeOpenLibraryDocs,
  normalizeOpenLibrarySeries,
  seriesDisplayName,
} from "./book-search.mjs";

afterEach(() => vi.unstubAllGlobals());

describe("book search normalization", () => {
  it("uses readable capitalization for search fallback series names", () => {
    expect(seriesDisplayName("the wheel of time")).toBe("The Wheel of Time");
    expect(seriesDisplayName("The Wheel of Time")).toBe("The Wheel of Time");
  });

  it("prefers the provider series label over search wording", () => {
    const [book] = normalizeOpenLibrarySeries({ docs: [
      { title: "The Hobbit", series: ["The Hobbit books 1"] },
      { title: "The Hobbit: An Unexpected Journey", series: ["The Hobbit books 2"] },
    ] }, "hobbit books");
    expect(book.series).toBe("The Hobbit");
  });

  it("normalizes and validates ISBN-10 and ISBN-13 checksums", () => {
    expect(normalizeIsbn("978-0-261-10357-3")).toBe("9780261103573");
    expect(normalizeIsbn("0-261-10357-1")).toBe("0261103571");
    expect(isIsbnQuery("9780261103573")).toBe(true);
    expect(normalizeIsbn("9780261103574")).toBe("");
    expect(normalizeIsbn("4006381333931")).toBe("");
  });

  it("normalizes Google metadata and upgrades cover URLs to HTTPS", () => {
    const [result] = normalizeGoogleVolumes({
      items: [{
        id: "google-volume",
        volumeInfo: {
          title: "The Fellowship of the Ring",
          authors: ["J.R.R. Tolkien"],
          publishedDate: "1954-07-29",
          pageCount: 423,
          industryIdentifiers: [{ type: "ISBN_13", identifier: "9780261103573" }],
          imageLinks: { large: "http://books.google.com/books/content?id=google-volume" },
        },
      }],
    });
    expect(result).toMatchObject({
      source: "google_books",
      isbn: "9780261103573",
      publishedYear: 1954,
      pageCount: 423,
    });
    expect(result.coverOptions[0].url).toMatch(/^https:\/\/books\.google\.com/);
  });

  it("keeps series metadata and volume numbers from book providers", () => {
    const [google] = normalizeGoogleVolumes({ items: [{ id: "series-book", volumeInfo: {
      title: "Series Book", authors: ["Reader Author"],
      seriesInfo: { seriesName: "reader series", bookDisplayNumber: "2" },
    } }] });
    expect(google).toMatchObject({ series: "Reader Series", seriesNumber: "2" });

    const [openLibrary] = normalizeOpenLibraryDocs({ docs: [{
      title: "Series Book", author_name: ["Reader Author"], series: ["reader series #3"],
    }] });
    expect(openLibrary).toMatchObject({ series: "Reader Series", seriesNumber: "3" });
  });

  it("collects distinct Open Library edition covers", () => {
    const [result] = normalizeOpenLibraryDocs({
      docs: [{
        key: "/works/OL27513W",
        title: "The Fellowship of the Ring",
        author_name: ["J.R.R. Tolkien"],
        isbn: ["9780261103573"],
        cover_i: 14627060,
        editions: { docs: [{ cover_i: 8311423 }] },
      }],
    });
    expect(result.source).toBe("open_library");
    expect(result.coverOptions).toHaveLength(2);
    expect(result.coverOptions[1].url).toContain("/8311423-L.jpg");
  });

  it("keeps Google metadata primary while adding Open Library covers", () => {
    const google = normalizeGoogleVolumes({
      items: [{
        id: "google-volume",
        volumeInfo: {
          title: "The Fellowship of the Ring",
          authors: ["J.R.R. Tolkien"],
          industryIdentifiers: [{ type: "ISBN_13", identifier: "9780261103573" }],
          imageLinks: { large: "https://books.google.com/books/content?id=google-volume" },
        },
      }],
    });
    const openLibrary = normalizeOpenLibraryDocs({
      docs: [{
        key: "/works/OL27513W",
        title: "The Fellowship of the Ring",
        author_name: ["J.R.R. Tolkien"],
        isbn: ["9780261103573"],
        cover_i: 14627060,
      }],
    });
    const [result] = mergeBookResults(google, openLibrary);
    expect(result.source).toBe("google_books");
    expect(result.coverOptions).toHaveLength(2);
    expect(result.coverUrl).toBe(result.coverOptions[0].url);
  });

  it("adds matching Hardcover covers without replacing primary metadata", () => {
    const google = normalizeGoogleVolumes({
      items: [{
        id: "google-volume",
        volumeInfo: {
          title: "The Fellowship of the Ring",
          authors: ["J.R.R. Tolkien"],
          industryIdentifiers: [{ type: "ISBN_13", identifier: "9780261103573" }],
          imageLinks: { large: "https://books.google.com/books/content?id=google-volume" },
        },
      }],
    });
    const hardcover = normalizeHardcoverBooks({
      data: {
        books: [{
          id: 42,
          title: "The Fellowship of the Ring",
          cached_contributors: [{ author: { name: "J.R.R. Tolkien" } }],
          cached_image: "https://assets.hardcover.app/edition/42/cover.jpeg",
        }],
        editions: [{ book_id: 42, isbn_13: "9780261103573" }],
      },
    });
    const [result] = mergeBookResults(google, [], hardcover);
    expect(result.source).toBe("google_books");
    expect(result.coverOptions).toHaveLength(2);
    expect(result.coverOptions[1]).toMatchObject({ source: "Hardcover" });
  });

  it("falls back to Open Library when Google Books is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async url => {
      if (String(url).includes("googleapis.com")) {
        return {
          ok: false,
          status: 429,
          headers: { get: () => null },
          text: async () => "",
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({
          docs: [{
            key: "/works/OL27513W",
            title: "The Fellowship of the Ring",
            author_name: ["J.R.R. Tolkien"],
            isbn: ["9780261103573"],
            cover_i: 14627060,
          }],
        }),
      };
    }));

    const response = await lookupBooks("9780261103573", "isbn");
    expect(response.providers).toEqual({
      googleBooks: "unavailable",
      openLibrary: "available",
      hardcover: "disabled",
    });
    expect(response.results[0]).toMatchObject({
      source: "open_library",
      title: "The Fellowship of the Ring",
    });
  });

  it("finds a whole series through the Open Library fallback", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        docs: [
          {
            key: "/works/OL1W",
            title: "Series Book One",
            author_name: ["Reader Author"],
            isbn: ["9780261103573"],
            first_publish_year: 2001,
            series: ["Reader Series #1"],
            cover_i: 14627060,
          },
          {
            key: "/works/OL2W",
            title: "Series Book Two",
            author_name: ["Reader Author"],
            isbn: ["9780306406157"],
            first_publish_year: 2002,
            series: ["Reader Series"],
          },
        ],
      }),
    })));
    const response = await lookupSeries("Reader Series", { provider: "open_library" });
    expect(response.provider).toBe("Open Library");
    expect(response.books.map(book => ({ title: book.title, seriesNumber: book.seriesNumber }))).toEqual([
      { title: "Series Book One", seriesNumber: "1" },
      { title: "Series Book Two", seriesNumber: "2" },
    ]);
  });

  it("requires a configured token when Hardcover is selected explicitly", async () => {
    await expect(lookupSeries("Reader Series", { provider: "hardcover" }))
      .rejects.toMatchObject({ status: 400 });
  });

  it("reports an explicit Hardcover provider failure without silently changing sources", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 503,
      headers: { get: () => null },
      text: async () => "",
    })));
    await expect(lookupSeries("Reader Series", {
      provider: "hardcover",
      hardcoverToken: "test-token",
    })).rejects.toMatchObject({ status: 502 });
  });
});
