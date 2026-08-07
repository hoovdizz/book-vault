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
process.env.ENABLE_LEGACY_API = "true";
process.env.TRUST_PROXY = "true";

let server;
let db;
let baseUrl;
let cookie;
let defaultedBookId;
let normalizedCopyId;
let normalizedWorkId;

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

  it("accepts the trusted HTTPS reverse-proxy origin and issues a secure cookie", async () => {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://books.example.test",
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Host": "books.example.test",
        "X-Forwarded-For": "192.0.2.42",
      },
      body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Secure");

    const rejected = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://attacker.example.test",
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Host": "books.example.test",
      },
      body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
    });
    expect(rejected.status).toBe(403);
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
    for (const column of ["binding", "edition", "storage_location", "condition_grade", "condition_notes", "loaned_out", "loaned_to", "loaned_at"]) {
      expect(columns.has(column)).toBe(true);
    }
    for (const table of ["families", "family_members", "user_settings", "book_read_statuses"]) {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.name).toBe(table);
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

  it("saves personal book defaults and applies them to new physical copies", async () => {
    const settingsResponse = await fetch(`${baseUrl}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        defaultLocation: "Bookshelf in den",
        defaultBinding: "paperback",
        defaultCondition: "good",
        locations: ["Bookshelf in den", "Tote in den", "Bookshelf in kids room"],
      }),
    });
    expect(settingsResponse.status).toBe(200);
    await expect(settingsResponse.json()).resolves.toMatchObject({
      settings: {
        defaultLocation: "Bookshelf in den",
        defaultBinding: "paperback",
        defaultCondition: "good",
        locations: ["Bookshelf in den", "Tote in den", "Bookshelf in kids room"],
        locationScope: "personal",
      },
    });

    const createResponse = await fetch(`${baseUrl}/api/books`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        title: "Defaulted Family Book",
        author: "BookVault",
        status: "owned",
        formats: ["physical"],
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    defaultedBookId = created.book.id;
    expect(created.book).toMatchObject({
      readStatus: "unread",
      storageLocation: "Bookshelf in den",
      conditionGrade: "good",
      book: { binding: "paperback" },
    });
  });

  it("shares family-owned books and locations while keeping reading state and wishlists personal", async () => {
    const createFamilyUserResponse = await fetch(`${baseUrl}/api/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Family Reader",
        email: "family-reader@bookvault.local",
        password: "familypassword",
        role: "user",
      }),
    });
    expect(createFamilyUserResponse.status).toBe(201);
    const familyUser = (await createFamilyUserResponse.json()).user;

    const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "family-reader@bookvault.local", password: "familypassword" }),
    });
    expect(loginResponse.status).toBe(200);
    const familyCookie = loginResponse.headers.get("set-cookie").split(";")[0];

    const privateWishlistResponse = await fetch(`${baseUrl}/api/books`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        title: "Private Family Wishlist Book",
        author: "BookVault",
        status: "wishlist",
        formats: ["physical"],
      }),
    });
    expect(privateWishlistResponse.status).toBe(201);

    const familyResponse = await fetch(`${baseUrl}/api/family`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Integration Family",
        memberIds: [familyUser.id],
      }),
    });
    expect(familyResponse.status).toBe(200);
    await expect(familyResponse.json()).resolves.toMatchObject({
      family: {
        name: "Integration Family",
        members: expect.arrayContaining([
          expect.objectContaining({ email: process.env.ADMIN_EMAIL }),
          expect.objectContaining({ email: "family-reader@bookvault.local" }),
        ]),
      },
    });

    const familySettingsResponse = await fetch(`${baseUrl}/api/settings`, {
      headers: { Cookie: familyCookie },
    });
    expect(familySettingsResponse.status).toBe(200);
    await expect(familySettingsResponse.json()).resolves.toMatchObject({
      settings: {
        defaultLocation: "",
        locations: ["Bookshelf in den", "Tote in den", "Bookshelf in kids room"],
        locationScope: "family",
      },
    });
    const nonAdminFamilyUpdate = await fetch(`${baseUrl}/api/family`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: familyCookie },
      body: JSON.stringify({ name: "Unauthorized Rename", memberIds: [familyUser.id] }),
    });
    expect(nonAdminFamilyUpdate.status).toBe(403);

    const familyBooksResponse = await fetch(`${baseUrl}/api/books?q=Defaulted%20Family%20Book`, {
      headers: { Cookie: familyCookie },
    });
    expect(familyBooksResponse.status).toBe(200);
    const familyBooks = await familyBooksResponse.json();
    expect(familyBooks.books).toHaveLength(1);
    expect(familyBooks.books[0]).toMatchObject({
      id: defaultedBookId,
      readStatus: "unread",
      shared: true,
      canDelete: false,
      owner: { name: "Integration Admin" },
    });

    const updateSharedResponse = await fetch(`${baseUrl}/api/books/${defaultedBookId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: familyCookie },
      body: JSON.stringify({
        title: "Defaulted Family Book",
        author: "BookVault",
        status: "owned",
        readStatus: "read",
        formats: ["physical"],
        binding: "paperback",
        storageLocation: "Tote in den",
        conditionGrade: "good",
      }),
    });
    expect(updateSharedResponse.status).toBe(200);
    await expect(updateSharedResponse.json()).resolves.toMatchObject({
      book: { readStatus: "read", storageLocation: "Tote in den", shared: true },
    });
    const moveSharedResponse = await fetch(`${baseUrl}/api/books/${defaultedBookId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: familyCookie },
      body: JSON.stringify({
        title: "Defaulted Family Book",
        author: "BookVault",
        status: "wishlist",
        readStatus: "read",
        formats: ["physical"],
        binding: "paperback",
        storageLocation: "Tote in den",
        conditionGrade: "good",
      }),
    });
    expect(moveSharedResponse.status).toBe(403);

    const adminViewResponse = await fetch(`${baseUrl}/api/books?q=Defaulted%20Family%20Book`, {
      headers: { Cookie: cookie },
    });
    const adminView = await adminViewResponse.json();
    expect(adminView.books[0]).toMatchObject({
      readStatus: "unread",
      storageLocation: "Tote in den",
      shared: false,
      canDelete: true,
    });

    const privateWishlistView = await fetch(`${baseUrl}/api/books?q=Private%20Family%20Wishlist%20Book`, {
      headers: { Cookie: familyCookie },
    });
    await expect(privateWishlistView.json()).resolves.toEqual({ books: [] });

    const crossFamilyDelete = await fetch(`${baseUrl}/api/books/${defaultedBookId}`, {
      method: "DELETE",
      headers: { Cookie: familyCookie },
    });
    expect(crossFamilyDelete.status).toBe(404);

    const familyDefaultsResponse = await fetch(`${baseUrl}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: familyCookie },
      body: JSON.stringify({
        defaultLocation: "Bookshelf in kids room",
        defaultBinding: "hardcover",
        defaultCondition: "like_new",
        locations: ["Bookshelf in den", "Tote in den", "Bookshelf in kids room"],
      }),
    });
    expect(familyDefaultsResponse.status).toBe(200);

    const familyOwnedResponse = await fetch(`${baseUrl}/api/books`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: familyCookie },
      body: JSON.stringify({
        title: "Family Reader Owned Book",
        author: "BookVault",
        status: "owned",
        formats: ["physical"],
      }),
    });
    expect(familyOwnedResponse.status).toBe(201);
    await expect(familyOwnedResponse.json()).resolves.toMatchObject({
      book: {
        storageLocation: "Bookshelf in kids room",
        conditionGrade: "like_new",
        book: { binding: "hardcover" },
      },
    });

    const adminFamilyOwnedView = await fetch(`${baseUrl}/api/books?q=Family%20Reader%20Owned%20Book`, {
      headers: { Cookie: cookie },
    });
    await expect(adminFamilyOwnedView.json()).resolves.toMatchObject({
      books: [expect.objectContaining({
        shared: true,
        readStatus: "unread",
        owner: expect.objectContaining({ name: "Family Reader" }),
      })],
    });
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

  it("uses normalized works, editions, copies, duplicate review, and hierarchical locations", async () => {
    const homeResponse = await fetch(`${baseUrl}/api/locations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: "Home", levelType: "building" }),
    });
    expect(homeResponse.status).toBe(201);
    const home = await homeResponse.json();
    const homeId = home.id;

    const shelfResponse = await fetch(`${baseUrl}/api/locations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: "Shelf 4", levelType: "shelf", parentId: homeId }),
    });
    expect(shelfResponse.status).toBe(201);
    const shelf = await shelfResponse.json();
    const shelfId = shelf.id;

    const firstResponse = await fetch(`${baseUrl}/api/catalog`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        title: "Normalized Catalog Book",
        author: "Catalog Author",
        isbn: "0-306-40615-2",
        status: "owned",
        formats: ["physical"],
        locationId: shelfId,
        series: "Decimal Series",
        seriesNumber: "1.5",
        readingOrder: 1.25,
        readStatus: "reading",
      }),
    });
    expect(firstResponse.status).toBe(201);
    const first = await firstResponse.json();
    expect(first.created).toHaveLength(1);
    normalizedCopyId = String(first.created[0].id);
    normalizedWorkId = String(first.workId);

    const duplicateResponse = await fetch(`${baseUrl}/api/catalog/duplicates`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ isbn: "9780306406157", title: "Different display title", author: "Catalog Author" }),
    });
    expect(duplicateResponse.status).toBe(200);
    const duplicate = await duplicateResponse.json();
    expect(duplicate.warnings[0]).toMatchObject({
      matchType: "exact_isbn",
      copyCount: 1,
      hasOwnedCopies: true,
      hasRequests: false,
      copies: [expect.objectContaining({ location: "Home / Shelf 4" })],
    });

    const anotherCopyResponse = await fetch(`${baseUrl}/api/catalog`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        title: "Normalized Catalog Book",
        author: "Catalog Author",
        isbn: "9780306406157",
        status: "owned",
        formats: ["physical"],
        locationId: shelfId,
      }),
    });
    expect(anotherCopyResponse.status).toBe(201);

    const householdCopyResponse = await fetch(`${baseUrl}/api/catalog`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        title: "Normalized Catalog Book",
        author: "Catalog Author",
        isbn: "9780306406157",
        status: "owned",
        formats: ["physical"],
        householdOwned: true,
        locationId: shelfId,
      }),
    });
    expect(householdCopyResponse.status).toBe(201);

    const catalogResponse = await fetch(`${baseUrl}/api/catalog?q=Decimal%20Series&page=1&pageSize=10`, {
      headers: { Cookie: cookie },
    });
    expect(catalogResponse.status).toBe(200);
    const catalog = await catalogResponse.json();
    expect(catalog.pagination).toMatchObject({ page: 1, pageSize: 10, total: 3 });
    expect(catalog.items[0]).toMatchObject({
      status: "owned",
      storageLocation: "Home / Shelf 4",
      counts: { editions: 1, editionCopies: 3, workCopies: 3 },
      book: { isbn13: "9780306406157", series: "Decimal Series", seriesNumber: "1.5" },
    });
    expect(catalog.items.map(item => item.copyId).filter(Boolean)).toHaveLength(3);

    const mineResponse = await fetch(`${baseUrl}/api/catalog?q=Normalized%20Catalog&status=owned&ownership=mine`, {
      headers: { Cookie: cookie },
    });
    expect(mineResponse.status).toBe(200);
    expect((await mineResponse.json()).pagination.total).toBe(2);

    const householdResponse = await fetch(`${baseUrl}/api/catalog?q=Normalized%20Catalog&status=owned&ownership=household`, {
      headers: { Cookie: cookie },
    });
    expect(householdResponse.status).toBe(200);
    const householdCatalog = await householdResponse.json();
    expect(householdCatalog.pagination.total).toBe(1);
    expect(householdCatalog.items[0].owner.name).toBe("Household");
  });

  it("saves series entries through the batch workflow and returns them in series inventory", async () => {
    const review = await fetch(`${baseUrl}/api/catalog/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ mode: "review", entries: [{
        title: "Batch Series Volume One",
        author: "Series Author",
        status: "owned",
        formats: ["physical"],
        series: "Canonical Batch Series",
        seriesNumber: "1",
      }] }),
    });
    expect(review.status).toBe(200);
    const reviewPayload = await review.json();
    expect(reviewPayload.results[0].state).toBe("success");
    const save = await fetch(`${baseUrl}/api/catalog/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ mode: "save", entries: [{
        title: "Batch Series Volume One",
        author: "Series Author",
        status: "owned",
        formats: ["physical"],
        series: "Canonical Batch Series",
        seriesNumber: "1",
      }] }),
    });
    expect(save.status).toBe(207);
    const savePayload = await save.json();
    expect(savePayload.results[0].state).toBe("success");
    const inventory = await fetch(`${baseUrl}/api/catalog/series`, { headers: { Cookie: cookie } });
    expect(inventory.status).toBe(200);
    const inventoryPayload = await inventory.json();
    expect(inventoryPayload.series).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Canonical Batch Series", ownedWorkCount: 1 }),
    ]));
  });

  it("keeps loan history and per-member private reading activity separate", async () => {
    const childCreate = await fetch(`${baseUrl}/api/household/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Catalog Child",
        email: "catalog-child@bookvault.local",
        password: "catalogchildpassword",
        householdRole: "child",
      }),
    });
    expect(childCreate.status).toBe(201);
    const child = (await childCreate.json()).members.find(member => member.email === "catalog-child@bookvault.local");
    const childLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: child.email, password: "catalogchildpassword" }),
    });
    expect(childLogin.status).toBe(200);
    const childCookie = childLogin.headers.get("set-cookie").split(";")[0];

    const childInventoryAttempt = await fetch(`${baseUrl}/api/catalog`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: childCookie },
      body: JSON.stringify({
        title: "Child Owned Attempt",
        author: "Permission Test",
        status: "owned",
        formats: ["physical"],
      }),
    });
    expect(childInventoryAttempt.status).toBe(403);

    const childReading = await fetch(`${baseUrl}/api/reading/works/${normalizedWorkId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: childCookie },
      body: JSON.stringify({
        status: "reading",
        privateNotes: "Only the child can see this",
        householdNotes: "Reading this now",
        rating: 4.5,
      }),
    });
    expect(childReading.status).toBe(200);
    await expect(childReading.json()).resolves.toMatchObject({
      state: {
        status: "reading",
        privateNotes: "Only the child can see this",
        householdNotes: "Reading this now",
      },
    });

    const adminView = await fetch(`${baseUrl}/api/reading/works/${normalizedWorkId}?userId=${child.id}`, {
      headers: { Cookie: cookie },
    });
    expect(adminView.status).toBe(200);
    const adminReading = await adminView.json();
    expect(adminReading.state.privateNotes).toBeUndefined();
    expect(adminReading.state.householdNotes).toBe("Reading this now");

    const checkout = await fetch(`${baseUrl}/api/loans`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        copyId: normalizedCopyId,
        borrowerUserId: child.id,
        checkoutAt: "2026-08-01",
        dueAt: "2026-08-10",
      }),
    });
    expect(checkout.status).toBe(201);
    const loan = (await checkout.json()).loan;
    expect(loan).toMatchObject({ copyId: normalizedCopyId, borrower: { type: "member", name: "Catalog Child" } });

    const returned = await fetch(`${baseUrl}/api/loans/${loan.id}/return`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ returnedAt: "2026-08-09" }),
    });
    expect(returned.status).toBe(200);
    await expect(returned.json()).resolves.toMatchObject({ loan: { status: "returned", returnedAt: expect.any(String) } });

    const history = await fetch(`${baseUrl}/api/loans?history=true`, { headers: { Cookie: cookie } });
    expect(history.status).toBe(200);
    const historyPayload = await history.json();
    expect(historyPayload.loans).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: loan.id, status: "returned", copyId: normalizedCopyId }),
    ]));
  });

  it("creates, validates, previews, and downloads a complete persistent backup", async () => {
    const create = await fetch(`${baseUrl}/api/admin/backups`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(create.status).toBe(201);
    const backup = (await create.json()).backup;
    expect(backup).toMatchObject({
      status: "complete",
      integrity: "ok",
      counts: expect.objectContaining({ users: expect.any(Number), works: expect.any(Number), copies: expect.any(Number) }),
    });

    const preview = await fetch(`${baseUrl}/api/admin/backups/${backup.id}/restore-preview`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(preview.status).toBe(200);
    await expect(preview.json()).resolves.toMatchObject({
      preview: {
        ready: true,
        database: {
          integrity: "ok",
          databaseVersion: 6,
        },
        manifest: { application: "Book Vault", includes: ["database", "covers"] },
      },
    });

    const download = await fetch(`${baseUrl}/api/admin/backups/${backup.id}/download`, {
      headers: { Cookie: cookie },
    });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/x-tar");
    expect((await download.arrayBuffer()).byteLength).toBeGreaterThan(1024);

    const integrity = await fetch(`${baseUrl}/api/admin/integrity`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(integrity.status).toBe(200);
    await expect(integrity.json()).resolves.toEqual({ status: "ok", messages: ["ok"] });

    const maintenanceStatus = await fetch(`${baseUrl}/api/admin/maintenance`, { headers: { Cookie: cookie } });
    expect(maintenanceStatus.status).toBe(200);
    const maintenanceRun = await fetch(`${baseUrl}/api/admin/maintenance`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
    });
    expect(maintenanceRun.status).toBe(200);
    await expect(maintenanceRun.json()).resolves.toMatchObject({ run: { status: "complete" } });
  });
});
