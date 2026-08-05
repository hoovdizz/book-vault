import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, relative, isAbsolute, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { db, ensureAdmin, hashPassword, MAX_PASSWORD_BYTES, passwordError, publicUser, verifyPassword } from "./database.mjs";
import { ensureUserHousehold } from "./migrations.mjs";
import {
  assertActiveContext,
  assertHouseholdAdmin,
  householdContext,
  householdMembers,
  householdSummary,
  isSystemAdmin,
  validatedHouseholdRole,
  writeAuditEvent,
} from "./households.mjs";
import {
  assertLocationInHousehold,
  assertValidLocationParent,
  locationInventory,
  validatedLocationInput,
} from "./locations.mjs";
import {
  archiveCatalogItem,
  catalogItemDetail,
  catalogActivity,
  catalogStats,
  createCatalogItem,
  duplicateCopyGroups,
  duplicateWarnings,
  listCatalog,
  moveCopies,
  seriesInventory,
  updateCatalogItem,
} from "./catalog.mjs";
import {
  batchCheckIn,
  cancelHold,
  checkoutCopy,
  createHold,
  listHolds,
  listLoans,
  markLoan,
  renewLoan,
  returnLoan,
} from "./loans.mjs";
import {
  createReadingSession,
  householdReadingStatistics,
  readingDetail,
  readingStatistics,
  updateReadingPreferences,
  updateReadingSession,
  updateReadingState,
} from "./reading.mjs";
import { cacheExternalCover, MAX_COVER_BYTES, readCover, uploadCover } from "./covers.mjs";
import {
  configuredLookup,
  metadataQuality,
  providerSettings,
  refreshEditionMetadata,
  updateProviderSettings,
} from "./metadata.mjs";
import {
  adminStatus,
  backupPath,
  createBackup,
  integrityCheck,
  listBackups,
  previewRestore,
  runScheduledBackups,
  stageRestore,
} from "./maintenance.mjs";
import {
  commitImport,
  exportCatalogCsv,
  exportHouseholdJson,
  exportLoansCsv,
  exportUserReadingJson,
  importPresets,
  previewImport,
} from "./data-transfer.mjs";
import {
  createCollection,
  createCustomField,
  deleteCollection,
  listCollections,
  listCustomFields,
  setCustomFieldValue,
  updateCollection,
  updateUserPreferences,
  userPreferences,
} from "./organization.mjs";
import { isAllowedCoverUrl, lookupSeries, normalizeCoverUrl, normalizeIsbn } from "./book-search.mjs";
import { collectionValue, refreshEditionValue, refreshMissingValues } from "./value.mjs";

const port = Number(process.env.PORT || 8130);
const host = process.env.HOST || "0.0.0.0";
const publicDir = normalize(join(import.meta.dirname, "..", "dist"));
const sessionDays = Math.min(90, Math.max(1, Number(process.env.SESSION_DAYS || 30)));
const sessionCookie = "bookvault_session";
const maxBodyBytes = 16_384;
const maxBulkBodyBytes = 1024 * 1024;
const maxImportBodyBytes = 10 * 1024 * 1024 + 64 * 1024;
const loginWindowMs = 15 * 60 * 1000;
const loginLimit = 5;
const loginAttempts = new Map();
const bookLookupLimit = 30;
const bookLookupWindowMs = 5 * 60 * 1000;
const bookLookupAttempts = new Map();
const legacyApiEnabled = process.env.ENABLE_LEGACY_API === "true";
const trustProxy = process.env.TRUST_PROXY === "true";
const configuredPublicOrigin = (() => {
  const value = String(process.env.PUBLIC_ORIGIN || "").trim();
  if (!value) return null;
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)
    || parsed.username || parsed.password || parsed.pathname !== "/"
    || parsed.search || parsed.hash) {
    throw new Error("PUBLIC_ORIGIN must be an http(s) origin without a path, query, or credentials");
  }
  return parsed.origin;
})();
const allowedBindings = new Set(["hardcover", "paperback", "mass_market_paperback", "library_binding", "spiral_bound", "other"]);
const allowedConditions = new Set(["new", "like_new", "good", "fair", "poor", "damaged"]);
const allowedReadStatuses = new Set(["read", "unread", "reading"]);
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

async function runMetadataJob(jobId, context, jobType, editionIds) {
  db.prepare(`
    UPDATE background_jobs SET status = 'running', started_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(jobId);
  let completed = 0;
  const failures = [];
  try {
    for (const editionId of editionIds) {
      try {
        await refreshEditionMetadata(db, context, editionId, {
          googleApiKey: process.env.GOOGLE_BOOKS_API_KEY,
          hardcoverToken: process.env.HARDCOVER_API_TOKEN,
          timeoutMs: process.env.BOOK_LOOKUP_TIMEOUT_MS,
        });
        if (jobType === "cover_backfill") {
          const edition = db.prepare(`
            SELECT cover_url, cover_path FROM editions
            WHERE id = ? AND household_id = ?
          `).get(editionId, context.household_id);
          if (edition?.cover_url && !edition.cover_path) {
            await cacheExternalCover(db, context.household_id, editionId, edition.cover_url);
          }
        }
      } catch (error) {
        failures.push({ editionId: String(editionId), error: String(error?.message || error).slice(0, 300) });
      }
      completed += 1;
      db.prepare(`
        UPDATE background_jobs SET progress = ?, details = ? WHERE id = ?
      `).run(
        editionIds.length ? completed / editionIds.length : 1,
        JSON.stringify({ total: editionIds.length, completed, failures: failures.slice(-25) }),
        jobId,
      );
    }
    const failedCompletely = editionIds.length > 0 && failures.length === editionIds.length;
    db.prepare(`
      UPDATE background_jobs SET status = ?, progress = 1, error_message = ?,
        completed_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(
      failedCompletely ? "failed" : "completed",
      failures.length ? `${failures.length} of ${editionIds.length} records failed; see job details` : null,
      jobId,
    );
  } catch (error) {
    db.prepare(`
      UPDATE background_jobs SET status = 'failed', error_message = ?,
        completed_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(String(error?.message || error).slice(0, 1000), jobId);
  }
}
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
async function binaryBody(req, limit) {
  const declaredLength = Number(req.headers["content-length"] || 0);
  if (declaredLength > limit) throw Object.assign(new Error("Request too large"), { status: 413 });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Request too large"), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) throw Object.assign(new Error("Image upload is empty"), { status: 400 });
  return Buffer.concat(chunks);
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
function firstHeaderValue(value) {
  return String(Array.isArray(value) ? value[0] : value || "").split(",")[0].trim();
}
function forwardedParameters(req) {
  if (!trustProxy) return {};
  const first = firstHeaderValue(req.headers.forwarded);
  if (!first) return {};
  return Object.fromEntries(first.split(";").map(part => {
    const separator = part.indexOf("=");
    if (separator < 1) return ["", ""];
    return [
      part.slice(0, separator).trim().toLowerCase(),
      part.slice(separator + 1).trim().replace(/^"(.*)"$/, "$1"),
    ];
  }).filter(([key]) => key));
}
function externalProtocol(req) {
  if (req.socket.encrypted) return "https";
  if (!trustProxy) return "http";
  const forwarded = forwardedParameters(req);
  const value = firstHeaderValue(req.headers["x-forwarded-proto"]) || forwarded.proto || "http";
  return value.toLowerCase() === "https" ? "https" : "http";
}
function externalHost(req) {
  const forwarded = forwardedParameters(req);
  const value = trustProxy
    ? firstHeaderValue(req.headers["x-forwarded-host"]) || forwarded.host || req.headers.host
    : req.headers.host;
  const host = firstHeaderValue(value);
  if (!host || /[\s/\\]/.test(host)) return null;
  return host;
}
function externalOrigin(req) {
  const authority = externalHost(req);
  if (!authority) return null;
  try {
    return new URL(`${externalProtocol(req)}://${authority}`).origin;
  } catch {
    return null;
  }
}
function sameRequestOrigin(req, value) {
  try {
    const origin = new URL(String(value)).origin;
    return [configuredPublicOrigin, externalOrigin(req)].filter(Boolean).includes(origin);
  } catch {
    return false;
  }
}
function clientAddress(req) {
  if (trustProxy) {
    const forwarded = firstHeaderValue(req.headers["x-forwarded-for"]);
    if (forwarded) return forwarded.slice(0, 100);
  }
  return String(req.socket.remoteAddress || "unknown").slice(0, 100);
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
  const secure = externalProtocol(req) === "https" || configuredPublicOrigin?.startsWith("https://");
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

function validatedCatalogInput(input) {
  const book = validatedBook(input);
  return {
    ...input,
    ...book,
    readStatus: input.readStatus == null ? book.readStatus : String(input.readStatus),
    publicationDate: input.publicationDate,
    readingOrder: input.readingOrder,
    seriesRole: input.seriesRole,
    includedVolumes: input.includedVolumes,
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
    const valid = Boolean(user && !user.disabled && validPassword);
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
  if (req.method === "POST" && url.pathname === "/api/invitations/accept") {
    const input = await jsonBody(req);
    const invitationToken = String(input.token || "");
    const name = boundedText(input.name, 100, true);
    const password = String(input.password || "");
    const problem = passwordError(password);
    if (!/^[a-f0-9]{64}$/.test(invitationToken) || !name || problem) {
      return send(res, 400, { error: problem || "A valid invitation, name, and password are required" });
    }
    const invitation = db.prepare(`
      SELECT * FROM household_invitations
      WHERE token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL
        AND expires_at > CURRENT_TIMESTAMP
    `).get(tokenHash(invitationToken));
    if (!invitation) return send(res, 400, { error: "This invitation is invalid or has expired" });
    if (db.prepare("SELECT id FROM users WHERE email = ? COLLATE NOCASE").get(invitation.email)) {
      return send(res, 409, { error: "An account with this email already exists; ask an administrator to add that account" });
    }
    const passwordHash = await hashPassword(password);
    let userId;
    try {
      db.exec("BEGIN IMMEDIATE");
      const result = db.prepare(`
        INSERT INTO users (name, email, password_hash, role, system_role)
        VALUES (?, ?, ?, 'user', 'user')
      `).run(name, invitation.email, passwordHash);
      userId = Number(result.lastInsertRowid);
      db.prepare(`
        INSERT INTO household_members (household_id, user_id, household_role)
        VALUES (?, ?, ?)
      `).run(invitation.household_id, userId, invitation.household_role);
      db.prepare("UPDATE household_invitations SET accepted_at = CURRENT_TIMESTAMP WHERE id = ?").run(invitation.id);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
    writeAuditEvent(db, {
      householdId: invitation.household_id,
      actorUserId: userId,
      eventType: "invitation_accepted",
      targetType: "user",
      targetId: userId,
      address: clientAddress(req),
    });
    return send(res, 201, { ok: true });
  }
  const user = currentUser(req);
  if (!user) return send(res, 401, { error: "Authentication required" });
  const userHousehold = assertActiveContext(householdContext(db, user.id));
  if (!legacyApiEnabled && (
    url.pathname === "/api/settings"
    || url.pathname === "/api/family"
    || /^\/api\/books(?:\/|$)/.test(url.pathname)
  )) {
    return send(res, 410, {
      error: "This legacy endpoint is disabled. Use the normalized household, catalog, loan, and reading APIs.",
    });
  }
  const coverMatch = url.pathname.match(/^\/api\/covers\/([1-9]\d*)$/);
  if (coverMatch && req.method === "GET") {
    const cover = await readCover(db, userHousehold, Number(coverMatch[1]));
    writeHead(res, 200, {
      "Content-Type": cover.mime,
      "Content-Length": String(cover.buffer.length),
      "Cache-Control": "private, max-age=86400",
      ETag: cover.etag,
    });
    return res.end(cover.buffer);
  }
  if (coverMatch && req.method === "PUT") {
    const result = await uploadCover(
      db,
      userHousehold,
      Number(coverMatch[1]),
      await binaryBody(req, MAX_COVER_BYTES),
    );
    writeAuditEvent(db, {
      householdId: userHousehold.household_id,
      actorUserId: user.id,
      eventType: "edition_cover_uploaded",
      targetType: "edition",
      targetId: coverMatch[1],
      address: clientAddress(req),
      details: { size: result.size, mime: result.mime },
    });
    return send(res, 200, { cover: result });
  }
  if (req.method === "GET" && url.pathname === "/api/auth/me") {
    return send(res, 200, { user: publicUser(user), household: householdSummary(db, userHousehold) });
  }
  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(user.token_hash);
    audit("logout", req, { userId: user.id });
    return send(res, 200, { ok: true }, { "Set-Cookie": cookieHeader(req, "", 0) });
  }
  if (url.pathname === "/api/household") {
    if (req.method === "GET") {
      return send(res, 200, {
        household: householdSummary(db, userHousehold),
        members: householdMembers(db, userHousehold.household_id),
        permissions: {
          manageHousehold: userHousehold.system_role === "system_admin" || userHousehold.household_role === "household_admin",
          editInventory: ["system_admin"].includes(userHousehold.system_role)
            || ["household_admin", "adult"].includes(userHousehold.household_role),
          editReading: userHousehold.household_role !== "viewer",
        },
      });
    }
    if (req.method === "PUT") {
      assertHouseholdAdmin(userHousehold);
      const input = await jsonBody(req);
      const name = boundedText(input.name, 100, true);
      const defaultBinding = input.defaultBinding === "" || input.defaultBinding == null ? null : input.defaultBinding;
      const defaultCondition = input.defaultCondition === "" || input.defaultCondition == null ? null : input.defaultCondition;
      const defaultLocationId = input.defaultLocationId === "" || input.defaultLocationId == null ? null : Number(input.defaultLocationId);
      const ratingScale = ["stars5", "points10"].includes(input.ratingScale) ? input.ratingScale : "stars5";
      const allowedIncrements = ratingScale === "points10" ? [1] : [0.25, 0.5, 1];
      const ratingIncrement = Number(input.ratingIncrement);
      const backupRetention = Number(input.backupRetention ?? userHousehold.backup_retention);
      const backupSchedule = boundedText(input.backupSchedule, 100);
      if (!name || (defaultBinding && !allowedBindings.has(defaultBinding)) || (defaultCondition && !allowedConditions.has(defaultCondition))) {
        return send(res, 400, { error: "One or more household defaults are invalid" });
      }
      if (defaultLocationId !== null) {
        if (!Number.isSafeInteger(defaultLocationId)
          || !db.prepare("SELECT id FROM locations WHERE id = ? AND household_id = ?").get(defaultLocationId, userHousehold.household_id)) {
          return send(res, 400, { error: "Default location must belong to this household" });
        }
      }
      if (!allowedIncrements.includes(ratingIncrement)) return send(res, 400, { error: "Invalid rating increment for this scale" });
      if (!Number.isInteger(backupRetention) || backupRetention < 1 || backupRetention > 365 || backupSchedule === null) {
        return send(res, 400, { error: "Invalid backup retention or schedule" });
      }
      db.prepare(`
        UPDATE households SET
          name = ?, default_location_id = ?, default_binding = ?, default_condition = ?,
          rating_scale = ?, rating_increment = ?, backup_retention = ?,
          scheduled_backup = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        name,
        defaultLocationId,
        defaultBinding,
        defaultCondition,
        ratingScale,
        ratingIncrement,
        backupRetention,
        backupSchedule || null,
        userHousehold.household_id,
      );
      writeAuditEvent(db, {
        householdId: userHousehold.household_id,
        actorUserId: user.id,
        eventType: "household_settings_updated",
        targetType: "household",
        targetId: userHousehold.household_id,
        address: clientAddress(req),
      });
      return send(res, 200, { household: householdSummary(db, householdContext(db, user.id)) });
    }
  }
  if (url.pathname === "/api/household/members" && req.method === "POST") {
    assertHouseholdAdmin(userHousehold);
    const input = await jsonBody(req);
    const name = boundedText(input.name, 100, true);
    const email = String(input.email || "").trim().toLocaleLowerCase();
    const password = String(input.password || "");
    const householdRole = validatedHouseholdRole(input.householdRole);
    const problem = passwordError(password);
    if (!name || !validEmail(email) || problem || !householdRole) {
      return send(res, 400, { error: problem || "A valid name, email, password, and household role are required" });
    }
    const passwordHash = await hashPassword(password);
    try {
      let userId;
      db.exec("BEGIN IMMEDIATE");
      const result = db.prepare(`
        INSERT INTO users (name, email, password_hash, role, system_role)
        VALUES (?, ?, ?, 'user', 'user')
      `).run(name, email, passwordHash);
      userId = Number(result.lastInsertRowid);
      db.prepare(`
        INSERT INTO household_members (household_id, user_id, household_role)
        VALUES (?, ?, ?)
      `).run(userHousehold.household_id, userId, householdRole);
      db.exec("COMMIT");
      writeAuditEvent(db, {
        householdId: userHousehold.household_id,
        actorUserId: user.id,
        eventType: householdRole === "child" ? "child_profile_created" : "household_member_created",
        targetType: "user",
        targetId: userId,
        address: clientAddress(req),
        details: { householdRole },
      });
      return send(res, 201, { members: householdMembers(db, userHousehold.household_id) });
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      if (String(error).includes("UNIQUE")) return send(res, 409, { error: "That email already exists" });
      throw error;
    }
  }
  const householdMemberMatch = url.pathname.match(/^\/api\/household\/members\/([1-9]\d*)$/);
  if (householdMemberMatch && req.method === "PATCH") {
    assertHouseholdAdmin(userHousehold);
    const targetUserId = Number(householdMemberMatch[1]);
    const target = db.prepare(`
      SELECT u.system_role, hm.* FROM household_members hm
      JOIN users u ON u.id = hm.user_id
      WHERE hm.household_id = ? AND hm.user_id = ?
    `).get(userHousehold.household_id, targetUserId);
    if (!target) return send(res, 404, { error: "Household member not found" });
    const input = await jsonBody(req);
    const role = input.householdRole == null ? target.household_role : validatedHouseholdRole(input.householdRole);
    const disabled = input.disabled == null ? Boolean(target.disabled) : input.disabled === true;
    if (!role) return send(res, 400, { error: "Invalid household role" });
    if (targetUserId === user.id && (disabled || role !== "household_admin")) {
      return send(res, 400, { error: "You cannot disable or demote your own administrator account" });
    }
    if (target.system_role === "system_admin" && userHousehold.system_role !== "system_admin") {
      return send(res, 403, { error: "Only a system administrator can change another system administrator" });
    }
    if (target.household_role === "household_admin" && (role !== "household_admin" || disabled)) {
      const activeAdmins = db.prepare(`
        SELECT COUNT(*) AS count FROM household_members
        WHERE household_id = ? AND household_role = 'household_admin' AND disabled = 0
      `).get(userHousehold.household_id).count;
      if (activeAdmins <= 1) return send(res, 400, { error: "A household must retain at least one active administrator" });
    }
    db.prepare(`
      UPDATE household_members SET household_role = ?, disabled = ?
      WHERE household_id = ? AND user_id = ?
    `).run(role, disabled ? 1 : 0, userHousehold.household_id, targetUserId);
    if (disabled) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(targetUserId);
    writeAuditEvent(db, {
      householdId: userHousehold.household_id,
      actorUserId: user.id,
      eventType: disabled ? "household_member_disabled" : "household_member_updated",
      targetType: "user",
      targetId: targetUserId,
      address: clientAddress(req),
      details: { householdRole: role, disabled },
    });
    return send(res, 200, { members: householdMembers(db, userHousehold.household_id) });
  }
  const memberPasswordMatch = url.pathname.match(/^\/api\/household\/members\/([1-9]\d*)\/password$/);
  if (memberPasswordMatch && req.method === "PUT") {
    assertHouseholdAdmin(userHousehold);
    const targetUserId = Number(memberPasswordMatch[1]);
    if (!db.prepare(`
      SELECT 1 FROM household_members WHERE household_id = ? AND user_id = ?
    `).get(userHousehold.household_id, targetUserId)) {
      return send(res, 404, { error: "Household member not found" });
    }
    const { password } = await jsonBody(req);
    const problem = passwordError(password);
    if (problem) return send(res, 400, { error: problem });
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await hashPassword(password), targetUserId);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(targetUserId);
    writeAuditEvent(db, {
      householdId: userHousehold.household_id,
      actorUserId: user.id,
      eventType: "household_member_credentials_reset",
      targetType: "user",
      targetId: targetUserId,
      address: clientAddress(req),
    });
    return send(res, 200, { ok: true });
  }
  if (url.pathname === "/api/household/invitations") {
    assertHouseholdAdmin(userHousehold);
    if (req.method === "GET") {
      const invitations = db.prepare(`
        SELECT id, email, household_role, expires_at, accepted_at, revoked_at, created_at
        FROM household_invitations
        WHERE household_id = ?
        ORDER BY created_at DESC
      `).all(userHousehold.household_id).map(invitation => ({
        id: String(invitation.id),
        email: invitation.email,
        householdRole: invitation.household_role,
        expiresAt: invitation.expires_at,
        acceptedAt: invitation.accepted_at || null,
        revokedAt: invitation.revoked_at || null,
        createdAt: invitation.created_at,
      }));
      return send(res, 200, { invitations });
    }
    if (req.method === "POST") {
      const input = await jsonBody(req);
      const email = String(input.email || "").trim().toLocaleLowerCase();
      const householdRole = validatedHouseholdRole(input.householdRole);
      const expiresInDays = Math.min(30, Math.max(1, Number(input.expiresInDays || 7)));
      if (!validEmail(email) || !householdRole || !Number.isInteger(expiresInDays)) {
        return send(res, 400, { error: "A valid email, role, and expiration are required" });
      }
      if (db.prepare("SELECT id FROM users WHERE email = ? COLLATE NOCASE").get(email)) {
        return send(res, 409, { error: "That email already has an account" });
      }
      const invitationToken = randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + expiresInDays * 86400000).toISOString();
      const result = db.prepare(`
        INSERT INTO household_invitations (
          household_id, email, household_role, token_hash, invited_by, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        userHousehold.household_id,
        email,
        householdRole,
        tokenHash(invitationToken),
        user.id,
        expiresAt,
      );
      writeAuditEvent(db, {
        householdId: userHousehold.household_id,
        actorUserId: user.id,
        eventType: "household_invitation_created",
        targetType: "invitation",
        targetId: Number(result.lastInsertRowid),
        address: clientAddress(req),
        details: { email, householdRole, expiresAt },
      });
      return send(res, 201, {
        invitation: {
          id: String(result.lastInsertRowid),
          email,
          householdRole,
          expiresAt,
          token: invitationToken,
        },
      });
    }
  }
  const invitationMatch = url.pathname.match(/^\/api\/household\/invitations\/([1-9]\d*)$/);
  if (invitationMatch && req.method === "DELETE") {
    assertHouseholdAdmin(userHousehold);
    const result = db.prepare(`
      UPDATE household_invitations SET revoked_at = CURRENT_TIMESTAMP
      WHERE id = ? AND household_id = ? AND accepted_at IS NULL
    `).run(Number(invitationMatch[1]), userHousehold.household_id);
    if (!result.changes) return send(res, 404, { error: "Active invitation not found" });
    writeAuditEvent(db, {
      householdId: userHousehold.household_id,
      actorUserId: user.id,
      eventType: "household_invitation_revoked",
      targetType: "invitation",
      targetId: invitationMatch[1],
      address: clientAddress(req),
    });
    return send(res, 200, { ok: true });
  }
  if (url.pathname === "/api/household/reading-statuses") {
    if (req.method === "GET") {
      const statuses = db.prepare(`
        SELECT status_key, label, sort_order, enabled
        FROM household_reading_statuses
        WHERE household_id = ?
        ORDER BY sort_order, status_key
      `).all(userHousehold.household_id).map(status => ({
        key: status.status_key,
        label: status.label,
        sortOrder: status.sort_order,
        enabled: Boolean(status.enabled),
      }));
      return send(res, 200, { statuses });
    }
    if (req.method === "PUT") {
      assertHouseholdAdmin(userHousehold);
      const { statuses } = await jsonBody(req);
      if (!Array.isArray(statuses) || !statuses.length || statuses.length > 30) {
        return send(res, 400, { error: "Provide between 1 and 30 reading statuses" });
      }
      const normalized = statuses.map((status, index) => ({
        key: String(status.key || "").trim().toLocaleLowerCase(),
        label: boundedText(status.label, 50, true),
        enabled: status.enabled !== false,
        sortOrder: Number.isInteger(status.sortOrder) ? status.sortOrder : index,
      }));
      if (normalized.some(status => !/^[a-z][a-z0-9_]{0,39}$/.test(status.key) || !status.label)
        || new Set(normalized.map(status => status.key)).size !== normalized.length
        || !normalized.some(status => status.key === "unread" && status.enabled)
        || !normalized.some(status => status.key === "read" && status.enabled)) {
        return send(res, 400, { error: "Reading statuses need unique keys and enabled Unread and Read choices" });
      }
      try {
        db.exec("BEGIN IMMEDIATE");
        db.prepare("UPDATE household_reading_statuses SET enabled = 0 WHERE household_id = ?").run(userHousehold.household_id);
        const upsert = db.prepare(`
          INSERT INTO household_reading_statuses (
            household_id, status_key, label, sort_order, enabled
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(household_id, status_key) DO UPDATE SET
            label = excluded.label,
            sort_order = excluded.sort_order,
            enabled = excluded.enabled
        `);
        for (const status of normalized) {
          upsert.run(userHousehold.household_id, status.key, status.label, status.sortOrder, status.enabled ? 1 : 0);
        }
        db.exec("COMMIT");
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch {}
        throw error;
      }
      writeAuditEvent(db, {
        householdId: userHousehold.household_id,
        actorUserId: user.id,
        eventType: "reading_statuses_updated",
        targetType: "household",
        targetId: userHousehold.household_id,
        address: clientAddress(req),
        details: { statusCount: normalized.length },
      });
      return send(res, 200, { ok: true });
    }
  }
  if (url.pathname === "/api/metadata/providers") {
    if (req.method === "GET") return send(res, 200, providerSettings(db, userHousehold.household_id));
    if (req.method === "PUT") {
      const providers = updateProviderSettings(db, userHousehold, await jsonBody(req));
      writeAuditEvent(db, {
        householdId: userHousehold.household_id,
        actorUserId: user.id,
        eventType: "metadata_providers_updated",
        targetType: "household",
        targetId: userHousehold.household_id,
        address: clientAddress(req),
        details: { order: providers.lookupOrder },
      });
      return send(res, 200, providers);
    }
  }
  if (url.pathname === "/api/metadata/quality" && req.method === "GET") {
    return send(res, 200, metadataQuality(db, userHousehold));
  }
  const metadataRefreshMatch = url.pathname.match(/^\/api\/metadata\/editions\/([1-9]\d*)\/refresh$/);
  if (metadataRefreshMatch && req.method === "POST") {
    const result = await refreshEditionMetadata(
      db,
      userHousehold,
      Number(metadataRefreshMatch[1]),
      {
        googleApiKey: process.env.GOOGLE_BOOKS_API_KEY,
        hardcoverToken: process.env.HARDCOVER_API_TOKEN,
        timeoutMs: process.env.BOOK_LOOKUP_TIMEOUT_MS,
      },
    );
    let coverCache = null;
    if (result.coverUrl) {
      try {
        coverCache = await cacheExternalCover(
          db,
          userHousehold.household_id,
          Number(metadataRefreshMatch[1]),
          result.coverUrl,
        );
      } catch (error) {
        coverCache = { status: "failed", error: error.message || "Cover caching failed" };
      }
    }
    writeAuditEvent(db, {
      householdId: userHousehold.household_id,
      actorUserId: user.id,
      eventType: "edition_metadata_refreshed",
      targetType: "edition",
      targetId: metadataRefreshMatch[1],
      address: clientAddress(req),
      details: { changedFields: result.changedFields || [], coverCached: Boolean(coverCache?.url) },
    });
    return send(res, 200, { ...result, coverCache });
  }
  if (url.pathname === "/api/metadata/jobs" && req.method === "POST") {
    assertHouseholdAdmin(userHousehold);
    const input = await jsonBody(req);
    const jobType = ["metadata_refresh", "cover_backfill"].includes(input.jobType) ? input.jobType : null;
    const limit = Math.min(1000, Math.max(1, Number(input.limit || 100)));
    if (!jobType || !Number.isInteger(limit)) return send(res, 400, { error: "Invalid metadata job" });
    const editionIds = db.prepare(`
      SELECT edition.id
      FROM editions edition JOIN works work ON work.id = edition.work_id
      WHERE edition.household_id = ? AND edition.archived_at IS NULL
        AND (
          ? = 'metadata_refresh'
          OR (? = 'cover_backfill' AND edition.cover_path IS NULL)
        )
        AND (
          (edition.isbn10 IS NULL AND edition.isbn13 IS NULL)
          OR edition.publisher IS NULL OR edition.publication_date IS NULL
          OR edition.page_count IS NULL OR edition.cover_url IS NULL
          OR work.primary_author = ''
        )
      ORDER BY COALESCE(edition.last_refresh_at, '0000-00-00'), edition.id
      LIMIT ?
    `).all(userHousehold.household_id, jobType, jobType, limit).map(row => Number(row.id));
    const result = db.prepare(`
      INSERT INTO background_jobs (household_id, job_type, status, details)
      VALUES (?, ?, 'queued', ?)
    `).run(
      userHousehold.household_id,
      jobType,
      JSON.stringify({ total: editionIds.length, completed: 0, failures: [] }),
    );
    const jobId = Number(result.lastInsertRowid);
    const jobContext = { ...userHousehold };
    setImmediate(() => void runMetadataJob(jobId, jobContext, jobType, editionIds));
    writeAuditEvent(db, {
      householdId: userHousehold.household_id,
      actorUserId: user.id,
      eventType: "metadata_job_queued",
      targetType: "background_job",
      targetId: jobId,
      address: clientAddress(req),
      details: { jobType, recordCount: editionIds.length },
    });
    return send(res, 202, { job: { id: String(jobId), type: jobType, records: editionIds.length } });
  }
  if (url.pathname === "/api/admin/status" && req.method === "GET") {
    return send(res, 200, await adminStatus(db, userHousehold));
  }
  if (url.pathname === "/api/admin/households" && req.method === "GET") {
    if (!isSystemAdmin(userHousehold)) return send(res, 403, { error: "System administrator access required" });
    const households = db.prepare(`
      SELECT household.id, household.name, household.created_at,
        (SELECT COUNT(*) FROM household_members member
          WHERE member.household_id = household.id AND member.disabled = 0) AS members,
        (SELECT COUNT(*) FROM works work
          WHERE work.household_id = household.id AND work.archived_at IS NULL) AS works,
        (SELECT COUNT(*) FROM copies copy
          WHERE copy.household_id = household.id AND copy.archived_at IS NULL) AS copies
      FROM households household ORDER BY household.name COLLATE NOCASE
    `).all().map(household => ({
      id: String(household.id),
      name: household.name,
      members: household.members,
      works: household.works,
      copies: household.copies,
      createdAt: household.created_at,
    }));
    return send(res, 200, { households });
  }
  if (url.pathname === "/api/admin/integrity" && req.method === "POST") {
    assertHouseholdAdmin(userHousehold);
    const result = await integrityCheck(db);
    writeAuditEvent(db, {
      householdId: userHousehold.household_id,
      actorUserId: user.id,
      eventType: "database_integrity_checked",
      targetType: "database",
      address: clientAddress(req),
      details: { status: result.status },
    });
    return send(res, result.status === "ok" ? 200 : 500, result);
  }
  if (url.pathname === "/api/admin/backups") {
    if (req.method === "GET") return send(res, 200, listBackups(db, userHousehold));
    if (req.method === "POST") {
      const backup = await createBackup(db, userHousehold, user.id, "manual");
      writeAuditEvent(db, {
        householdId: userHousehold.household_id,
        actorUserId: user.id,
        eventType: "backup_created",
        targetType: "backup",
        targetId: backup.id,
        address: clientAddress(req),
        details: { size: backup.size, integrity: backup.integrity },
      });
      return send(res, 201, { backup });
    }
  }
  const backupDownloadMatch = url.pathname.match(/^\/api\/admin\/backups\/([1-9]\d*)\/download$/);
  if (backupDownloadMatch && req.method === "GET") {
    const backup = backupPath(db, userHousehold, Number(backupDownloadMatch[1]));
    writeHead(res, 200, {
      "Content-Type": "application/x-tar",
      "Content-Length": String(backup.size),
      "Content-Disposition": `attachment; filename="${backup.filename.replaceAll('"', "")}"`,
      "Cache-Control": "no-store",
    });
    return createReadStream(backup.path).pipe(res);
  }
  const backupPreviewMatch = url.pathname.match(/^\/api\/admin\/backups\/([1-9]\d*)\/restore-preview$/);
  if (backupPreviewMatch && req.method === "POST") {
    return send(res, 200, {
      preview: await previewRestore(db, userHousehold, Number(backupPreviewMatch[1])),
    });
  }
  const backupRestoreMatch = url.pathname.match(/^\/api\/admin\/backups\/([1-9]\d*)\/restore$/);
  if (backupRestoreMatch && req.method === "POST") {
    const input = await jsonBody(req);
    const restore = await stageRestore(
      db,
      userHousehold,
      user.id,
      Number(backupRestoreMatch[1]),
      input.confirmation,
    );
    writeAuditEvent(db, {
      householdId: userHousehold.household_id,
      actorUserId: user.id,
      eventType: "backup_restore_staged",
      targetType: "backup",
      targetId: backupRestoreMatch[1],
      address: clientAddress(req),
      details: { restartRequired: true },
    });
    return send(res, 202, { restore });
  }
  if (url.pathname === "/api/exports/catalog.csv" && req.method === "GET") {
    const content = exportCatalogCsv(db, userHousehold);
    writeHead(res, 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": "attachment; filename=\"book-vault-catalog.csv\"",
      "Cache-Control": "no-store",
    });
    return res.end(`\uFEFF${content}`);
  }
  if (url.pathname === "/api/exports/loans.csv" && req.method === "GET") {
    const content = exportLoansCsv(db, userHousehold);
    writeHead(res, 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": "attachment; filename=\"book-vault-loans.csv\"",
      "Cache-Control": "no-store",
    });
    return res.end(`\uFEFF${content}`);
  }
  if (url.pathname === "/api/exports/household.json" && req.method === "GET") {
    const content = JSON.stringify(exportHouseholdJson(db, userHousehold, user.id), null, 2);
    writeHead(res, 200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": "attachment; filename=\"book-vault-household.json\"",
      "Cache-Control": "no-store",
    });
    return res.end(content);
  }
  if (url.pathname === "/api/exports/reading.json" && req.method === "GET") {
    const content = JSON.stringify(exportUserReadingJson(db, userHousehold, user.id), null, 2);
    writeHead(res, 200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": "attachment; filename=\"book-vault-reading.json\"",
      "Cache-Control": "no-store",
    });
    return res.end(content);
  }
  if (url.pathname === "/api/imports/presets" && req.method === "GET") {
    return send(res, 200, importPresets());
  }
  if (url.pathname === "/api/imports/preview" && req.method === "POST") {
    const preview = await previewImport(
      db,
      userHousehold,
      user.id,
      await jsonBody(req, maxImportBodyBytes),
    );
    writeAuditEvent(db, {
      householdId: userHousehold.household_id,
      actorUserId: user.id,
      eventType: "import_dry_run",
      targetType: "import",
      targetId: preview.runId,
      address: clientAddress(req),
      details: { preset: preview.preset, rowCount: preview.rowCount, unknownColumns: preview.unknownHeaders.length },
    });
    return send(res, 201, { preview });
  }
  const importCommitMatch = url.pathname.match(/^\/api\/imports\/([1-9]\d*)\/commit$/);
  if (importCommitMatch && req.method === "POST") {
    const result = await commitImport(
      db,
      userHousehold,
      user.id,
      Number(importCommitMatch[1]),
      await jsonBody(req),
    );
    writeAuditEvent(db, {
      householdId: userHousehold.household_id,
      actorUserId: user.id,
      eventType: "import_completed",
      targetType: "import",
      targetId: result.runId,
      address: clientAddress(req),
      details: { imported: result.imported, skipped: result.skipped },
    });
    return send(res, 200, { import: result });
  }
  if (url.pathname === "/api/preferences") {
    if (req.method === "GET") return send(res, 200, { preferences: userPreferences(db, user.id) });
    if (req.method === "PUT") {
      return send(res, 200, {
        preferences: updateUserPreferences(db, userHousehold, user.id, await jsonBody(req)),
      });
    }
  }
  if (url.pathname === "/api/collections") {
    if (req.method === "GET") return send(res, 200, listCollections(db, userHousehold, user.id));
    if (req.method === "POST") {
      const collection = createCollection(db, userHousehold, user.id, await jsonBody(req));
      return send(res, 201, { collection });
    }
  }
  const collectionMatch = url.pathname.match(/^\/api\/collections\/([1-9]\d*)$/);
  if (collectionMatch && req.method === "PUT") {
    return send(res, 200, updateCollection(
      db,
      userHousehold,
      user.id,
      Number(collectionMatch[1]),
      await jsonBody(req, maxBulkBodyBytes),
    ));
  }
  if (collectionMatch && req.method === "DELETE") {
    return send(res, 200, deleteCollection(
      db,
      userHousehold,
      user.id,
      Number(collectionMatch[1]),
    ));
  }
  if (url.pathname === "/api/custom-fields") {
    if (req.method === "GET") return send(res, 200, listCustomFields(db, userHousehold));
    if (req.method === "POST") {
      return send(res, 201, { field: createCustomField(db, userHousehold, await jsonBody(req)) });
    }
  }
  const customFieldValueMatch = url.pathname.match(
    /^\/api\/custom-fields\/([1-9]\d*)\/(work|edition|copy)\/([1-9]\d*)$/,
  );
  if (customFieldValueMatch && req.method === "PUT") {
    return send(res, 200, setCustomFieldValue(
      db,
      userHousehold,
      Number(customFieldValueMatch[1]),
      customFieldValueMatch[2],
      Number(customFieldValueMatch[3]),
      await jsonBody(req),
    ));
  }
  if (url.pathname === "/api/locations") {
    if (req.method === "GET") {
      const includeArchived = url.searchParams.get("archived") !== "false";
      return send(res, 200, locationInventory(db, userHousehold.household_id, { includeArchived }));
    }
    if (req.method === "POST") {
      assertHouseholdAdmin(userHousehold);
      const location = validatedLocationInput(await jsonBody(req));
      assertValidLocationParent(db, userHousehold.household_id, null, location.parentId);
      const result = db.prepare(`
        INSERT INTO locations (
          household_id, parent_id, name, level_type, sort_order, created_by
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        userHousehold.household_id,
        location.parentId,
        location.name,
        location.levelType,
        location.sortOrder,
        user.id,
      );
      writeAuditEvent(db, {
        householdId: userHousehold.household_id,
        actorUserId: user.id,
        eventType: "location_created",
        targetType: "location",
        targetId: Number(result.lastInsertRowid),
        address: clientAddress(req),
        details: { name: location.name, levelType: location.levelType, parentId: location.parentId },
      });
      return send(res, 201, {
        id: String(result.lastInsertRowid),
        ...locationInventory(db, userHousehold.household_id),
      });
    }
  }
  const locationMatch = url.pathname.match(/^\/api\/locations\/([1-9]\d*)$/);
  if (locationMatch && req.method === "PATCH") {
    assertHouseholdAdmin(userHousehold);
    const locationId = Number(locationMatch[1]);
    const existing = assertLocationInHousehold(db, userHousehold.household_id, locationId);
    const input = await jsonBody(req);
    const location = validatedLocationInput({
      name: input.name ?? existing.name,
      levelType: input.levelType ?? existing.level_type,
      parentId: input.parentId === undefined ? existing.parent_id : input.parentId,
      sortOrder: input.sortOrder ?? existing.sort_order,
    });
    assertValidLocationParent(db, userHousehold.household_id, locationId, location.parentId);
    const archived = input.archived === undefined ? Boolean(existing.archived_at) : input.archived === true;
    db.prepare(`
      UPDATE locations SET parent_id = ?, name = ?, level_type = ?, sort_order = ?,
        archived_at = CASE
          WHEN ? = 1 AND archived_at IS NULL THEN CURRENT_TIMESTAMP
          WHEN ? = 0 THEN NULL
          ELSE archived_at
        END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND household_id = ?
    `).run(
      location.parentId,
      location.name,
      location.levelType,
      location.sortOrder,
      archived ? 1 : 0,
      archived ? 1 : 0,
      locationId,
      userHousehold.household_id,
    );
    writeAuditEvent(db, {
      householdId: userHousehold.household_id,
      actorUserId: user.id,
      eventType: archived ? "location_archived" : "location_updated",
      targetType: "location",
      targetId: locationId,
      address: clientAddress(req),
      details: { name: location.name, parentId: location.parentId, archived },
    });
    return send(res, 200, locationInventory(db, userHousehold.household_id));
  }
  const locationLabelMatch = url.pathname.match(/^\/api\/locations\/([1-9]\d*)\/label$/);
  if (locationLabelMatch && req.method === "GET") {
    const locationId = Number(locationLabelMatch[1]);
    assertLocationInHousehold(db, userHousehold.household_id, locationId);
    const inventory = locationInventory(db, userHousehold.household_id);
    const location = inventory.locations.find(candidate => candidate.id === String(locationId));
    return send(res, 200, {
      label: {
        title: location.name,
        breadcrumb: location.breadcrumb,
        qrValue: location.qrValue,
        copyCount: location.copyCount,
      },
    });
  }
  if (url.pathname === "/api/loans") {
    if (req.method === "GET") {
      return send(res, 200, listLoans(db, userHousehold, {
        history: url.searchParams.get("history") === "true",
        overdue: url.searchParams.get("overdue") === "true",
      }));
    }
    if (req.method === "POST") {
      const loan = checkoutCopy(db, userHousehold, user.id, await jsonBody(req));
      writeAuditEvent(db, {
        householdId: userHousehold.household_id,
        actorUserId: user.id,
        eventType: "copy_checked_out",
        targetType: "loan",
        targetId: loan.id,
        address: clientAddress(req),
        details: { copyId: loan.copyId, borrowerType: loan.borrower.type, dueAt: loan.dueAt },
      });
      return send(res, 201, { loan });
    }
  }
  if (url.pathname === "/api/loans/batch-check-in" && req.method === "POST") {
    const input = await jsonBody(req, maxBulkBodyBytes);
    const result = batchCheckIn(db, userHousehold, user.id, input.barcodes);
    writeAuditEvent(db, {
      householdId: userHousehold.household_id,
      actorUserId: user.id,
      eventType: "loan_batch_check_in",
      targetType: "loan",
      address: clientAddress(req),
      details: {
        scans: result.results.length,
        returned: result.results.filter(item => item.state === "success").length,
      },
    });
    return send(res, 207, result);
  }
  const loanActionMatch = url.pathname.match(/^\/api\/loans\/([1-9]\d*)\/(return|renew|status)$/);
  if (loanActionMatch && req.method === "POST") {
    const input = await jsonBody(req);
    const action = loanActionMatch[2];
    const loan = action === "return"
      ? returnLoan(db, userHousehold, user.id, Number(loanActionMatch[1]), input)
      : action === "renew"
        ? renewLoan(db, userHousehold, user.id, Number(loanActionMatch[1]), input)
        : markLoan(db, userHousehold, user.id, Number(loanActionMatch[1]), input.status, input.notes);
    writeAuditEvent(db, {
      householdId: userHousehold.household_id,
      actorUserId: user.id,
      eventType: `loan_${action}`,
      targetType: "loan",
      targetId: loan.id,
      address: clientAddress(req),
      details: { status: loan.status, dueAt: loan.dueAt },
    });
    return send(res, 200, { loan });
  }
  if (url.pathname === "/api/holds") {
    if (req.method === "GET") return send(res, 200, listHolds(db, userHousehold));
    if (req.method === "POST") {
      const input = await jsonBody(req);
      const hold = createHold(db, userHousehold, user.id, input.workId);
      return send(res, 201, { hold });
    }
  }
  const holdMatch = url.pathname.match(/^\/api\/holds\/([1-9]\d*)$/);
  if (holdMatch && req.method === "DELETE") {
    return send(res, 200, cancelHold(db, userHousehold, user.id, Number(holdMatch[1])));
  }
  const readingWorkMatch = url.pathname.match(/^\/api\/reading\/works\/([1-9]\d*)$/);
  if (readingWorkMatch) {
    if (req.method === "GET") {
      const requestedUserId = url.searchParams.get("userId") || user.id;
      return send(res, 200, readingDetail(
        db,
        userHousehold,
        user.id,
        Number(readingWorkMatch[1]),
        requestedUserId,
      ));
    }
    if (req.method === "PUT") {
      const state = updateReadingState(
        db,
        userHousehold,
        user.id,
        Number(readingWorkMatch[1]),
        await jsonBody(req),
      );
      return send(res, 200, { state });
    }
  }
  const readingSessionCreateMatch = url.pathname.match(/^\/api\/reading\/works\/([1-9]\d*)\/sessions$/);
  if (readingSessionCreateMatch && req.method === "POST") {
    const session = createReadingSession(
      db,
      userHousehold,
      user.id,
      Number(readingSessionCreateMatch[1]),
      await jsonBody(req),
    );
    return send(res, 201, { session });
  }
  const readingSessionMatch = url.pathname.match(/^\/api\/reading\/sessions\/([1-9]\d*)$/);
  if (readingSessionMatch && req.method === "PATCH") {
    const session = updateReadingSession(
      db,
      userHousehold,
      user.id,
      Number(readingSessionMatch[1]),
      await jsonBody(req),
    );
    return send(res, 200, { session });
  }
  if (url.pathname === "/api/reading/preferences" && req.method === "PUT") {
    return send(res, 200, updateReadingPreferences(db, userHousehold, user.id, await jsonBody(req)));
  }
  if (url.pathname === "/api/reading/statistics" && req.method === "GET") {
    return send(res, 200, readingStatistics(db, userHousehold, user.id));
  }
  if (url.pathname === "/api/household/statistics" && req.method === "GET") {
    return send(res, 200, householdReadingStatistics(db, userHousehold));
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
    const result = await configuredLookup(db, userHousehold, query, type, {
      googleApiKey: process.env.GOOGLE_BOOKS_API_KEY,
      hardcoverToken: process.env.HARDCOVER_API_TOKEN,
      timeoutMs: process.env.BOOK_LOOKUP_TIMEOUT_MS,
    });
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
  if (req.method === "GET" && url.pathname === "/api/catalog") {
    return send(res, 200, listCatalog(db, userHousehold, user.id, {
      page: url.searchParams.get("page"),
      pageSize: url.searchParams.get("pageSize"),
      search: url.searchParams.get("q"),
      status: url.searchParams.get("status"),
      format: url.searchParams.get("format"),
      readStatus: url.searchParams.get("readStatus"),
      ownership: url.searchParams.get("ownership"),
      owner: url.searchParams.get("owner"),
      locationId: url.searchParams.get("locationId"),
      sort: url.searchParams.get("sort"),
      direction: url.searchParams.get("direction"),
    }));
  }
  if (req.method === "GET" && url.pathname === "/api/catalog/value") {
    return send(res, 200, { value: collectionValue(db, userHousehold.household_id) });
  }
  if (req.method === "POST" && url.pathname === "/api/catalog/value") {
    const input = await jsonBody(req);
    if (!Number.isSafeInteger(Number(input.editionId))) return send(res, 400, { error: "A valid edition is required" });
    const result = await refreshEditionValue(db, userHousehold, Number(input.editionId), {
      googleApiKey: process.env.GOOGLE_BOOKS_API_KEY,
      hardcoverToken: process.env.HARDCOVER_API_TOKEN,
      timeoutMs: process.env.BOOK_LOOKUP_TIMEOUT_MS,
    });
    audit("edition_value_refreshed", req, { userId: user.id, editionId: input.editionId, source: result.source });
    return send(res, 200, { estimate: result, value: collectionValue(db, userHousehold.household_id) });
  }
  if (req.method === "POST" && url.pathname === "/api/catalog/value/refresh") {
    const limitKey = `${user.id}:${clientAddress(req)}`;
    if (!consumeLimit(bookLookupAttempts, limitKey, 5, bookLookupWindowMs)) {
      return send(res, 429, { error: "Too many value refreshes. Try again in a few minutes." }, { "Retry-After": "300" });
    }
    const input = await jsonBody(req);
    const result = await refreshMissingValues(db, userHousehold, {
      limit: input.limit,
      googleApiKey: process.env.GOOGLE_BOOKS_API_KEY,
      hardcoverToken: process.env.HARDCOVER_API_TOKEN,
      timeoutMs: process.env.BOOK_LOOKUP_TIMEOUT_MS,
    });
    audit("collection_values_refreshed", req, { userId: user.id, refreshed: result.refreshed.length });
    return send(res, 200, result);
  }
  if (req.method === "GET" && url.pathname === "/api/catalog/stats") {
    return send(res, 200, { stats: catalogStats(db, userHousehold.household_id) });
  }
  if (req.method === "GET" && url.pathname === "/api/catalog/activity") {
    return send(res, 200, catalogActivity(db, userHousehold, user.id));
  }
  if (req.method === "GET" && url.pathname === "/api/catalog/duplicate-groups") {
    return send(res, 200, duplicateCopyGroups(db, userHousehold));
  }
  if (req.method === "GET" && url.pathname === "/api/catalog/series") {
    return send(res, 200, seriesInventory(db, userHousehold));
  }
  if (req.method === "POST" && url.pathname === "/api/catalog/duplicates") {
    const input = await jsonBody(req);
    return send(res, 200, duplicateWarnings(db, userHousehold, input, user.id));
  }
  if (req.method === "POST" && url.pathname === "/api/catalog/copies/move") {
    const input = await jsonBody(req, maxBulkBodyBytes);
    if (!Array.isArray(input.copyIds)) return send(res, 400, { error: "Select copies to move" });
    const result = moveCopies(db, userHousehold, user.id, input.copyIds, input.locationId);
    writeAuditEvent(db, {
      householdId: userHousehold.household_id,
      actorUserId: user.id,
      eventType: "copies_bulk_moved",
      targetType: "location",
      targetId: result.locationId,
      address: clientAddress(req),
      details: { copyCount: result.moved },
    });
    return send(res, 200, result);
  }
  if (req.method === "POST" && url.pathname === "/api/catalog/batch") {
    const input = await jsonBody(req, maxBulkBodyBytes);
    if (!Array.isArray(input.entries) || !input.entries.length || input.entries.length > 100) {
      return send(res, 400, { error: "The scan queue must contain between 1 and 100 entries" });
    }
    const reviewOnly = input.mode !== "save";
    const results = [];
    for (let index = 0; index < input.entries.length; index += 1) {
      const rawEntry = input.entries[index] || {};
      try {
        const entry = validatedCatalogInput(rawEntry);
        const duplicates = duplicateWarnings(db, userHousehold, entry, user.id).warnings;
        if (reviewOnly) {
          results.push({
            index,
            state: duplicates.length ? "duplicate" : "success",
            entry,
            duplicates,
            actions: duplicates.length
              ? ["view_existing", "add_another_copy", "add_different_edition", "move_wishlist_to_owned", "cancel"]
              : ["save", "edit", "cancel"],
          });
          continue;
        }
        if (rawEntry.duplicateAction === "cancel") {
          results.push({ index, state: "warning", skipped: true, reason: "Cancelled during duplicate review", duplicates });
          continue;
        }
        const created = createCatalogItem(db, userHousehold, user.id, {
          ...entry,
          forceNewEdition: rawEntry.duplicateAction === "add_different_edition",
          moveWishlistToOwned: rawEntry.duplicateAction === "move_wishlist_to_owned",
        });
        let coverCache = null;
        if (entry.coverUrl) {
          try {
            coverCache = await cacheExternalCover(
              db,
              userHousehold.household_id,
              created.editionId,
              entry.coverUrl,
            );
          } catch (error) {
            coverCache = { status: "failed", error: error.message || "Cover caching failed" };
          }
        }
        results.push({ index, state: "success", created, duplicates, coverCache });
      } catch (error) {
        results.push({ index, state: "failure", error: error.message || "Unable to save this scan" });
      }
    }
    writeAuditEvent(db, {
      householdId: userHousehold.household_id,
      actorUserId: user.id,
      eventType: reviewOnly ? "scan_queue_reviewed" : "scan_queue_saved",
      targetType: "catalog",
      address: clientAddress(req),
      details: {
        total: results.length,
        successes: results.filter(result => result.state === "success").length,
        failures: results.filter(result => result.state === "failure").length,
      },
    });
    return send(res, reviewOnly ? 200 : 207, { mode: reviewOnly ? "review" : "save", results });
  }
  if (req.method === "POST" && url.pathname === "/api/catalog") {
    const input = validatedCatalogInput(await jsonBody(req, maxBulkBodyBytes));
    const duplicates = duplicateWarnings(db, userHousehold, input, user.id).warnings;
    const result = createCatalogItem(db, userHousehold, user.id, input);
    let coverCache = input.coverUrl ? { status: "pending" } : { status: "not_requested" };
    if (input.coverUrl) {
      try {
        const cover = await cacheExternalCover(
          db,
          userHousehold.household_id,
          result.editionId,
          input.coverUrl,
        );
        coverCache = { status: "cached", ...cover };
      } catch (error) {
        coverCache = { status: "failed", error: error.message || "Cover caching failed" };
      }
    }
    writeAuditEvent(db, {
      householdId: userHousehold.household_id,
      actorUserId: user.id,
      eventType: input.status === "owned" ? "catalog_copy_created" : "catalog_list_entry_created",
      targetType: "work",
      targetId: result.workId,
      address: clientAddress(req),
      details: { source: input.source, createdCount: result.created.length, duplicateWarnings: duplicates.length },
    });
    return send(res, 201, { ...result, duplicates, coverCache });
  }
  const catalogMatch = url.pathname.match(/^\/api\/catalog\/(copy|list)\/([1-9]\d*)$/);
  if (req.method === "GET" && catalogMatch) {
    return send(res, 200, catalogItemDetail(
      db,
      userHousehold,
      user.id,
      catalogMatch[1],
      Number(catalogMatch[2]),
    ));
  }
  if (req.method === "PUT" && catalogMatch) {
    const rawInput = await jsonBody(req, maxBulkBodyBytes);
    const input = catalogMatch[1] === "copy" ? validatedCatalogInput(rawInput) : rawInput;
    const result = updateCatalogItem(
      db,
      userHousehold,
      user.id,
      catalogMatch[1],
      Number(catalogMatch[2]),
      input,
    );
    let coverCache = null;
    if (catalogMatch[1] === "copy" && input.coverUrl) {
      try {
        coverCache = await cacheExternalCover(
          db,
          userHousehold.household_id,
          Number(result.item.editionId),
          input.coverUrl,
        );
      } catch (error) {
        coverCache = { status: "failed", error: error.message || "Cover caching failed" };
      }
    }
    writeAuditEvent(db, {
      householdId: userHousehold.household_id,
      actorUserId: user.id,
      eventType: "catalog_item_updated",
      targetType: catalogMatch[1],
      targetId: catalogMatch[2],
      address: clientAddress(req),
      details: { coverCached: Boolean(coverCache?.url) },
    });
    return send(res, 200, { ...result, coverCache });
  }
  if (req.method === "DELETE" && catalogMatch) {
    const result = archiveCatalogItem(db, userHousehold, user.id, catalogMatch[1], Number(catalogMatch[2]));
    writeAuditEvent(db, {
      householdId: userHousehold.household_id,
      actorUserId: user.id,
      eventType: catalogMatch[1] === "copy" ? "catalog_copy_archived" : "catalog_list_entry_archived",
      targetType: catalogMatch[1],
      targetId: catalogMatch[2],
      address: clientAddress(req),
    });
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
        const systemRole = role === "admin" ? "system_admin" : "user";
        const result = db.prepare("INSERT INTO users (name, email, password_hash, role, system_role) VALUES (?, ?, ?, ?, ?)")
          .run(name, email, await hashPassword(password), role, systemRole);
        ensureUserHousehold(db, Number(result.lastInsertRowid), name, { systemAdmin: role === "admin" });
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
  const cache = file.endsWith("index.html") || file.endsWith("sw.js") || file.endsWith("manifest.webmanifest")
    ? "no-cache"
    : "public, max-age=31536000, immutable";
  writeHead(res, 200, { "Content-Type": mime[extname(file)] || "application/octet-stream", "Cache-Control": cache });
  if (req.method === "HEAD") return res.end();
  res.end(await readFile(file));
}
export const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    const unsafe = !["GET", "HEAD", "OPTIONS"].includes(req.method || "");
    const origin = req.headers.origin;
    if (unsafe && origin && !sameRequestOrigin(req, origin)) {
      return send(res, 403, {
        error: "Cross-origin request rejected. Behind a secure proxy, enable TRUST_PROXY and forward the original host and protocol.",
      });
    }
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
let maintenanceTimer;

export function startServer(listenPort = port, listenHost = host) {
  return new Promise((resolveListen, reject) => {
    const onError = error => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      console.log(`BookVault listening on http://${listenHost}:${server.address().port}`);
      if (!maintenanceTimer) {
        void runScheduledBackups(db);
        maintenanceTimer = setInterval(() => void runScheduledBackups(db), 60 * 60 * 1000);
        maintenanceTimer.unref();
      }
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
