import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, relative, isAbsolute, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { db, ensureAdmin, hashPassword, MAX_PASSWORD_BYTES, passwordError, publicUser, verifyPassword } from "./database.mjs";
import { isAllowedCoverUrl, lookupBooks, normalizeCoverUrl, normalizeIsbn } from "./book-search.mjs";

const port = Number(process.env.PORT || 8130);
const host = process.env.HOST || "0.0.0.0";
const publicDir = normalize(join(import.meta.dirname, "..", "dist"));
const sessionDays = Math.min(90, Math.max(1, Number(process.env.SESSION_DAYS || 30)));
const sessionCookie = "bookvault_session";
const maxBodyBytes = 16_384;
const loginWindowMs = 15 * 60 * 1000;
const loginLimit = 5;
const loginAttempts = new Map();
const bookLookupLimit = 30;
const bookLookupWindowMs = 5 * 60 * 1000;
const bookLookupAttempts = new Map();
const bookLookupCache = new Map();
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png" };
const securityHeaders = {
  "Content-Security-Policy": "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: https://images.unsplash.com https://books.google.com https://books.googleusercontent.com https://covers.openlibrary.org; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

await ensureAdmin();
const dummyPasswordHash = await hashPassword(randomBytes(24).toString("hex"));
db.prepare("DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP").run();

function writeHead(res, status, headers = {}) {
  res.writeHead(status, { ...securityHeaders, ...headers });
}
function send(res, status, body, headers = {}) {
  writeHead(res, status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}
async function jsonBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw, "utf8") > maxBodyBytes) {
      const error = new Error("Request too large"); error.status = 413; throw error;
    }
  }
  try { return raw ? JSON.parse(raw) : {}; } catch {
    const error = new Error("Invalid JSON"); error.status = 400; throw error;
  }
}
function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").map(value => value.trim().split(/=(.*)/s)).filter(parts => parts[0]));
}
function currentUser(req) {
  const token = cookies(req)[sessionCookie];
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const user = db.prepare(`SELECT u.*, s.token_hash FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > CURRENT_TIMESTAMP`).get(tokenHash(token));
  if (user) db.prepare("UPDATE sessions SET last_used_at = CURRENT_TIMESTAMP WHERE token_hash = ?").run(user.token_hash);
  return user;
}
function clientAddress(req) {
  return String(req.socket.remoteAddress || "unknown");
}
function rateKeys(req, email) {
  return [`ip:${clientAddress(req)}`, `account:${String(email || "").trim().toLowerCase().slice(0, 254)}`];
}
function blocked(keys) {
  const now = Date.now();
  return keys.some(key => {
    const entry = loginAttempts.get(key);
    if (!entry || entry.resetAt <= now) { loginAttempts.delete(key); return false; }
    return entry.count >= loginLimit;
  });
}
function failedLogin(keys) {
  const now = Date.now();
  for (const key of keys) {
    const entry = loginAttempts.get(key);
    loginAttempts.set(key, !entry || entry.resetAt <= now ? { count: 1, resetAt: now + loginWindowMs } : { ...entry, count: entry.count + 1 });
  }
}
function cookieHeader(req, token, maxAge) {
  const secure = req.socket.encrypted || req.headers["x-forwarded-proto"] === "https";
  return `${sessionCookie}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}
function validEmail(email) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function audit(event, req, details = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, address: clientAddress(req), ...details }));
}
function consumeLimit(map, key, limit, windowMs) {
  const now = Date.now();
  const entry = map.get(key);
  if (!entry || entry.resetAt <= now) {
    map.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count += 1;
  return true;
}
function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function publicBook(row) {
  return {
    id: String(row.id),
    bookId: String(row.id),
    book: {
      id: String(row.id),
      isbn: row.isbn || undefined,
      title: row.title,
      author: row.author,
      series: row.series || undefined,
      seriesNumber: row.series_number || undefined,
      collection: row.collection_name || undefined,
      coverUrl: row.cover_url || undefined,
      coverOptions: parseJsonArray(row.cover_options),
      genre: row.genre || undefined,
      pageCount: row.page_count || undefined,
      publishedYear: row.published_year || undefined,
      publisher: row.publisher || undefined,
      description: row.description || undefined,
      source: row.source,
      sourceId: row.source_id || undefined,
    },
    status: row.status,
    readStatus: row.read_status,
    formats: parseJsonArray(row.formats),
    dateAdded: row.created_at,
  };
}
function boundedText(value, max, required = false) {
  const text = String(value || "").trim();
  if ((required && !text) || text.length > max) return null;
  return text;
}
function validatedBook(input) {
  const title = boundedText(input.title, 300, true);
  const author = boundedText(input.author, 300, true);
  const rawIsbn = boundedText(input.isbn, 30);
  const isbn = rawIsbn ? normalizeIsbn(rawIsbn) : "";
  const collection = boundedText(input.collection, 150);
  const series = boundedText(input.series, 150);
  const seriesNumber = boundedText(input.seriesNumber, 30);
  const publisher = boundedText(input.publisher, 200);
  const genre = boundedText(input.genre, 150);
  const description = boundedText(input.description, 5000);
  const sourceId = boundedText(input.sourceId, 100);
  if (!title || !author) throw Object.assign(new Error("Title and author are required"), { status: 400 });
  if (rawIsbn && !isbn) throw Object.assign(new Error("ISBN must be a valid ISBN-10 or ISBN-13"), { status: 400 });
  if ([collection, series, seriesNumber, publisher, genre, description, sourceId].some(value => value === null)) {
    throw Object.assign(new Error("One or more book fields are too long"), { status: 400 });
  }

  const coverUrl = normalizeCoverUrl(input.coverUrl);
  if (input.coverUrl && !coverUrl) throw Object.assign(new Error("Unsupported cover URL"), { status: 400 });
  const rawCoverOptions = Array.isArray(input.coverOptions) ? input.coverOptions.slice(0, 12) : [];
  if (rawCoverOptions.some(option => !isAllowedCoverUrl(option?.url))) {
    throw Object.assign(new Error("Unsupported cover option URL"), { status: 400 });
  }
  const coverOptions = rawCoverOptions.flatMap(option => {
    const url = normalizeCoverUrl(option?.url);
    if (!url) return [];
    return [{
      url,
      source: boundedText(option.source, 50) || "Book provider",
      label: boundedText(option.label, 100) || "Book cover",
    }];
  });

  const pageCount = input.pageCount === "" || input.pageCount == null ? null : Number(input.pageCount);
  const publishedYear = input.publishedYear === "" || input.publishedYear == null ? null : Number(input.publishedYear);
  if (pageCount !== null && (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 100_000)) {
    throw Object.assign(new Error("Page count must be a positive whole number"), { status: 400 });
  }
  if (publishedYear !== null && (!Number.isInteger(publishedYear) || publishedYear < 0 || publishedYear > new Date().getFullYear() + 5)) {
    throw Object.assign(new Error("Published year is invalid"), { status: 400 });
  }

  const allowedFormats = new Set(["physical", "ebook", "audiobook"]);
  const formats = [...new Set(Array.isArray(input.formats) ? input.formats : ["physical"])];
  if (!formats.length || formats.some(format => !allowedFormats.has(format))) {
    throw Object.assign(new Error("Select at least one valid format"), { status: 400 });
  }
  const source = ["google_books", "open_library", "manual"].includes(input.source) ? input.source : "manual";
  const status = ["owned", "wishlist", "backlog"].includes(input.status) ? input.status : "owned";
  const readStatus = ["read", "unread", "reading"].includes(input.readStatus) ? input.readStatus : "unread";
  return {
    title, author, isbn: isbn || null, collection: collection || null, series: series || null,
    seriesNumber: seriesNumber || null, publisher: publisher || null, genre: genre || null,
    description: description || null, sourceId: sourceId || null, coverUrl: coverUrl || null,
    coverOptions, pageCount, publishedYear, formats, source, status, readStatus,
  };
}

async function api(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") return send(res, 200, { status: "ok" });
  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const { email: inputEmail, password: inputPassword } = await jsonBody(req);
    const email = String(inputEmail || "").trim().toLowerCase();
    const password = String(inputPassword || "");
    const keys = rateKeys(req, email);
    if (blocked(keys)) {
      audit("login_rate_limited", req, { email });
      return send(res, 429, { error: "Too many login attempts. Try again later." }, { "Retry-After": "900" });
    }
    if (!validEmail(email) || Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
      failedLogin(keys); audit("login_failed", req, { email }); return send(res, 401, { error: "Invalid email or password" });
    }
    const user = db.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE").get(email);
    const validPassword = await verifyPassword(password, user?.password_hash || dummyPasswordHash);
    const valid = Boolean(user && validPassword);
    if (!valid) {
      failedLogin(keys); audit("login_failed", req, { email }); return send(res, 401, { error: "Invalid email or password" });
    }
    for (const key of keys) loginAttempts.delete(key);
    const token = randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + sessionDays * 86400000).toISOString();
    db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(tokenHash(token), user.id, expires);
    audit("login_succeeded", req, { userId: user.id });
    return send(res, 200, { user: publicUser(user) }, { "Set-Cookie": cookieHeader(req, token, sessionDays * 86400) });
  }
  const user = currentUser(req);
  if (!user) return send(res, 401, { error: "Authentication required" });
  if (req.method === "GET" && url.pathname === "/api/auth/me") return send(res, 200, { user: publicUser(user) });
  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(user.token_hash);
    audit("logout", req, { userId: user.id });
    return send(res, 200, { ok: true }, { "Set-Cookie": cookieHeader(req, "", 0) });
  }
  if (req.method === "GET" && url.pathname === "/api/book-search") {
    const query = String(url.searchParams.get("q") || "").trim().slice(0, 200);
    const type = ["auto", "title", "isbn"].includes(url.searchParams.get("type"))
      ? url.searchParams.get("type")
      : "auto";
    const limitKey = `${user.id}:${clientAddress(req)}`;
    if (!consumeLimit(bookLookupAttempts, limitKey, bookLookupLimit, bookLookupWindowMs)) {
      audit("book_lookup_rate_limited", req, { userId: user.id });
      return send(res, 429, { error: "Too many book searches. Try again in a few minutes." }, { "Retry-After": "300" });
    }
    const cacheKey = `${type}:${query.toLocaleLowerCase()}`;
    const cached = bookLookupCache.get(cacheKey);
    if (cached?.expiresAt > Date.now()) return send(res, 200, cached.value);
    const result = await lookupBooks(query, type, {
      googleApiKey: process.env.GOOGLE_BOOKS_API_KEY,
      timeoutMs: process.env.BOOK_LOOKUP_TIMEOUT_MS,
    });
    if (bookLookupCache.size >= 100) bookLookupCache.delete(bookLookupCache.keys().next().value);
    bookLookupCache.set(cacheKey, { value: result, expiresAt: Date.now() + 10 * 60 * 1000 });
    audit("book_lookup", req, { userId: user.id, type, resultCount: result.results.length });
    return send(res, 200, result);
  }
  if (req.method === "GET" && url.pathname === "/api/books") {
    const query = String(url.searchParams.get("q") || "").trim().slice(0, 100);
    const rows = query
      ? db.prepare(`
          SELECT * FROM books
          WHERE user_id = ? AND (
            instr(lower(title), lower(?)) > 0 OR
            instr(lower(author), lower(?)) > 0 OR
            instr(lower(COALESCE(isbn, '')), lower(?)) > 0 OR
            instr(lower(COALESCE(collection_name, '')), lower(?)) > 0 OR
            instr(lower(COALESCE(series, '')), lower(?)) > 0
          )
          ORDER BY created_at DESC, id DESC
        `).all(user.id, query, query, query, query, query)
      : db.prepare("SELECT * FROM books WHERE user_id = ? ORDER BY created_at DESC, id DESC").all(user.id);
    return send(res, 200, { books: rows.map(publicBook) });
  }
  if (req.method === "POST" && url.pathname === "/api/books") {
    const book = validatedBook(await jsonBody(req));
    const result = db.prepare(`
      INSERT INTO books (
        user_id, isbn, title, author, series, series_number, collection_name,
        cover_url, cover_options, genre, page_count, published_year, publisher,
        description, source, source_id, status, read_status, formats
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      user.id, book.isbn, book.title, book.author, book.series, book.seriesNumber,
      book.collection, book.coverUrl, JSON.stringify(book.coverOptions), book.genre,
      book.pageCount, book.publishedYear, book.publisher, book.description, book.source,
      book.sourceId, book.status, book.readStatus, JSON.stringify(book.formats),
    );
    const created = db.prepare("SELECT * FROM books WHERE id = ? AND user_id = ?").get(result.lastInsertRowid, user.id);
    audit("book_created", req, { userId: user.id, bookId: Number(result.lastInsertRowid), source: book.source });
    return send(res, 201, { book: publicBook(created) });
  }
  const bookStatusMatch = url.pathname.match(/^\/api\/books\/([1-9]\d*)\/status$/);
  if (req.method === "PATCH" && bookStatusMatch) {
    const bookId = Number(bookStatusMatch[1]);
    if (!Number.isSafeInteger(bookId)) return send(res, 400, { error: "Invalid book ID" });
    const { status } = await jsonBody(req);
    if (!["owned", "wishlist", "backlog"].includes(status)) {
      return send(res, 400, { error: "Invalid book status" });
    }
    const result = db.prepare(`
      UPDATE books
      SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?
    `).run(status, bookId, user.id);
    if (!result.changes) return send(res, 404, { error: "Book not found" });
    const updated = db.prepare("SELECT * FROM books WHERE id = ? AND user_id = ?").get(bookId, user.id);
    audit("book_status_updated", req, { userId: user.id, bookId, status });
    return send(res, 200, { book: publicBook(updated) });
  }
  if (url.pathname === "/api/users") {
    if (user.role !== "admin") return send(res, 403, { error: "Administrator access required" });
    if (req.method === "GET") return send(res, 200, { users: db.prepare("SELECT * FROM users ORDER BY name").all().map(publicUser) });
    if (req.method === "POST") {
      const { name: inputName, email: inputEmail, password: inputPassword, role = "user" } = await jsonBody(req);
      const name = String(inputName || "").trim();
      const email = String(inputEmail || "").trim().toLowerCase();
      const password = String(inputPassword || "");
      const problem = passwordError(password);
      if (!name || name.length > 100 || !validEmail(email) || problem) return send(res, 400, { error: problem || "A valid name and email are required" });
      if (!["admin", "user"].includes(role)) return send(res, 400, { error: "Invalid role" });
      try {
        const result = db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)")
          .run(name, email, await hashPassword(password), role);
        audit("user_created", req, { actorId: user.id, userId: Number(result.lastInsertRowid), role });
        return send(res, 201, { user: publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(result.lastInsertRowid)) });
      } catch (error) {
        if (String(error).includes("UNIQUE")) return send(res, 409, { error: "That email already exists" });
        throw error;
      }
    }
  }
  return send(res, 404, { error: "Not found" });
}
async function staticFile(req, res, pathname) {
  const requested = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^[/\\]+/, "");
  let file = normalize(join(publicDir, requested));
  const rel = relative(publicDir, file);
  if (rel.startsWith("..") || isAbsolute(rel)) return send(res, 403, { error: "Forbidden" });
  try { if (!(await stat(file)).isFile()) throw new Error(); } catch { file = join(publicDir, "index.html"); }
  const cache = file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable";
  writeHead(res, 200, { "Content-Type": mime[extname(file)] || "application/octet-stream", "Cache-Control": cache });
  if (req.method === "HEAD") return res.end();
  res.end(await readFile(file));
}
export const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    const unsafe = !["GET", "HEAD", "OPTIONS"].includes(req.method || "");
    const origin = req.headers.origin;
    const protocol = req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    if (unsafe && origin && origin !== `${protocol}://${req.headers.host}`) return send(res, 403, { error: "Cross-origin request rejected" });
    if (url.pathname.startsWith("/api/")) await api(req, res, url);
    else if (req.method === "GET" || req.method === "HEAD") await staticFile(req, res, url.pathname);
    else send(res, 405, { error: "Method not allowed" });
  } catch (error) {
    console.error(error);
    send(res, error.status || 500, { error: error.status ? error.message : "Internal server error" });
  }
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;

export function startServer(listenPort = port, listenHost = host) {
  return new Promise((resolveListen, reject) => {
    const onError = error => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      console.log(`BookVault listening on http://${listenHost}:${server.address().port}`);
      resolveListen(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(listenPort, listenHost);
  });
}

if (process.argv[1] && normalize(resolve(process.argv[1])) === normalize(import.meta.filename)) {
  await startServer();
}
