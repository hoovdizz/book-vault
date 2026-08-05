import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, relative, isAbsolute, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { db, ensureAdmin, hashPassword, MAX_PASSWORD_BYTES, passwordError, publicUser, verifyPassword } from "./database.mjs";
import { isAllowedCoverUrl, lookupBooks, lookupSeries, normalizeCoverUrl, normalizeIsbn } from "./book-search.mjs";

const port = Number(process.env.PORT || 8130);
const host = process.env.HOST || "0.0.0.0";
const publicDir = normalize(join(import.meta.dirname, "..", "dist"));
const sessionDays = Math.min(90, Math.max(1, Number(process.env.SESSION_DAYS || 30)));
const sessionCookie = "bookvault_session";
const maxBodyBytes = 16_384;
const maxBulkBodyBytes = 1024 * 1024;
const loginWindowMs = 15 * 60 * 1000;
const loginLimit = 5;
const loginAttempts = new Map();
const bookLookupLimit = 30;
const bookLookupWindowMs = 5 * 60 * 1000;
const bookLookupAttempts = new Map();
const bookLookupCache = new Map();
const allowedBindings = new Set(["hardcover", "paperback", "mass_market_paperback", "library_binding", "spiral_bound", "other"]);
const allowedConditions = new Set(["new", "like_new", "good", "fair", "poor", "damaged"]);
const allowedReadStatuses = new Set(["read", "unread", "reading"]);
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png" };
const securityHeaders = {
  "Content-Security-Policy": "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob: https://images.unsplash.com https://books.google.com https://books.googleusercontent.com https://covers.openlibrary.org https://assets.hardcover.app; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
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
async function jsonBody(req, limit = maxBodyBytes) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw, "utf8") > limit) {
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
  const isOwner = row.is_owner == null ? true : Boolean(row.is_owner);
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
      binding: row.binding || undefined,
      edition: row.edition || undefined,
      source: row.source,
      sourceId: row.source_id || undefined,
    },
    status: row.status,
    readStatus: row.viewer_read_status || row.read_status || "unread",
    formats: parseJsonArray(row.formats),
    storageLocation: row.storage_location || undefined,
    conditionGrade: row.condition_grade || undefined,
    conditionNotes: row.condition_notes || undefined,
    loanedOut: Boolean(row.loaned_out),
    loanedTo: row.loaned_to || undefined,
    loanedAt: row.loaned_at || undefined,
    owner: row.owner_name ? { id: String(row.user_id), name: row.owner_name } : undefined,
    shared: !isOwner && row.status === "owned",
    canDelete: isOwner,
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
  const edition = boundedText(input.edition, 150);
  const storageLocation = boundedText(input.storageLocation, 150);
  const conditionNotes = boundedText(input.conditionNotes, 2000);
  const loanedTo = boundedText(input.loanedTo, 150);
  if (!title || !author) throw Object.assign(new Error("Title and author are required"), { status: 400 });
  if (rawIsbn && !isbn) throw Object.assign(new Error("ISBN must be a valid ISBN-10 or ISBN-13"), { status: 400 });
  if ([collection, series, seriesNumber, publisher, genre, description, sourceId, edition, storageLocation, conditionNotes, loanedTo].some(value => value === null)) {
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
  const readStatus = allowedReadStatuses.has(input.readStatus) ? input.readStatus : "unread";
  const binding = input.binding === "" || input.binding == null ? null : input.binding;
  if (binding !== null && !allowedBindings.has(binding)) {
    throw Object.assign(new Error("Invalid binding"), { status: 400 });
  }
  const conditionGrade = input.conditionGrade === "" || input.conditionGrade == null ? null : input.conditionGrade;
  if (conditionGrade !== null && !allowedConditions.has(conditionGrade)) {
    throw Object.assign(new Error("Invalid book condition"), { status: 400 });
  }
  const rawLoanedAt = boundedText(input.loanedAt, 10);
  if (rawLoanedAt === null || (rawLoanedAt && !/^\d{4}-\d{2}-\d{2}$/.test(rawLoanedAt))) {
    throw Object.assign(new Error("Loan date must use YYYY-MM-DD"), { status: 400 });
  }
  const loanedOut = status === "owned" && input.loanedOut === true;
  return {
    title, author, isbn: isbn || null, collection: collection || null, series: series || null,
    seriesNumber: seriesNumber || null, publisher: publisher || null, genre: genre || null,
    description: description || null, sourceId: sourceId || null, coverUrl: coverUrl || null,
    coverOptions, pageCount, publishedYear, formats, source, status, readStatus, binding,
    edition: edition || null, storageLocation: storageLocation || null,
    conditionGrade, conditionNotes: conditionNotes || null,
    loanedOut, loanedTo: loanedOut ? loanedTo || null : null,
    loanedAt: loanedOut ? rawLoanedAt || null : null,
  };
}

const insertBookStatement = db.prepare(`
  INSERT INTO books (
    user_id, isbn, title, author, series, series_number, collection_name,
    cover_url, cover_options, genre, page_count, published_year, publisher,
    description, binding, edition, storage_location, condition_grade, condition_notes, loaned_out,
    loaned_to, loaned_at, source, source_id, status, read_status, formats
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function familyForUser(userId) {
  return db.prepare(`
    SELECT f.* FROM families f
    JOIN family_members fm ON fm.family_id = f.id
    WHERE fm.user_id = ?
  `).get(userId);
}

function storedUserSettings(userId) {
  return db.prepare("SELECT * FROM user_settings WHERE user_id = ?").get(userId) || {
    user_id: userId,
    default_location: null,
    default_binding: null,
    default_condition: null,
    locations: "[]",
  };
}

function settingsForUser(userId) {
  const settings = storedUserSettings(userId);
  const family = familyForUser(userId);
  return {
    defaultLocation: settings.default_location || "",
    defaultBinding: settings.default_binding || "",
    defaultCondition: settings.default_condition || "",
    locations: parseJsonArray(family?.locations || settings.locations),
    locationScope: family ? "family" : "personal",
  };
}

function applyBookDefaults(userId, book) {
  if (book.status !== "owned" || !book.formats.includes("physical")) return book;
  const settings = storedUserSettings(userId);
  return {
    ...book,
    binding: book.binding || settings.default_binding || null,
    storageLocation: book.storageLocation || settings.default_location || null,
    conditionGrade: book.conditionGrade || settings.default_condition || null,
  };
}

const setReadStatusStatement = db.prepare(`
  INSERT INTO book_read_statuses (book_id, user_id, read_status, updated_at)
  VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(book_id, user_id) DO UPDATE SET
    read_status = excluded.read_status,
    updated_at = CURRENT_TIMESTAMP
`);

function setReadStatus(bookId, userId, readStatus) {
  setReadStatusStatement.run(bookId, userId, readStatus);
  db.prepare("UPDATE books SET read_status = ? WHERE id = ? AND user_id = ?").run(readStatus, bookId, userId);
}

function insertBook(userId, inputBook) {
  const book = applyBookDefaults(userId, inputBook);
  const result = insertBookStatement.run(
    userId, book.isbn, book.title, book.author, book.series, book.seriesNumber,
    book.collection, book.coverUrl, JSON.stringify(book.coverOptions), book.genre,
    book.pageCount, book.publishedYear, book.publisher, book.description, book.binding,
    book.edition, book.storageLocation, book.conditionGrade, book.conditionNotes, book.loanedOut ? 1 : 0,
    book.loanedTo, book.loanedAt, book.source, book.sourceId, book.status, book.readStatus,
    JSON.stringify(book.formats),
  );
  setReadStatus(Number(result.lastInsertRowid), userId, book.readStatus);
  return result;
}

const visibleBookSelect = `
  SELECT b.*, reading.read_status AS viewer_read_status, owner.name AS owner_name,
    CASE WHEN b.user_id = ? THEN 1 ELSE 0 END AS is_owner
  FROM books b
  JOIN users owner ON owner.id = b.user_id
  LEFT JOIN book_read_statuses reading ON reading.book_id = b.id AND reading.user_id = ?
`;
const visibleBookAccess = `
  (
    b.user_id = ?
    OR (
      b.status = 'owned'
      AND EXISTS (
        SELECT 1
        FROM family_members viewer_family
        JOIN family_members owner_family ON owner_family.family_id = viewer_family.family_id
        WHERE viewer_family.user_id = ? AND owner_family.user_id = b.user_id
      )
    )
  )
`;

function visibleBookRows(userId, { query = "", ownedOnly = false } = {}) {
  const filters = [visibleBookAccess];
  const parameters = [userId, userId, userId, userId];
  if (ownedOnly) filters.push("b.status = 'owned'");
  if (query) {
    filters.push(`(
      instr(lower(b.title), lower(?)) > 0 OR
      instr(lower(b.author), lower(?)) > 0 OR
      instr(lower(COALESCE(b.isbn, '')), lower(?)) > 0 OR
      instr(lower(COALESCE(b.collection_name, '')), lower(?)) > 0 OR
      instr(lower(COALESCE(b.series, '')), lower(?)) > 0 OR
      instr(lower(COALESCE(b.storage_location, '')), lower(?)) > 0
    )`);
    parameters.push(query, query, query, query, query, query);
  }
  return db.prepare(`
    ${visibleBookSelect}
    WHERE ${filters.map(filter => `(${filter})`).join(" AND ")}
    ORDER BY b.created_at DESC, b.id DESC
  `).all(...parameters);
}

function visibleBookById(userId, bookId) {
  return db.prepare(`
    ${visibleBookSelect}
    WHERE b.id = ? AND ${visibleBookAccess}
  `).get(userId, userId, bookId, userId, userId);
}

function validatedLocations(input) {
  if (!Array.isArray(input) || input.length > 50) {
    throw Object.assign(new Error("Locations must be a list of no more than 50 names"), { status: 400 });
  }
  const locations = [];
  const seen = new Set();
  for (const value of input) {
    const location = boundedText(value, 150);
    if (location === null) throw Object.assign(new Error("Location names must be 150 characters or fewer"), { status: 400 });
    if (!location) continue;
    const key = location.toLocaleLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      locations.push(location);
    }
  }
  return locations;
}

function familyPayload(userId) {
  const family = familyForUser(userId);
  if (!family) return null;
  const members = db.prepare(`
    SELECT u.* FROM users u
    JOIN family_members fm ON fm.user_id = u.id
    WHERE fm.family_id = ?
    ORDER BY u.name COLLATE NOCASE, u.id
  `).all(family.id).map(publicUser);
  return { id: String(family.id), name: family.name, members };
}

function normalizedDuplicateText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function duplicateWorkKey(row) {
  const editionTerms = "edition|hardcover|hardback|paperback|softback|mass market|limited|collector'?s?|deluxe|special|anniversary|reprint";
  const titleWithoutEdition = String(row.title || "")
    .replace(new RegExp(`\\([^)]*(?:${editionTerms})[^)]*\\)`, "gi"), " ")
    .replace(new RegExp(`\\[[^\\]]*(?:${editionTerms})[^\\]]*\\]`, "gi"), " ")
    .replace(new RegExp(`\\s*[-:]\\s*[^-:]*(?:${editionTerms})[^-:]*$`, "gi"), " ")
    .replace(/\s+(?:first|1st|second|2nd|third|3rd|limited|collector'?s?|deluxe|special|anniversary|revised)\s+edition\s*$/gi, " ")
    .replace(/\s+(?:hardcover|hardback|paperback|softback|mass market paperback|reprint)\s*$/gi, " ");
  const normalizedTitle = normalizedDuplicateText(titleWithoutEdition);
  const normalizedAuthor = normalizedDuplicateText(row.author)
    .split(" ")
    .filter(word => word && !["by", "author", "editor", "edited", "illustrated"].includes(word))
    .sort()
    .join(" ");
  return normalizedTitle && normalizedAuthor ? `${normalizedTitle}\u0000${normalizedAuthor}` : "";
}

function duplicateGroups(rows) {
  const candidates = new Map();
  for (const row of rows) {
    const key = duplicateWorkKey(row);
    if (!key) continue;
    const group = candidates.get(key) || [];
    group.push(row);
    candidates.set(key, group);
  }
  return [...candidates.entries()]
    .filter(([, copies]) => copies.length > 1)
    .map(([key, copies]) => ({
      key,
      title: copies[0].title,
      author: copies[0].author,
      copies: copies.map(publicBook),
    }))
    .sort((left, right) => right.copies.length - left.copies.length || left.title.localeCompare(right.title));
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
  if (url.pathname === "/api/settings") {
    if (req.method === "GET") return send(res, 200, { settings: settingsForUser(user.id) });
    if (req.method === "PUT") {
      const input = await jsonBody(req);
      const defaultLocation = boundedText(input.defaultLocation, 150);
      if (defaultLocation === null) return send(res, 400, { error: "Default location must be 150 characters or fewer" });
      const defaultBinding = input.defaultBinding === "" || input.defaultBinding == null ? null : input.defaultBinding;
      const defaultCondition = input.defaultCondition === "" || input.defaultCondition == null ? null : input.defaultCondition;
      if (defaultBinding !== null && !allowedBindings.has(defaultBinding)) return send(res, 400, { error: "Invalid default binding" });
      if (defaultCondition !== null && !allowedConditions.has(defaultCondition)) return send(res, 400, { error: "Invalid default condition" });
      const locations = validatedLocations(input.locations);
      if (defaultLocation && !locations.some(location => location.toLocaleLowerCase() === defaultLocation.toLocaleLowerCase())) {
        if (locations.length >= 50) return send(res, 400, { error: "Remove a saved location before adding the default location" });
        locations.unshift(defaultLocation);
      }

      const family = familyForUser(user.id);
      const current = storedUserSettings(user.id);
      const personalLocations = family ? current.locations : JSON.stringify(locations);
      db.prepare(`
        INSERT INTO user_settings (
          user_id, default_location, default_binding, default_condition, locations, updated_at
        ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET
          default_location = excluded.default_location,
          default_binding = excluded.default_binding,
          default_condition = excluded.default_condition,
          locations = excluded.locations,
          updated_at = CURRENT_TIMESTAMP
      `).run(user.id, defaultLocation || null, defaultBinding, defaultCondition, personalLocations);
      if (family) {
        db.prepare("UPDATE families SET locations = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run(JSON.stringify(locations), family.id);
      }
      audit("settings_updated", req, { userId: user.id, familyId: family?.id || null });
      return send(res, 200, { settings: settingsForUser(user.id) });
    }
  }
  if (url.pathname === "/api/family") {
    if (req.method === "GET") {
      return send(res, 200, { family: familyPayload(user.id), canManage: user.role === "admin" });
    }
    if (req.method === "PUT") {
      if (user.role !== "admin") return send(res, 403, { error: "Administrator access required" });
      const input = await jsonBody(req);
      const name = boundedText(input.name, 100, true);
      if (!name) return send(res, 400, { error: "Family name is required and must be 100 characters or fewer" });
      if (!Array.isArray(input.memberIds) || input.memberIds.length > 100) {
        return send(res, 400, { error: "Select no more than 100 family members" });
      }
      const memberIds = [...new Set([...input.memberIds, user.id].map(Number))];
      if (memberIds.some(memberId => !Number.isSafeInteger(memberId) || memberId < 1)) {
        return send(res, 400, { error: "Invalid family member" });
      }
      const placeholders = memberIds.map(() => "?").join(", ");
      const selectedUsers = db.prepare(`SELECT id FROM users WHERE id IN (${placeholders})`).all(...memberIds);
      if (selectedUsers.length !== memberIds.length) return send(res, 400, { error: "One or more selected users no longer exist" });

      const currentFamily = familyForUser(user.id);
      const memberships = db.prepare(`
        SELECT user_id, family_id FROM family_members WHERE user_id IN (${placeholders})
      `).all(...memberIds);
      const conflict = memberships.find(membership => !currentFamily || membership.family_id !== currentFamily.id);
      if (conflict) return send(res, 409, { error: "A selected user already belongs to another family" });

      let familyId = currentFamily?.id;
      try {
        db.exec("BEGIN IMMEDIATE");
        if (familyId) {
          db.prepare("UPDATE families SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(name, familyId);
        } else {
          const personalLocations = storedUserSettings(user.id).locations;
          const result = db.prepare("INSERT INTO families (name, created_by, locations) VALUES (?, ?, ?)")
            .run(name, user.id, personalLocations);
          familyId = Number(result.lastInsertRowid);
        }
        db.prepare("DELETE FROM family_members WHERE family_id = ?").run(familyId);
        const addMember = db.prepare("INSERT INTO family_members (family_id, user_id) VALUES (?, ?)");
        for (const memberId of memberIds) addMember.run(familyId, memberId);
        db.exec("COMMIT");
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch {}
        throw error;
      }
      audit("family_updated", req, { userId: user.id, familyId, memberCount: memberIds.length });
      return send(res, 200, { family: familyPayload(user.id), canManage: true });
    }
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
      hardcoverToken: process.env.HARDCOVER_API_TOKEN,
      timeoutMs: process.env.BOOK_LOOKUP_TIMEOUT_MS,
    });
    if (bookLookupCache.size >= 100) bookLookupCache.delete(bookLookupCache.keys().next().value);
    bookLookupCache.set(cacheKey, { value: result, expiresAt: Date.now() + 10 * 60 * 1000 });
    audit("book_lookup", req, { userId: user.id, type, resultCount: result.results.length });
    return send(res, 200, result);
  }
  if (req.method === "GET" && url.pathname === "/api/series-search") {
    const query = String(url.searchParams.get("q") || "").trim().slice(0, 150);
    const provider = String(url.searchParams.get("provider") || "auto");
    if (!["auto", "hardcover", "open_library"].includes(provider)) {
      return send(res, 400, { error: "Invalid series provider" });
    }
    const limitKey = `${user.id}:${clientAddress(req)}`;
    if (!consumeLimit(bookLookupAttempts, limitKey, bookLookupLimit, bookLookupWindowMs)) {
      audit("series_lookup_rate_limited", req, { userId: user.id });
      return send(res, 429, { error: "Too many book searches. Try again in a few minutes." }, { "Retry-After": "300" });
    }
    const result = await lookupSeries(query, {
      hardcoverToken: process.env.HARDCOVER_API_TOKEN,
      timeoutMs: process.env.BOOK_LOOKUP_TIMEOUT_MS,
      provider,
    });
    audit("series_lookup", req, { userId: user.id, requestedProvider: provider, provider: result.provider, resultCount: result.books.length });
    return send(res, 200, result);
  }
  if (req.method === "GET" && url.pathname === "/api/books/duplicates") {
    const rows = visibleBookRows(user.id, { ownedOnly: true });
    const groups = duplicateGroups(rows);
    return send(res, 200, {
      groups,
      totalGroups: groups.length,
      totalCopies: groups.reduce((count, group) => count + group.copies.length, 0),
      scannedBooks: rows.length,
    });
  }
  if (req.method === "GET" && url.pathname === "/api/books") {
    const query = String(url.searchParams.get("q") || "").trim().slice(0, 100);
    const rows = visibleBookRows(user.id, { query });
    return send(res, 200, { books: rows.map(publicBook) });
  }
  if (req.method === "POST" && url.pathname === "/api/books/bulk") {
    const body = await jsonBody(req, maxBulkBodyBytes);
    if (!Array.isArray(body.books) || !body.books.length || body.books.length > 100) {
      return send(res, 400, { error: "Select between 1 and 100 books to import" });
    }
    if (body.books.some(book => !["owned", "wishlist"].includes(book?.status))) {
      return send(res, 400, { error: "Imported books must be assigned to the collection or wishlist" });
    }
    const books = body.books.map(validatedBook);
    const created = [];
    const skipped = [];
    const existingRows = visibleBookRows(user.id);
    try {
      db.exec("BEGIN IMMEDIATE");
      for (const book of books) {
        const duplicate = existingRows.find(row =>
          (book.isbn && row.isbn === book.isbn)
          || (row.title.toLocaleLowerCase() === book.title.toLocaleLowerCase()
            && row.author.toLocaleLowerCase() === book.author.toLocaleLowerCase()));
        if (duplicate) {
          skipped.push({ title: book.title, reason: "Already in your library" });
          continue;
        }
        const result = insertBook(user.id, book);
        const createdRow = visibleBookById(user.id, Number(result.lastInsertRowid));
        existingRows.push(createdRow);
        created.push(publicBook(createdRow));
      }
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
    audit("book_series_imported", req, { userId: user.id, created: created.length, skipped: skipped.length });
    return send(res, 201, { books: created, skipped });
  }
  if (req.method === "POST" && url.pathname === "/api/books") {
    const book = validatedBook(await jsonBody(req));
    const result = insertBook(user.id, book);
    const created = visibleBookById(user.id, Number(result.lastInsertRowid));
    audit("book_created", req, { userId: user.id, bookId: Number(result.lastInsertRowid), source: book.source });
    return send(res, 201, { book: publicBook(created) });
  }
  const bookMatch = url.pathname.match(/^\/api\/books\/([1-9]\d*)$/);
  if (req.method === "DELETE" && bookMatch) {
    const bookId = Number(bookMatch[1]);
    if (!Number.isSafeInteger(bookId)) return send(res, 400, { error: "Invalid book ID" });
    const result = db.prepare("DELETE FROM books WHERE id = ? AND user_id = ?").run(bookId, user.id);
    if (!result.changes) return send(res, 404, { error: "Book not found" });
    audit("book_deleted", req, { userId: user.id, bookId });
    return send(res, 200, { ok: true });
  }
  if (req.method === "PUT" && bookMatch) {
    const bookId = Number(bookMatch[1]);
    if (!Number.isSafeInteger(bookId)) return send(res, 400, { error: "Invalid book ID" });
    const book = validatedBook(await jsonBody(req));
    const existing = visibleBookById(user.id, bookId);
    if (!existing) return send(res, 404, { error: "Book not found" });
    const isOwner = existing.user_id === user.id;
    if (!isOwner && book.status !== "owned") {
      return send(res, 403, { error: "Only the member who added this book can move it out of the family collection" });
    }
    const result = db.prepare(`
      UPDATE books SET
        isbn = ?, title = ?, author = ?, series = ?, series_number = ?,
        collection_name = ?, cover_url = ?, cover_options = ?, genre = ?,
        page_count = ?, published_year = ?, publisher = ?, description = ?,
        binding = ?, edition = ?, storage_location = ?, condition_grade = ?, condition_notes = ?,
        loaned_out = ?, loaned_to = ?, loaned_at = ?, source = ?, source_id = ?,
        status = ?, formats = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      book.isbn, book.title, book.author, book.series, book.seriesNumber,
      book.collection, book.coverUrl, JSON.stringify(book.coverOptions), book.genre,
      book.pageCount, book.publishedYear, book.publisher, book.description, book.binding,
      book.edition, book.storageLocation, book.conditionGrade, book.conditionNotes, book.loanedOut ? 1 : 0,
      book.loanedTo, book.loanedAt, book.source, book.sourceId, book.status,
      JSON.stringify(book.formats), bookId,
    );
    if (!result.changes) return send(res, 404, { error: "Book not found" });
    setReadStatus(bookId, user.id, book.readStatus);
    const updated = visibleBookById(user.id, bookId);
    audit("book_updated", req, { userId: user.id, bookId, ownerId: existing.user_id });
    return send(res, 200, { book: publicBook(updated) });
  }
  const bookStatusMatch = url.pathname.match(/^\/api\/books\/([1-9]\d*)\/status$/);
  if (req.method === "PATCH" && bookStatusMatch) {
    const bookId = Number(bookStatusMatch[1]);
    if (!Number.isSafeInteger(bookId)) return send(res, 400, { error: "Invalid book ID" });
    const { status } = await jsonBody(req);
    if (!["owned", "wishlist", "backlog"].includes(status)) {
      return send(res, 400, { error: "Invalid book status" });
    }
    const existing = db.prepare("SELECT * FROM books WHERE id = ? AND user_id = ?").get(bookId, user.id);
    if (!existing) return send(res, 404, { error: "Book not found" });
    const settings = storedUserSettings(user.id);
    const usePhysicalDefaults = status === "owned" && parseJsonArray(existing.formats).includes("physical");
    const result = db.prepare(`
      UPDATE books
      SET status = ?,
        binding = COALESCE(binding, ?),
        storage_location = COALESCE(storage_location, ?),
        condition_grade = COALESCE(condition_grade, ?),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?
    `).run(
      status,
      usePhysicalDefaults ? settings.default_binding : null,
      usePhysicalDefaults ? settings.default_location : null,
      usePhysicalDefaults ? settings.default_condition : null,
      bookId,
      user.id,
    );
    if (!result.changes) return send(res, 404, { error: "Book not found" });
    const updated = visibleBookById(user.id, bookId);
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
