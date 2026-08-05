import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import {
  DATABASE_SCHEMA_VERSION,
  ensureUserHousehold,
  runMigrations,
} from "./migrations.mjs";
import { applyPendingRestore } from "./restore-startup.mjs";

const scryptAsync = promisify(scrypt);
export const databasePath = process.env.DATABASE_PATH || "./data/book-vault.sqlite";
applyPendingRestore(databasePath);
const databaseExisted = existsSync(databasePath);
const MIN_PASSWORD_BYTES = 12;
export const MAX_PASSWORD_BYTES = 128;

mkdirSync(dirname(databasePath), { recursive: true });
export const db = new DatabaseSync(databasePath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// Session tokens are credentials. Migrate the original raw-token table by
// invalidating old sessions rather than retaining exposed bearer tokens.
const sessionColumns = db.prepare("PRAGMA table_info(sessions)").all();
if (sessionColumns.length && !sessionColumns.some(column => column.name === "token_hash")) {
  db.exec("DROP TABLE sessions");
}
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS books (
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
    binding TEXT,
    edition TEXT,
    storage_location TEXT,
    condition_grade TEXT
      CHECK(condition_grade IS NULL OR condition_grade IN ('new', 'like_new', 'good', 'fair', 'poor', 'damaged')),
    condition_notes TEXT,
    loaned_out INTEGER NOT NULL DEFAULT 0 CHECK(loaned_out IN (0, 1)),
    loaned_to TEXT,
    loaned_at TEXT,
    source TEXT NOT NULL DEFAULT 'manual'
      CHECK(source IN ('google_books', 'open_library', 'manual')),
    source_id TEXT,
    status TEXT NOT NULL DEFAULT 'owned'
      CHECK(status IN ('owned', 'wishlist', 'backlog')),
    read_status TEXT NOT NULL DEFAULT 'unread'
      CHECK(read_status IN ('read', 'unread', 'reading')),
    formats TEXT NOT NULL DEFAULT '["physical"]',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_books_user_created ON books(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_books_user_isbn ON books(user_id, isbn);
  CREATE INDEX IF NOT EXISTS idx_books_user_title ON books(user_id, title COLLATE NOCASE);
`);

// Older BookVault databases are migrated in place so container upgrades keep
// every existing book and do not require a separate migration command.
const bookColumns = new Set(db.prepare("PRAGMA table_info(books)").all().map(column => column.name));
const bookColumnMigrations = [
  ["binding", "TEXT"],
  ["edition", "TEXT"],
  ["storage_location", "TEXT"],
  ["condition_grade", "TEXT"],
  ["condition_notes", "TEXT"],
  ["loaned_out", "INTEGER NOT NULL DEFAULT 0"],
  ["loaned_to", "TEXT"],
  ["loaned_at", "TEXT"],
];
for (const [name, definition] of bookColumnMigrations) {
  if (!bookColumns.has(name)) db.exec(`ALTER TABLE books ADD COLUMN ${name} ${definition}`);
}
db.exec("CREATE INDEX IF NOT EXISTS idx_books_user_status_title_author ON books(user_id, status, title COLLATE NOCASE, author COLLATE NOCASE)");

db.exec(`
  CREATE TABLE IF NOT EXISTS families (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id),
    locations TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS family_members (
    family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (family_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_family_members_family ON family_members(family_id);

  CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    default_location TEXT,
    default_binding TEXT
      CHECK(default_binding IS NULL OR default_binding IN ('hardcover', 'paperback', 'mass_market_paperback', 'library_binding', 'spiral_bound', 'other')),
    default_condition TEXT
      CHECK(default_condition IS NULL OR default_condition IN ('new', 'like_new', 'good', 'fair', 'poor', 'damaged')),
    locations TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS book_read_statuses (
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    read_status TEXT NOT NULL DEFAULT 'unread'
      CHECK(read_status IN ('read', 'unread', 'reading')),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (book_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_book_read_statuses_user ON book_read_statuses(user_id, read_status);
`);

// Preserve every existing owner's reading state while allowing family members
// to maintain their own state for the same physical copy.
db.exec(`
  INSERT OR IGNORE INTO book_read_statuses (book_id, user_id, read_status)
  SELECT id, user_id, read_status FROM books
`);

export const migrationState = runMigrations({ db, databasePath, databaseExisted });
if (migrationState.version !== DATABASE_SCHEMA_VERSION) {
  throw new Error(`Database schema version ${migrationState.version} is not supported; expected ${DATABASE_SCHEMA_VERSION}`);
}

export function passwordError(password) {
  const bytes = Buffer.byteLength(String(password || ""), "utf8");
  if (bytes < MIN_PASSWORD_BYTES) return `Password must be at least ${MIN_PASSWORD_BYTES} characters`;
  if (bytes > MAX_PASSWORD_BYTES) return `Password must be no more than ${MAX_PASSWORD_BYTES} bytes`;
  return null;
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export async function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scryptAsync(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

export function publicUser(user, householdRole = null) {
  return user && {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    systemRole: user.system_role || (user.role === "admin" ? "system_admin" : "user"),
    householdRole: householdRole || undefined,
    disabled: Boolean(user.disabled),
    createdAt: user.created_at,
  };
}

export async function ensureAdmin() {
  if (db.prepare("SELECT COUNT(*) AS count FROM users").get().count) return;
  const name = String(process.env.ADMIN_NAME || "bookvaultadmin").trim();
  const email = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "";
  const problem = passwordError(password);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || problem) {
    throw new Error(`A new database requires a valid ADMIN_EMAIL and ADMIN_PASSWORD. ${problem || ""}`.trim());
  }
  const result = db.prepare("INSERT INTO users (name, email, password_hash, role, system_role) VALUES (?, ?, ?, 'admin', 'system_admin')")
    .run(name.slice(0, 100), email, await hashPassword(password));
  ensureUserHousehold(db, Number(result.lastInsertRowid), name, { systemAdmin: true });
  console.log(`Created initial administrator: ${email}`);
}
