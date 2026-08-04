// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
      }),
    });
    expect(updateResponse.status).toBe(200);
    const updated = await updateResponse.json();
    expect(updated.book).toMatchObject({
      status: "owned",
      readStatus: "read",
      formats: ["physical", "ebook"],
      book: {
        title: "Edited Book",
        author: "Updated Author",
        collection: "Edited Shelf",
        series: "Edited Series",
        seriesNumber: "3",
      },
    });
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
