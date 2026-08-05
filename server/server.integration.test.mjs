// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const testDirectory = mkdtempSync(join(tmpdir(), "book-vault-api-"));
process.env.DATABASE_PATH = join(testDirectory, "book-vault.sqlite");
process.env.ADMIN_NAME = "Integration Admin";
process.env.ADMIN_EMAIL = "integration@bookvault.local";
process.env.ADMIN_PASSWORD = "integrationpassword";

let server;
let db;
let baseUrl;
let cookie;

beforeAll(async () => {
  // Start from the pre-copy-details schema so every API integration run also
  // proves that an existing Unraid database is migrated in place.
  const legacyDatabase = new DatabaseSync(process.env.DATABASE_PATH);
  legacyDatabase.exec(`
    CREATE TABLE books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      isbn TEXT,
      title TEXT NOT NULL,
      author TEXT NOT NULL,
      series TEXT,
      series_number TEXT,
      collection_name TEXT,
      cover_url TEXT,
      cover_options TEXT NOT NULL DEFAULT '[]',
      genre TEXT,
      page_count INTEGER,
      published_year INTEGER,
      publisher TEXT,
      description TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      source_id TEXT,
      status TEXT NOT NULL DEFAULT 'owned',
      read_status TEXT NOT NULL DEFAULT 'unread',
      formats TEXT NOT NULL DEFAULT '["physical"]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  legacyDatabase.close();

  const module = await import("./server.mjs");
  server = module.server;
  const database = await import("./database.mjs");
  db = database.db;
  await module.startServer(0, "127.0.0.1");
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
  });
  expect(response.status).toBe(200);
  cookie = response.headers.get("set-cookie").split(";")[0];
});

afterAll(async () => {
  if (server?.listening) await new Promise(resolveClose => server.close(resolveClose));
  db?.close();
  rmSync(testDirectory, { recursive: true, force: true });
});

describe("books API", () => {
  it("allows camera access only for the BookVault origin", async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    expect(response.headers.get("permissions-policy")).toContain("camera=(self)");
    expect(response.headers.get("permissions-policy")).toContain("microphone=()");
    expect(response.headers.get("content-security-policy")).toContain("img-src 'self' data: blob:");
  });

  it("rejects unsupported series providers without making an external request", async () => {
    const response = await fetch(`${baseUrl}/api/series-search?q=Reader%20Series&provider=goodreads`, {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid series provider" });
  });

  it("migrates existing databases with the copy-detail fields", () => {
    const columns = new Set(db.prepare("PRAGMA table_info(books)").all().map(column => column.name));
    for (const column of ["binding", "edition", "condition_grade", "condition_notes", "loaned_out", "loaned_to", "loaned_at"]) {
      expect(columns.has(column)).toBe(true);
    }
  });

  it("persists and searches collection and series metadata by ISBN", async () => {
    const createResponse = await fetch(`${baseUrl}/api/books`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        title: "Integration Test Book",
        author: "BookVault",
        isbn: "9780261103573",
        collection: "Test Collection",
        series: "Test Series",
        seriesNumber: "2",
        formats: ["physical", "ebook"],
        source: "manual",
      }),
    });
    expect(createResponse.status).toBe(201);

    const response = await fetch(`${baseUrl}/api/books?q=9780261103573`, {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.books).toHaveLength(1);
    expect(payload.books[0]).toMatchObject({
      formats: ["physical", "ebook"],
      book: {
        title: "Integration Test Book",
        isbn: "9780261103573",
        collection: "Test Collection",
        series: "Test Series",
        seriesNumber: "2",
      },
    });
  });

  it("persists wishlist additions and moves them into the collection", async () => {
    const createResponse = await fetch(`${baseUrl}/api/books`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        title: "Wishlist Integration Book",
        author: "BookVault",
        status: "wishlist",
        formats: ["physical"],
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    expect(created.book.status).toBe("wishlist");

    const createOtherUserResponse = await fetch(`${baseUrl}/api/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Wishlist Reader",
        email: "wishlist-reader@bookvault.local",
        password: "wishlistpassword",
        role: "user",
      }),
    });
    expect(createOtherUserResponse.status).toBe(201);
    const otherLoginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "wishlist-reader@bookvault.local",
        password: "wishlistpassword",
      }),
    });
    expect(otherLoginResponse.status).toBe(200);
    const otherCookie = otherLoginResponse.headers.get("set-cookie").split(";")[0];
    const crossUserMoveResponse = await fetch(`${baseUrl}/api/books/${created.book.id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: otherCookie },
      body: JSON.stringify({ status: "owned" }),
    });
    expect(crossUserMoveResponse.status).toBe(404);

    const moveResponse = await fetch(`${baseUrl}/api/books/${created.book.id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ status: "owned" }),
    });
    expect(moveResponse.status).toBe(200);
    const moved = await moveResponse.json();
    expect(moved.book).toMatchObject({
      id: created.book.id,
      status: "owned",
      book: { title: "Wishlist Integration Book" },
    });
  });

  it("edits book metadata and reading status", async () => {
    const createResponse = await fetch(`${baseUrl}/api/books`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        title: "Editable Book",
        author: "Original Author",
        formats: ["physical"],
      }),
    });
    const created = await createResponse.json();

    const updateResponse = await fetch(`${baseUrl}/api/books/${created.book.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        title: "Edited Book",
        author: "Updated Author",
        collection: "Edited Shelf",
        series: "Edited Series",
        seriesNumber: "3",
        readStatus: "read",
        status: "owned",
        formats: ["physical", "ebook"],
        binding: "hardcover",
        edition: "First limited edition",
        conditionGrade: "fair",
        conditionNotes: "Bent corners and a broken spine",
        loanedOut: true,
        loanedTo: "Test Reader",
        loanedAt: "2026-08-04",
      }),
    });
    expect(updateResponse.status).toBe(200);
    const updated = await updateResponse.json();
    expect(updated.book).toMatchObject({
      status: "owned",
      readStatus: "read",
      formats: ["physical", "ebook"],
      conditionGrade: "fair",
      conditionNotes: "Bent corners and a broken spine",
      loanedOut: true,
      loanedTo: "Test Reader",
      loanedAt: "2026-08-04",
      book: {
        title: "Edited Book",
        author: "Updated Author",
        collection: "Edited Shelf",
        series: "Edited Series",
        seriesNumber: "3",
        binding: "hardcover",
        edition: "First limited edition",
      },
    });
  });

  it("removes only the signed-in user's book", async () => {
    const createResponse = await fetch(`${baseUrl}/api/books`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        title: "Delete Integration Book",
        author: "BookVault",
        status: "owned",
        formats: ["physical"],
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();

    const createOtherUserResponse = await fetch(`${baseUrl}/api/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Delete Reader",
        email: "delete-reader@bookvault.local",
        password: "deletepassword",
        role: "user",
      }),
    });
    expect(createOtherUserResponse.status).toBe(201);
    const otherLoginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "delete-reader@bookvault.local",
        password: "deletepassword",
      }),
    });
    expect(otherLoginResponse.status).toBe(200);
    const otherCookie = otherLoginResponse.headers.get("set-cookie").split(";")[0];

    const crossUserDeleteResponse = await fetch(`${baseUrl}/api/books/${created.book.id}`, {
      method: "DELETE",
      headers: { Cookie: otherCookie },
    });
    expect(crossUserDeleteResponse.status).toBe(404);

    const deleteResponse = await fetch(`${baseUrl}/api/books/${created.book.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(deleteResponse.status).toBe(200);
    await expect(deleteResponse.json()).resolves.toEqual({ ok: true });

    const deletedBookResponse = await fetch(`${baseUrl}/api/books/${created.book.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(deletedBookResponse.status).toBe(404);
  });

  it("finds duplicate owned copies across ISBN, binding, and edition differences", async () => {
    const copies = [
      {
        title: "Duplicate Runner Book",
        author: "Nora Duplicate",
        isbn: "9780306406157",
        binding: "paperback",
        edition: "Book club edition",
        conditionGrade: "good",
        formats: ["physical"],
        status: "owned",
      },
      {
        title: "Duplicate Runner Book: Limited Hardcover Edition",
        author: "Duplicate, Nora",
        isbn: "9783161484100",
        binding: "hardcover",
        edition: "Signed first edition",
        conditionGrade: "like_new",
        formats: ["physical"],
        status: "owned",
      },
      {
        title: "Duplicate Runner Book",
        author: "Nora Duplicate",
        binding: "hardcover",
        formats: ["physical"],
        status: "wishlist",
      },
    ];
    for (const copy of copies) {
      const response = await fetch(`${baseUrl}/api/books`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify(copy),
      });
      expect(response.status).toBe(201);
    }

    const response = await fetch(`${baseUrl}/api/books/duplicates`, {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    const payload = await response.json();
    const group = payload.groups.find(candidate => candidate.title.startsWith("Duplicate Runner Book"));
    expect(group.copies).toHaveLength(2);
    expect(group.copies.map(copy => copy.book.binding).sort()).toEqual(["hardcover", "paperback"]);
    expect(group.copies.map(copy => copy.book.edition).sort()).toEqual(["Book club edition", "Signed first edition"]);
    expect(group.copies.every(copy => copy.status === "owned")).toBe(true);
  });

  it("bulk imports series choices and skips duplicates", async () => {
    const books = [
      {
        title: "Bulk Series One",
        author: "Series Author",
        series: "Bulk Series",
        seriesNumber: "1",
        status: "owned",
        formats: ["physical"],
      },
      {
        title: "Bulk Series Two",
        author: "Series Author",
        series: "Bulk Series",
        seriesNumber: "2",
        status: "wishlist",
        formats: ["physical"],
      },
    ];
    const response = await fetch(`${baseUrl}/api/books/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ books }),
    });
    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload.books.map(book => book.status)).toEqual(["owned", "wishlist"]);
    expect(payload.skipped).toEqual([]);

    const duplicateResponse = await fetch(`${baseUrl}/api/books/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ books }),
    });
    expect(duplicateResponse.status).toBe(201);
    const duplicatePayload = await duplicateResponse.json();
    expect(duplicatePayload.books).toEqual([]);
    expect(duplicatePayload.skipped).toHaveLength(2);
  });

  it("keeps persisted collections isolated between users", async () => {
    const createUserResponse = await fetch(`${baseUrl}/api/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Second Reader",
        email: "reader@bookvault.local",
        password: "readerpassword",
        role: "user",
      }),
    });
    expect(createUserResponse.status).toBe(201);

    const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "reader@bookvault.local", password: "readerpassword" }),
    });
    expect(loginResponse.status).toBe(200);
    const readerCookie = loginResponse.headers.get("set-cookie").split(";")[0];

    const booksResponse = await fetch(`${baseUrl}/api/books`, {
      headers: { Cookie: readerCookie },
    });
    expect(booksResponse.status).toBe(200);
    await expect(booksResponse.json()).resolves.toEqual({ books: [] });
  });

  it("rejects cover URLs outside the approved providers", async () => {
    const response = await fetch(`${baseUrl}/api/books`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        title: "Unsafe Cover",
        author: "BookVault",
        coverUrl: "https://example.invalid/cover.jpg",
        formats: ["physical"],
      }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Unsupported cover URL" });
  });
});
