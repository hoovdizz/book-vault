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
} from "./book-search.mjs";

afterEach(() => vi.unstubAllGlobals());

describe("book search normalization", () => {
  it("normalizes and validates ISBN-10 and ISBN-13 checksums", () => {
    expect(normalizeIsbn("978-0-261-10357-3")).toBe("9780261103573");
    expect(normalizeIsbn("0-261-10357-1")).toBe("0261103571");
    expect(isIsbnQuery("9780261103573")).toBe(true);
    expect(normalizeIsbn("9780261103574")).toBe("");
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
        docs: [{
          key: "/works/OL1W",
          title: "Series Book One",
          author_name: ["Reader Author"],
          isbn: ["9780261103573"],
          series: ["Reader Series #1"],
          cover_i: 14627060,
        }],
      }),
    })));
    const response = await lookupSeries("Reader Series");
    expect(response.provider).toBe("Open Library");
    expect(response.books[0]).toMatchObject({
      title: "Series Book One",
      seriesNumber: "1",
    });
  });
});
