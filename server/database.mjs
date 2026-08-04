import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const databasePath = process.env.DATABASE_PATH || "./data/book-vault.sqlite";
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
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );
`);

export function hashPassword(password) {
  const salt = randomBytes(16);
  return `${salt.toString("hex")}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  return timingSafeEqual(scryptSync(password, Buffer.from(saltHex, "hex"), expected.length), expected);
}
export function publicUser(user) {
  return user && { id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.created_at };
}
export function ensureAdmin() {
  if (db.prepare("SELECT COUNT(*) AS count FROM users").get().count) return;
  const name = process.env.ADMIN_NAME || "BookVault Admin";
  const email = process.env.ADMIN_EMAIL || "admin@bookvault.local";
  const password = process.env.ADMIN_PASSWORD || "changeme";
  db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')")
    .run(name, email.toLowerCase(), hashPassword(password));
  if (!process.env.ADMIN_PASSWORD) console.warn("WARNING: using default admin password 'changeme'. Set ADMIN_PASSWORD.");
  console.log(`Created initial administrator: ${email}`);
}
