import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const databasePath = process.env.DATABASE_PATH || "./data/book-vault.sqlite";
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

export function publicUser(user) {
  return user && { id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.created_at };
}

export async function ensureAdmin() {
  if (db.prepare("SELECT COUNT(*) AS count FROM users").get().count) return;
  const name = String(process.env.ADMIN_NAME || "BookVault Admin").trim();
  const email = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "";
  const problem = passwordError(password);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || problem) {
    throw new Error(`A new database requires a valid ADMIN_EMAIL and ADMIN_PASSWORD. ${problem || ""}`.trim());
  }
  db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')")
    .run(name.slice(0, 100), email, await hashPassword(password));
  console.log(`Created initial administrator: ${email}`);
}
