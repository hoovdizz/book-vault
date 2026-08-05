import { mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const DATABASE_SCHEMA_VERSION = 4;

function parseArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizedText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizedIsbn(value) {
  const compact = String(value || "").toUpperCase().replace(/[^0-9X]/g, "");
  return /^(?:\d{9}[\dX]|\d{13})$/.test(compact) ? compact : "";
}

function isbn13From10(isbn10) {
  if (!/^\d{9}[\dX]$/.test(isbn10)) return "";
  const base = `978${isbn10.slice(0, 9)}`;
  const sum = [...base].reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 3 : 1), 0);
  return `${base}${(10 - (sum % 10)) % 10}`;
}

function isbn10From13(isbn13) {
  if (!/^978\d{10}$/.test(isbn13)) return "";
  const base = isbn13.slice(3, 12);
  const sum = [...base].reduce((total, digit, index) => total + Number(digit) * (10 - index), 0);
  const check = (11 - (sum % 11)) % 11;
  return `${base}${check === 10 ? "X" : check}`;
}

function isbnPair(value) {
  const compact = normalizedIsbn(value);
  if (compact.length === 10) return { isbn10: compact, isbn13: isbn13From10(compact) || null };
  if (compact.length === 13) return { isbn10: isbn10From13(compact) || null, isbn13: compact };
  return { isbn10: null, isbn13: null };
}

function addColumn(db, table, name, definition) {
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
  if (!columns.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

function schemaSql() {
  return `
    CREATE TABLE IF NOT EXISTS households (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      legacy_family_id INTEGER UNIQUE,
      default_location_id INTEGER,
      default_binding TEXT,
      default_condition TEXT,
      rating_scale TEXT NOT NULL DEFAULT 'stars5',
      rating_increment REAL NOT NULL DEFAULT 0.5,
      backup_retention INTEGER NOT NULL DEFAULT 14,
      scheduled_backup TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS household_members (
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      household_role TEXT NOT NULL DEFAULT 'adult',
      disabled INTEGER NOT NULL DEFAULT 0,
      joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (household_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS household_invitations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      email TEXT NOT NULL COLLATE NOCASE,
      household_role TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      invited_by INTEGER NOT NULL REFERENCES users(id),
      expires_at TEXT NOT NULL,
      accepted_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      parent_id INTEGER REFERENCES locations(id),
      name TEXT NOT NULL,
      level_type TEXT NOT NULL DEFAULT 'custom',
      sort_order INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS works (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      subtitle TEXT,
      normalized_title TEXT NOT NULL,
      primary_author TEXT NOT NULL DEFAULT '',
      normalized_author TEXT NOT NULL DEFAULT '',
      description TEXT,
      original_language TEXT,
      metadata_quality TEXT NOT NULL DEFAULT 'unknown',
      created_by INTEGER REFERENCES users(id),
      archived_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS contributors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS work_contributors (
      work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
      contributor_id INTEGER NOT NULL REFERENCES contributors(id) ON DELETE CASCADE,
      contribution_role TEXT NOT NULL DEFAULT 'author',
      sort_order INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (work_id, contributor_id, contribution_role)
    );

    CREATE TABLE IF NOT EXISTS editions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
      isbn10 TEXT,
      isbn13 TEXT,
      original_isbn TEXT,
      publisher TEXT,
      binding TEXT,
      media_format TEXT,
      language TEXT,
      publication_date TEXT,
      page_count INTEGER,
      edition_label TEXT,
      cover_url TEXT,
      cover_path TEXT,
      cover_options TEXT NOT NULL DEFAULT '[]',
      provider TEXT NOT NULL DEFAULT 'manual',
      provider_record_id TEXT,
      lookup_date TEXT,
      last_refresh_at TEXT,
      field_provenance TEXT NOT NULL DEFAULT '{}',
      manual_overrides TEXT NOT NULL DEFAULT '[]',
      legacy_fingerprint TEXT,
      archived_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS edition_provider_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      edition_id INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      provider_record_id TEXT,
      looked_up_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      original_isbn TEXT,
      raw_metadata TEXT,
      UNIQUE(edition_id, provider, provider_record_id)
    );

    CREATE TABLE IF NOT EXISTS series (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      description TEXT
    );
    CREATE TABLE IF NOT EXISTS work_series (
      work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
      series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
      volume_label TEXT,
      volume_sort REAL,
      reading_order REAL,
      series_role TEXT NOT NULL DEFAULT 'main',
      included_volumes TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (work_id, series_id, series_role, volume_label)
    );

    CREATE TABLE IF NOT EXISTS copies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      edition_id INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
      owner_user_id INTEGER REFERENCES users(id),
      format TEXT NOT NULL,
      location_id INTEGER REFERENCES locations(id),
      condition_grade TEXT,
      condition_notes TEXT,
      purchase_date TEXT,
      purchase_price_cents INTEGER,
      purchase_currency TEXT,
      purchase_source TEXT,
      custom_barcode TEXT,
      copy_notes TEXT,
      copy_status TEXT NOT NULL DEFAULT 'active',
      added_by INTEGER REFERENCES users(id),
      acquired_at TEXT,
      archived_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS copy_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      copy_id INTEGER NOT NULL REFERENCES copies(id) ON DELETE CASCADE,
      actor_user_id INTEGER REFERENCES users(id),
      event_type TEXT NOT NULL,
      from_location_id INTEGER REFERENCES locations(id),
      to_location_id INTEGER REFERENCES locations(id),
      details TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS external_borrowers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      display_name TEXT NOT NULL,
      contact_email TEXT,
      notes TEXT,
      archived_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS loans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      copy_id INTEGER NOT NULL REFERENCES copies(id),
      borrower_user_id INTEGER REFERENCES users(id),
      external_borrower_id INTEGER REFERENCES external_borrowers(id),
      checkout_at TEXT NOT NULL,
      due_at TEXT,
      returned_at TEXT,
      renewed_count INTEGER NOT NULL DEFAULT 0,
      loan_status TEXT NOT NULL DEFAULT 'checked_out',
      notes TEXT,
      checked_out_by INTEGER REFERENCES users(id),
      checked_in_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS loan_holds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
      requested_by INTEGER NOT NULL REFERENCES users(id),
      queue_position INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS household_reading_statuses (
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      status_key TEXT NOT NULL,
      label TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (household_id, status_key)
    );
    CREATE TABLE IF NOT EXISTS user_work_state (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
      edition_id INTEGER REFERENCES editions(id) ON DELETE SET NULL,
      status_key TEXT NOT NULL DEFAULT 'unread',
      rating REAL,
      favorite INTEGER NOT NULL DEFAULT 0,
      private_notes TEXT,
      household_notes TEXT,
      preferred_formats TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, work_id)
    );
    CREATE TABLE IF NOT EXISTS reading_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
      edition_id INTEGER REFERENCES editions(id) ON DELETE SET NULL,
      started_at TEXT,
      finished_at TEXT,
      progress_value REAL,
      progress_unit TEXT,
      current_page INTEGER,
      percentage REAL,
      minutes_read INTEGER,
      audiobook_minutes INTEGER,
      format_used TEXT,
      rating REAL,
      private_notes TEXT,
      household_notes TEXT,
      favorite INTEGER NOT NULL DEFAULT 0,
      reread INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS reading_state_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
      edition_id INTEGER REFERENCES editions(id) ON DELETE SET NULL,
      status_key TEXT NOT NULL,
      source TEXT NOT NULL,
      source_record_id TEXT,
      recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS list_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      requested_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
      edition_id INTEGER REFERENCES editions(id) ON DELETE SET NULL,
      list_type TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'personal',
      desired_edition TEXT,
      preferred_formats TEXT NOT NULL DEFAULT '[]',
      priority TEXT,
      expected_price_cents INTEGER,
      expected_currency TEXT,
      notes TEXT,
      gift_private INTEGER NOT NULL DEFAULT 0,
      intended_recipient_id INTEGER REFERENCES users(id),
      purchase_state TEXT NOT NULL DEFAULT 'wanted',
      added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      archived_at TEXT
    );

    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS work_tags (
      work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (work_id, tag_id)
    );
    CREATE TABLE IF NOT EXISTS custom_collections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      owner_user_id INTEGER REFERENCES users(id),
      name TEXT NOT NULL,
      smart_filter TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS collection_works (
      collection_id INTEGER NOT NULL REFERENCES custom_collections(id) ON DELETE CASCADE,
      work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
      PRIMARY KEY (collection_id, work_id)
    );
    CREATE TABLE IF NOT EXISTS custom_field_definitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      field_type TEXT NOT NULL,
      applies_to TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS custom_field_values (
      field_id INTEGER NOT NULL REFERENCES custom_field_definitions(id) ON DELETE CASCADE,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      value TEXT,
      PRIMARY KEY (field_id, entity_type, entity_id)
    );

    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      catalog_view TEXT NOT NULL DEFAULT 'cover',
      catalog_sort TEXT NOT NULL DEFAULT 'title',
      catalog_filters TEXT NOT NULL DEFAULT '{}',
      visible_columns TEXT NOT NULL DEFAULT '[]',
      reading_goal TEXT,
      preferred_formats TEXT NOT NULL DEFAULT '[]',
      theme TEXT NOT NULL DEFAULT 'system',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS metadata_provider_settings (
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL,
      settings TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (household_id, provider)
    );
    CREATE TABLE IF NOT EXISTS metadata_cache (
      cache_key TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      response_json TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS import_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      requested_by INTEGER NOT NULL REFERENCES users(id),
      preset TEXT,
      source_filename TEXT,
      mapping TEXT,
      dry_run INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending',
      report_path TEXT,
      unknown_fields TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS backup_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      household_id INTEGER REFERENCES households(id) ON DELETE SET NULL,
      requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      backup_type TEXT NOT NULL,
      path TEXT NOT NULL,
      size_bytes INTEGER,
      integrity_status TEXT,
      status TEXT NOT NULL,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS background_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      household_id INTEGER REFERENCES households(id) ON DELETE CASCADE,
      job_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      progress REAL NOT NULL DEFAULT 0,
      details TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      started_at TEXT,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      household_id INTEGER REFERENCES households(id) ON DELETE SET NULL,
      actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      address TEXT,
      details TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS legacy_book_map (
      legacy_book_id INTEGER PRIMARY KEY,
      household_id INTEGER NOT NULL,
      work_id INTEGER NOT NULL,
      edition_id INTEGER NOT NULL,
      list_entry_id INTEGER,
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS legacy_copy_map (
      legacy_book_id INTEGER NOT NULL,
      copy_id INTEGER NOT NULL UNIQUE,
      format TEXT NOT NULL,
      PRIMARY KEY (legacy_book_id, copy_id)
    );
    CREATE TABLE IF NOT EXISTS legacy_reading_status_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      legacy_book_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      work_id INTEGER NOT NULL,
      edition_id INTEGER,
      status_key TEXT NOT NULL,
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(legacy_book_id, user_id)
    );
  `;
}

const readingStatuses = [
  ["unread", "Unread"],
  ["want_to_read", "Want to read"],
  ["reading", "Reading"],
  ["paused", "Paused"],
  ["did_not_finish", "Did not finish"],
  ["read", "Read"],
  ["reference", "Reference"],
  ["abandoned", "Abandoned"],
];

function seedHouseholdDefaults(db, householdId) {
  const insertStatus = db.prepare(`
    INSERT OR IGNORE INTO household_reading_statuses (household_id, status_key, label, sort_order)
    VALUES (?, ?, ?, ?)
  `);
  readingStatuses.forEach(([key, label], index) => insertStatus.run(householdId, key, label, index));
  const provider = db.prepare(`
    INSERT OR IGNORE INTO metadata_provider_settings (household_id, provider, enabled, priority)
    VALUES (?, ?, ?, ?)
  `);
  provider.run(householdId, "google_books", 1, 10);
  provider.run(householdId, "open_library", 1, 20);
  provider.run(householdId, "manual", 1, 100);
}

export function ensureUserHousehold(db, userId, displayName, options = {}) {
  const membership = db.prepare("SELECT household_id FROM household_members WHERE user_id = ?").get(userId);
  if (membership) return membership.household_id;
  const result = db.prepare("INSERT INTO households (name, created_by) VALUES (?, ?)")
    .run(`${String(displayName || "Personal").slice(0, 80)} Household`, userId);
  const householdId = Number(result.lastInsertRowid);
  db.prepare(`
    INSERT INTO household_members (household_id, user_id, household_role)
    VALUES (?, ?, 'household_admin')
  `).run(householdId, userId);
  if (options.systemAdmin) {
    db.prepare("UPDATE users SET system_role = 'system_admin' WHERE id = ?").run(userId);
  }
  seedHouseholdDefaults(db, householdId);
  return householdId;
}

function migrateHouseholds(db) {
  const familyRows = db.prepare("SELECT * FROM families ORDER BY id").all();
  const householdForFamily = new Map();
  for (const family of familyRows) {
    let household = db.prepare("SELECT id FROM households WHERE legacy_family_id = ?").get(family.id);
    if (!household) {
      const result = db.prepare(`
        INSERT INTO households (
          name, created_by, legacy_family_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(family.name, family.created_by, family.id, family.created_at, family.updated_at);
      household = { id: Number(result.lastInsertRowid) };
    }
    householdForFamily.set(family.id, household.id);
    const members = db.prepare("SELECT * FROM family_members WHERE family_id = ?").all(family.id);
    for (const member of members) {
      const creator = member.user_id === family.created_by;
      db.prepare(`
        INSERT OR IGNORE INTO household_members (household_id, user_id, household_role, joined_at)
        VALUES (?, ?, ?, ?)
      `).run(household.id, member.user_id, creator ? "household_admin" : "adult", member.created_at);
    }
    seedHouseholdDefaults(db, household.id);
  }

  const users = db.prepare("SELECT * FROM users ORDER BY id").all();
  for (const user of users) {
    if (user.role === "admin") db.prepare("UPDATE users SET system_role = 'system_admin' WHERE id = ?").run(user.id);
    ensureUserHousehold(db, user.id, user.name, { systemAdmin: user.role === "admin" });
  }
}

function findOrCreateLocation(db, householdId, name, userId) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return null;
  const existing = db.prepare(`
    SELECT id FROM locations
    WHERE household_id = ? AND parent_id IS NULL AND lower(name) = lower(?)
    ORDER BY archived_at IS NOT NULL, id
    LIMIT 1
  `).get(householdId, trimmed);
  if (existing) return existing.id;
  const result = db.prepare(`
    INSERT INTO locations (household_id, name, level_type, created_by)
    VALUES (?, ?, 'legacy', ?)
  `).run(householdId, trimmed.slice(0, 150), userId);
  return Number(result.lastInsertRowid);
}

function migrateLocationsAndDefaults(db) {
  const households = db.prepare("SELECT * FROM households").all();
  for (const household of households) {
    const legacyFamily = household.legacy_family_id
      ? db.prepare("SELECT locations FROM families WHERE id = ?").get(household.legacy_family_id)
      : null;
    for (const location of parseArray(legacyFamily?.locations)) {
      findOrCreateLocation(db, household.id, location, household.created_by);
    }
  }
  const settingsRows = db.prepare("SELECT * FROM user_settings").all();
  for (const settings of settingsRows) {
    const membership = db.prepare("SELECT household_id FROM household_members WHERE user_id = ?").get(settings.user_id);
    if (!membership) continue;
    for (const location of parseArray(settings.locations)) {
      findOrCreateLocation(db, membership.household_id, location, settings.user_id);
    }
    const locationId = findOrCreateLocation(db, membership.household_id, settings.default_location, settings.user_id);
    db.prepare(`
      UPDATE households SET
        default_location_id = COALESCE(default_location_id, ?),
        default_binding = COALESCE(default_binding, ?),
        default_condition = COALESCE(default_condition, ?)
      WHERE id = ? AND created_by = ?
    `).run(locationId, settings.default_binding, settings.default_condition, membership.household_id, settings.user_id);
  }
}

function migrateLegacyBooks(db) {
  const books = db.prepare(`
    SELECT b.* FROM books b
    LEFT JOIN legacy_book_map legacy ON legacy.legacy_book_id = b.id
    WHERE legacy.legacy_book_id IS NULL
    ORDER BY b.id
  `).all();
  const insertContributor = db.prepare(`
    INSERT INTO contributors (household_id, name, normalized_name) VALUES (?, ?, ?)
  `);
  const insertWork = db.prepare(`
    INSERT INTO works (
      household_id, title, normalized_title, primary_author, normalized_author,
      description, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEdition = db.prepare(`
    INSERT INTO editions (
      household_id, work_id, isbn10, isbn13, original_isbn, publisher, binding,
      media_format, language, publication_date, page_count, edition_label, cover_url,
      cover_options, provider, provider_record_id, lookup_date, field_provenance,
      manual_overrides, legacy_fingerprint, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertCopy = db.prepare(`
    INSERT INTO copies (
      household_id, edition_id, owner_user_id, format, location_id, condition_grade,
      condition_notes, copy_status, added_by, acquired_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
  `);
  const insertList = db.prepare(`
    INSERT INTO list_entries (
      household_id, requested_by, work_id, edition_id, list_type, preferred_formats, added_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const book of books) {
    const membership = db.prepare("SELECT household_id FROM household_members WHERE user_id = ?").get(book.user_id);
    if (!membership) continue;
    const householdId = membership.household_id;
    const normalizedTitle = normalizedText(book.title);
    const normalizedAuthor = normalizedText(book.author);
    let work = db.prepare(`
      SELECT * FROM works
      WHERE household_id = ? AND normalized_title = ? AND normalized_author = ?
      ORDER BY id LIMIT 1
    `).get(householdId, normalizedTitle, normalizedAuthor);
    if (!work) {
      const result = insertWork.run(
        householdId,
        book.title,
        normalizedTitle,
        book.author,
        normalizedAuthor,
        book.description,
        book.user_id,
        book.created_at,
        book.updated_at,
      );
      work = db.prepare("SELECT * FROM works WHERE id = ?").get(result.lastInsertRowid);
      let contributor = db.prepare(`
        SELECT id FROM contributors WHERE household_id = ? AND normalized_name = ? ORDER BY id LIMIT 1
      `).get(householdId, normalizedAuthor);
      if (!contributor) contributor = { id: Number(insertContributor.run(householdId, book.author, normalizedAuthor).lastInsertRowid) };
      db.prepare(`
        INSERT OR IGNORE INTO work_contributors (work_id, contributor_id, contribution_role, sort_order)
        VALUES (?, ?, 'author', 0)
      `).run(work.id, contributor.id);
    }

    const { isbn10, isbn13 } = isbnPair(book.isbn);
    const fingerprint = [
      normalizedText(book.publisher),
      book.published_year || "",
      book.binding || "",
      normalizedText(book.edition),
      book.source || "manual",
      book.source_id || "",
    ].join("|");
    let edition = isbn13
      ? db.prepare("SELECT * FROM editions WHERE household_id = ? AND isbn13 = ? ORDER BY id LIMIT 1").get(householdId, isbn13)
      : isbn10
        ? db.prepare("SELECT * FROM editions WHERE household_id = ? AND isbn10 = ? ORDER BY id LIMIT 1").get(householdId, isbn10)
        : db.prepare(`
            SELECT * FROM editions
            WHERE household_id = ? AND work_id = ? AND legacy_fingerprint = ?
            ORDER BY id LIMIT 1
          `).get(householdId, work.id, fingerprint);
    if (!edition) {
      const provider = ["google_books", "open_library"].includes(book.source) ? book.source : "manual";
      const provenance = {
        title: provider,
        author: provider,
        isbn: provider,
        publisher: provider,
        cover: provider,
      };
      const manualOverrides = provider === "manual"
        ? ["title", "author", "isbn", "publisher", "binding", "edition", "cover"]
        : [];
      const result = insertEdition.run(
        householdId,
        work.id,
        isbn10,
        isbn13,
        book.isbn,
        book.publisher,
        book.binding,
        null,
        null,
        book.published_year ? String(book.published_year) : null,
        book.page_count,
        book.edition,
        book.cover_url,
        book.cover_options || "[]",
        provider,
        book.source_id,
        book.created_at,
        JSON.stringify(provenance),
        JSON.stringify(manualOverrides),
        fingerprint,
        book.created_at,
        book.updated_at,
      );
      edition = db.prepare("SELECT * FROM editions WHERE id = ?").get(result.lastInsertRowid);
      if (provider !== "manual") {
        db.prepare(`
          INSERT OR IGNORE INTO edition_provider_records (
            edition_id, provider, provider_record_id, looked_up_at, original_isbn
          ) VALUES (?, ?, ?, ?, ?)
        `).run(edition.id, provider, book.source_id, book.created_at, book.isbn);
      }
    }

    if (book.series) {
      const normalizedSeries = normalizedText(book.series);
      let seriesRow = db.prepare(`
        SELECT id FROM series WHERE household_id = ? AND normalized_name = ? ORDER BY id LIMIT 1
      `).get(householdId, normalizedSeries);
      if (!seriesRow) {
        const result = db.prepare("INSERT INTO series (household_id, name, normalized_name) VALUES (?, ?, ?)")
          .run(householdId, book.series, normalizedSeries);
        seriesRow = { id: Number(result.lastInsertRowid) };
      }
      const numericPosition = Number(book.series_number);
      db.prepare(`
        INSERT OR IGNORE INTO work_series (
          work_id, series_id, volume_label, volume_sort, reading_order, series_role
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        work.id,
        seriesRow.id,
        book.series_number,
        Number.isFinite(numericPosition) ? numericPosition : null,
        Number.isFinite(numericPosition) ? numericPosition : null,
        "main",
      );
    }
    if (book.genre) {
      const genreName = String(book.genre).trim().slice(0, 100);
      if (genreName) {
        const normalizedGenre = normalizedText(genreName);
        let genreTag = db.prepare(`
          SELECT id FROM tags WHERE household_id = ? AND normalized_name = ?
          ORDER BY id LIMIT 1
        `).get(householdId, normalizedGenre);
        if (!genreTag) {
          genreTag = { id: Number(db.prepare(`
            INSERT INTO tags (household_id, name, normalized_name) VALUES (?, ?, ?)
          `).run(householdId, genreName, normalizedGenre).lastInsertRowid) };
        }
        db.prepare("INSERT OR IGNORE INTO work_tags (work_id, tag_id) VALUES (?, ?)")
          .run(work.id, genreTag.id);
      }
    }
    if (book.collection_name) {
      let collection = db.prepare(`
        SELECT id FROM custom_collections
        WHERE household_id = ? AND owner_user_id = ? AND lower(name) = lower(?)
        ORDER BY id LIMIT 1
      `).get(householdId, book.user_id, book.collection_name);
      if (!collection) {
        collection = { id: Number(db.prepare(`
          INSERT INTO custom_collections (household_id, owner_user_id, name, created_at)
          VALUES (?, ?, ?, ?)
        `).run(householdId, book.user_id, book.collection_name, book.created_at).lastInsertRowid) };
      }
      db.prepare(`
        INSERT OR IGNORE INTO collection_works (collection_id, work_id) VALUES (?, ?)
      `).run(collection.id, work.id);
    }

    let listEntryId = null;
    if (book.status === "owned") {
      const formats = parseArray(book.formats).filter(format => ["physical", "ebook", "audiobook"].includes(format));
      const preservedFormats = formats.length ? [...new Set(formats)] : ["physical"];
      const locationId = findOrCreateLocation(db, householdId, book.storage_location, book.user_id);
      let loanCopyId = null;
      for (const format of preservedFormats) {
        const result = insertCopy.run(
          householdId,
          edition.id,
          book.user_id,
          format,
          format === "physical" ? locationId : null,
          format === "physical" ? book.condition_grade : null,
          format === "physical" ? book.condition_notes : null,
          book.user_id,
          book.created_at,
          book.created_at,
          book.updated_at,
        );
        const copyId = Number(result.lastInsertRowid);
        db.prepare("INSERT INTO legacy_copy_map (legacy_book_id, copy_id, format) VALUES (?, ?, ?)")
          .run(book.id, copyId, format);
        db.prepare(`
          INSERT INTO copy_events (copy_id, actor_user_id, event_type, to_location_id, details, created_at)
          VALUES (?, ?, 'legacy_imported', ?, ?, ?)
        `).run(copyId, book.user_id, format === "physical" ? locationId : null, JSON.stringify({ legacyBookId: book.id }), book.created_at);
        if (!loanCopyId && format === "physical") loanCopyId = copyId;
      }
      if (book.loaned_out && loanCopyId) {
        let borrowerId = null;
        if (book.loaned_to) {
          borrowerId = Number(db.prepare(`
            INSERT INTO external_borrowers (household_id, display_name, created_at)
            VALUES (?, ?, ?)
          `).run(householdId, book.loaned_to, book.loaned_at || book.updated_at).lastInsertRowid);
        }
        db.prepare(`
          INSERT INTO loans (
            household_id, copy_id, external_borrower_id, checkout_at, loan_status,
            notes, checked_out_by, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'checked_out', ?, ?, ?, ?)
        `).run(
          householdId,
          loanCopyId,
          borrowerId,
          book.loaned_at || book.updated_at,
          book.loaned_to ? null : "Imported active loan without a borrower name",
          book.user_id,
          book.loaned_at || book.updated_at,
          book.updated_at,
        );
      }
    } else {
      const result = insertList.run(
        householdId,
        book.user_id,
        work.id,
        edition.id,
        book.status === "wishlist" ? "wishlist" : "backlog",
        book.formats || "[]",
        book.created_at,
      );
      listEntryId = Number(result.lastInsertRowid);
    }
    db.prepare(`
      INSERT INTO legacy_book_map (
        legacy_book_id, household_id, work_id, edition_id, list_entry_id
      ) VALUES (?, ?, ?, ?, ?)
    `).run(book.id, householdId, work.id, edition.id, listEntryId);
  }

  const readingRows = db.prepare(`
    SELECT reading.book_id, reading.user_id, reading.read_status, books.updated_at,
      legacy.work_id, legacy.edition_id
    FROM book_read_statuses reading
    JOIN books ON books.id = reading.book_id
    JOIN legacy_book_map legacy ON legacy.legacy_book_id = reading.book_id
    ORDER BY books.updated_at, reading.book_id
  `).all();
  for (const reading of readingRows) {
    const status = ["read", "reading"].includes(reading.read_status) ? reading.read_status : "unread";
    db.prepare(`
      INSERT OR IGNORE INTO legacy_reading_status_imports (
        legacy_book_id, user_id, work_id, edition_id, status_key
      ) VALUES (?, ?, ?, ?, ?)
    `).run(reading.book_id, reading.user_id, reading.work_id, reading.edition_id, status);
    db.prepare(`
      INSERT INTO reading_state_history (
        user_id, work_id, edition_id, status_key, source, source_record_id, recorded_at
      ) VALUES (?, ?, ?, ?, 'legacy_book', ?, ?)
    `).run(reading.user_id, reading.work_id, reading.edition_id, status, String(reading.book_id), reading.updated_at);
    db.prepare(`
      INSERT INTO user_work_state (user_id, work_id, edition_id, status_key, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, work_id) DO UPDATE SET
        edition_id = excluded.edition_id,
        status_key = excluded.status_key,
        updated_at = excluded.updated_at
    `).run(reading.user_id, reading.work_id, reading.edition_id, status, reading.updated_at);
  }
}

function addIndexes(db) {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_household_member_user ON household_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_household_members_household_role ON household_members(household_id, household_role, disabled);
    CREATE INDEX IF NOT EXISTS idx_locations_parent ON locations(household_id, parent_id, archived_at, sort_order);
    CREATE INDEX IF NOT EXISTS idx_works_household_title ON works(household_id, normalized_title, normalized_author);
    CREATE INDEX IF NOT EXISTS idx_works_recent ON works(household_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_contributors_name ON contributors(household_id, normalized_name);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_editions_household_isbn13 ON editions(household_id, isbn13) WHERE isbn13 IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_editions_household_isbn10 ON editions(household_id, isbn10) WHERE isbn10 IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_editions_work ON editions(work_id, publication_date, id);
    CREATE INDEX IF NOT EXISTS idx_editions_provider ON editions(household_id, provider, provider_record_id);
    CREATE INDEX IF NOT EXISTS idx_copies_inventory ON copies(household_id, copy_status, owner_user_id, location_id, format);
    CREATE INDEX IF NOT EXISTS idx_copies_edition_active ON copies(edition_id, archived_at, copy_status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_copies_barcode ON copies(household_id, custom_barcode) WHERE custom_barcode IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_copy_events_recent ON copy_events(copy_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_active_loan_copy ON loans(copy_id) WHERE returned_at IS NULL AND loan_status IN ('checked_out', 'overdue');
    CREATE INDEX IF NOT EXISTS idx_loans_household_due ON loans(household_id, returned_at, due_at);
    CREATE INDEX IF NOT EXISTS idx_reading_state_user_status ON user_work_state(user_id, status_key, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_reading_sessions_user_dates ON reading_sessions(user_id, finished_at DESC, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_list_entries_user_type ON list_entries(requested_by, list_type, archived_at, added_at DESC);
    CREATE INDEX IF NOT EXISTS idx_list_entries_household_scope ON list_entries(household_id, scope, list_type, archived_at);
    CREATE INDEX IF NOT EXISTS idx_list_entries_edition_active ON list_entries(edition_id, archived_at, list_type);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_name ON tags(household_id, normalized_name);
    CREATE INDEX IF NOT EXISTS idx_series_name ON series(household_id, normalized_name);
    CREATE INDEX IF NOT EXISTS idx_work_series_order ON work_series(series_id, reading_order, volume_sort);
    CREATE INDEX IF NOT EXISTS idx_audit_household_recent ON audit_events(household_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON background_jobs(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_backup_records_recent ON backup_records(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_metadata_cache_expiry ON metadata_cache(expires_at);
  `);
}

function createAutomaticBackup(db, databasePath, nextVersion) {
  const backupDirectory = join(dirname(databasePath), "backups");
  mkdirSync(backupDirectory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `${basename(databasePath, ".sqlite")}-before-schema-v${nextVersion}-${timestamp}.sqlite`;
  const backupPath = join(backupDirectory, fileName);
  db.exec("PRAGMA wal_checkpoint(FULL)");
  const escaped = backupPath.replaceAll("'", "''");
  db.exec(`VACUUM INTO '${escaped}'`);
  return backupPath;
}

export function ensurePersistentDirectories(databasePath) {
  const root = dirname(databasePath);
  for (const directory of ["backups", "covers", "uploads", "imports", "logs"]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
}

export function runMigrations({ db, databasePath, databaseExisted }) {
  ensurePersistentDirectories(databasePath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      backup_path TEXT,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const applied = new Set(db.prepare("SELECT version FROM schema_migrations").all().map(row => row.version));
  const migrations = [
    {
      version: 1,
      name: "normalized catalog and household schema",
      backup: true,
      up() {
        addColumn(db, "users", "system_role", "TEXT NOT NULL DEFAULT 'user'");
        addColumn(db, "users", "disabled", "INTEGER NOT NULL DEFAULT 0");
        db.exec(schemaSql());
      },
    },
    {
      version: 2,
      name: "preserve legacy households books copies lists reading and loans",
      backup: false,
      up() {
        migrateHouseholds(db);
        migrateLocationsAndDefaults(db);
        migrateLegacyBooks(db);
      },
    },
    {
      version: 3,
      name: "catalog performance indexes and provider defaults",
      backup: false,
      up() {
        addIndexes(db);
        for (const household of db.prepare("SELECT id FROM households").all()) {
          seedHouseholdDefaults(db, household.id);
        }
      },
    },
    {
      version: 4,
      name: "edition and list lookup performance indexes",
      backup: false,
      up() {
        addIndexes(db);
      },
    },
  ];

  let backupPath = null;
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    if (migration.backup && databaseExisted && !backupPath) {
      const hasData = db.prepare("SELECT EXISTS(SELECT 1 FROM users) OR EXISTS(SELECT 1 FROM books) AS populated").get().populated;
      if (hasData) backupPath = createAutomaticBackup(db, databasePath, migration.version);
    }
    try {
      db.exec("BEGIN IMMEDIATE");
      migration.up();
      db.prepare(`
        INSERT INTO schema_migrations (version, name, backup_path) VALUES (?, ?, ?)
      `).run(migration.version, migration.name, backupPath);
      db.exec("COMMIT");
      db.exec(`PRAGMA user_version = ${migration.version}`);
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw new Error(
        `Database migration ${migration.version} (${migration.name}) failed.`
        + `${backupPath ? ` Automatic backup: ${backupPath}.` : ""} ${error.message}`,
        { cause: error },
      );
    }
  }
  return {
    version: Number(db.prepare("PRAGMA user_version").get().user_version),
    backupPath,
  };
}
