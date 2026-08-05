// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATABASE_SCHEMA_VERSION, runMigrations } from "./migrations.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function legacyDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
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
      condition_grade TEXT,
      condition_notes TEXT,
      loaned_out INTEGER NOT NULL DEFAULT 0,
      loaned_to TEXT,
      loaned_at TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      source_id TEXT,
      status TEXT NOT NULL DEFAULT 'owned',
      read_status TEXT NOT NULL DEFAULT 'unread',
      formats TEXT NOT NULL DEFAULT '["physical"]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE families (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_by INTEGER NOT NULL,
      locations TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE family_members (
      family_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (family_id, user_id)
    );
    CREATE TABLE user_settings (
      user_id INTEGER PRIMARY KEY,
      default_location TEXT,
      default_binding TEXT,
      default_condition TEXT,
      locations TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE book_read_statuses (
      book_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      read_status TEXT NOT NULL DEFAULT 'unread',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (book_id, user_id)
    );

    INSERT INTO users (id, name, email, password_hash, role)
    VALUES
      (1, 'Legacy Admin', 'admin@example.test', 'salt:hash', 'admin'),
      (2, 'Legacy Reader', 'reader@example.test', 'salt:hash', 'user');
    INSERT INTO sessions (token_hash, user_id, expires_at)
    VALUES ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 2, '2099-01-01T00:00:00.000Z');
    INSERT INTO families (id, name, created_by, locations)
    VALUES (1, 'Legacy Family', 1, '["Office Shelf","Den Tote"]');
    INSERT INTO family_members (family_id, user_id) VALUES (1, 1), (1, 2);
    INSERT INTO user_settings (
      user_id, default_location, default_binding, default_condition, locations
    ) VALUES (1, 'Office Shelf', 'hardcover', 'good', '["Office Shelf","Den Tote"]');

    INSERT INTO books (
      id, user_id, isbn, title, author, series, series_number, collection_name,
      cover_url, cover_options, genre, page_count, published_year, publisher,
      description, binding, edition, storage_location, condition_grade,
      condition_notes, loaned_out, loaned_to, loaned_at, source, source_id,
      status, read_status, formats
    ) VALUES
      (
        1, 1, '9780306406157', 'Legacy Shared Work', 'Legacy Author',
        'Legacy Series', '1.5', 'Signed Books',
        'https://covers.openlibrary.org/b/id/1-L.jpg', '[]', 'Fantasy', 320, 2001,
        'Legacy Press', 'Preserve me', 'hardcover', 'First edition',
        'Office Shelf', 'fair', 'Bent corner', 1, 'External Friend',
        '2026-01-02', 'open_library', '/works/OL1W', 'owned', 'read',
        '["physical","ebook"]'
      ),
      (
        2, 2, '9783161484100', 'Legacy Shared Work', 'Legacy Author',
        'Legacy Series', '2', 'Reading Group', NULL, '[]', 'Fantasy', 300, 2003,
        'Second Press', NULL, 'paperback', 'Revised edition',
        'Den Tote', 'good', NULL, 0, NULL, NULL, 'manual', NULL,
        'wishlist', 'reading', '["physical"]'
      ),
      (
        3, 2, NULL, 'Legacy Backlog', 'Other Author',
        NULL, NULL, NULL, NULL, '[]', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, 0, NULL, NULL, 'manual', NULL,
        'backlog', 'unread', '["ebook"]'
      );
    INSERT INTO book_read_statuses (book_id, user_id, read_status)
    VALUES (1, 1, 'read'), (1, 2, 'reading'), (2, 2, 'reading'), (3, 2, 'unread');
  `);
  return db;
}

describe("versioned normalized migrations", () => {
  it("backs up first and preserves every legacy domain in normalized records", () => {
    const directory = mkdtempSync(join(tmpdir(), "book-vault-migration-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "book-vault.sqlite");
    const db = legacyDatabase(path);
    const state = runMigrations({ db, databasePath: path, databaseExisted: true });

    expect(state.version).toBe(DATABASE_SCHEMA_VERSION);
    expect(state.backupPath).toBeTruthy();
    expect(existsSync(state.backupPath)).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS count FROM users").get().count).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count).toBe(1);
    expect(db.prepare("SELECT name FROM households").get().name).toBe("Legacy Family");
    expect(db.prepare("SELECT COUNT(*) AS count FROM household_members").get().count).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS count FROM legacy_book_map").get().count).toBe(3);
    expect(db.prepare("SELECT COUNT(*) AS count FROM works").get().count).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS count FROM editions").get().count).toBe(3);
    expect(db.prepare("SELECT COUNT(*) AS count FROM copies").get().count).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS count FROM loans WHERE returned_at IS NULL").get().count).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM list_entries WHERE list_type = 'wishlist'").get().count).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM list_entries WHERE list_type = 'backlog'").get().count).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM legacy_reading_status_imports").get().count).toBe(4);
    expect(db.prepare("SELECT COUNT(*) AS count FROM locations").get().count).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS count FROM custom_collections").get().count).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS count FROM tags WHERE name = 'Fantasy'").get().count).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM work_tags").get().count).toBe(1);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_copies_edition_active'
    `).get().count).toBe(1);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM work_series WHERE volume_label IN ('1.5', '2')
    `).get().count).toBe(2);
    expect(db.prepare(`
      SELECT condition_notes FROM copies WHERE format = 'physical'
    `).get().condition_notes).toBe("Bent corner");
    db.close();
  });
});
