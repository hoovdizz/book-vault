import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { databasePath } from "./database.mjs";
import { assertHouseholdAdmin } from "./households.mjs";
import { createCatalogItem, duplicateWarnings } from "./catalog.mjs";
import { normalizeIsbn } from "./book-search.mjs";
import { createReadingSession } from "./reading.mjs";

const importDirectory = join(dirname(resolve(databasePath)), "imports");

const presets = {
  generic: {
    label: "Generic CSV",
    aliases: {
      title: ["title", "book title", "name"],
      author: ["author", "authors", "primary author"],
      isbn: ["isbn13", "isbn-13", "isbn", "isbn10", "isbn-10"],
      publisher: ["publisher"],
      publicationDate: ["publication date", "published", "year published", "original publication year"],
      pageCount: ["page count", "pages", "number of pages"],
      binding: ["binding", "format"],
      status: ["status", "exclusive shelf", "shelf"],
      readStatus: ["read status", "reading status"],
      rating: ["rating", "my rating"],
      series: ["series"],
      seriesNumber: ["series number", "volume", "position"],
      location: ["location", "storage location"],
      conditionGrade: ["condition", "condition grade"],
      conditionNotes: ["condition notes"],
      notes: ["notes", "comments", "review"],
      tags: ["tags", "bookshelves", "genres"],
      dateAdded: ["date added", "entry date"],
      startDate: ["date started", "started"],
      finishDate: ["date read", "date finished", "finished"],
    },
  },
  goodreads: { label: "Goodreads", extends: "generic" },
  librarything: { label: "LibraryThing", extends: "generic" },
  libib: { label: "Libib", extends: "generic" },
  clz_books: { label: "CLZ Books", extends: "generic" },
  bookbuddy: { label: "BookBuddy", extends: "generic" },
};

function csvCell(value) {
  const text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csv(rows, columns) {
  return [
    columns.map(column => csvCell(column.label)).join(","),
    ...rows.map(row => columns.map(column => csvCell(row[column.key])).join(",")),
  ].join("\r\n");
}

function parseCsv(value) {
  const input = String(value || "");
  if (Buffer.byteLength(input, "utf8") > 10 * 1024 * 1024) {
    throw Object.assign(new Error("Import file is larger than 10 MB"), { status: 413 });
  }
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
    } else if (character === '"') {
      if (cell) throw Object.assign(new Error("CSV contains an unexpected quote"), { status: 400 });
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  if (quoted) throw Object.assign(new Error("CSV contains an unterminated quoted value"), { status: 400 });
  if (cell || row.length) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  const nonempty = rows.filter(candidate => candidate.some(value => value.trim()));
  if (nonempty.length < 2) throw Object.assign(new Error("CSV needs a header and at least one data row"), { status: 400 });
  const headers = nonempty[0].map((header, index) => header.trim() || `Column ${index + 1}`);
  if (headers.length > 300 || nonempty.length > 100_001) {
    throw Object.assign(new Error("CSV exceeds the 300-column or 100,000-row import limit"), { status: 413 });
  }
  return {
    headers,
    rows: nonempty.slice(1).map(values =>
      Object.fromEntries(headers.map((header, index) => [header, String(values[index] || "").trim()]))
    ),
  };
}

function normalizedHeader(value) {
  return String(value || "").trim().toLocaleLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function inferredMapping(headers, presetName) {
  const preset = presets[presetName] || presets.generic;
  const generic = presets[preset.extends || presetName] || presets.generic;
  const aliases = { ...presets.generic.aliases, ...(generic.aliases || {}), ...(preset.aliases || {}) };
  const byNormalized = new Map(headers.map(header => [normalizedHeader(header), header]));
  return Object.fromEntries(Object.entries(aliases).flatMap(([field, candidates]) => {
    const header = candidates.map(normalizedHeader).map(candidate => byNormalized.get(candidate)).find(Boolean);
    return header ? [[field, header]] : [];
  }));
}

function finiteNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(String(value).replace(/[$,]/g, ""));
  return Number.isFinite(number) ? number : null;
}

function importedStatus(value) {
  const normalized = normalizedHeader(value);
  if (["wishlist", "wish list", "to buy"].includes(normalized)) return "wishlist";
  if (["backlog", "to read", "to-read", "currently reading"].includes(normalized)) return "backlog";
  return "owned";
}

function importedReadStatus(value) {
  const normalized = normalizedHeader(value);
  if (["read", "finished"].includes(normalized)) return "read";
  if (["reading", "currently reading"].includes(normalized)) return "reading";
  if (["paused", "on hold"].includes(normalized)) return "paused";
  if (["did not finish", "dnf"].includes(normalized)) return "did_not_finish";
  if (["abandoned"].includes(normalized)) return "abandoned";
  if (["want to read", "to read"].includes(normalized)) return "want_to_read";
  return "unread";
}

function rowInput(row, mapping) {
  const mappedHeaders = new Set(Object.values(mapping).filter(Boolean));
  const value = field => mapping[field] ? row[mapping[field]] : "";
  const rawIsbn = value("isbn");
  const isbn = rawIsbn ? normalizeIsbn(rawIsbn) : "";
  const publication = value("publicationDate");
  const year = String(publication).match(/\b(\d{4})\b/)?.[1];
  const input = {
    title: value("title"),
    author: value("author") || "Unknown author",
    isbn: isbn || "",
    publisher: value("publisher"),
    publicationDate: /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(publication) ? publication : year || "",
    pageCount: finiteNumber(value("pageCount")),
    binding: value("binding"),
    status: importedStatus(value("status")),
    readStatus: mapping.readStatus || mapping.status
      ? importedReadStatus(value("readStatus") || value("status"))
      : undefined,
    rating: finiteNumber(value("rating")),
    series: value("series"),
    seriesNumber: value("seriesNumber"),
    conditionGrade: value("conditionGrade"),
    conditionNotes: value("conditionNotes"),
    notes: value("notes"),
    storageLocation: value("location"),
    formats: [normalizedHeader(value("binding")).includes("audio")
      ? "audiobook"
      : normalizedHeader(value("binding")).includes("ebook") || normalizedHeader(value("binding")).includes("kindle")
        ? "ebook"
        : "physical"],
    source: "manual",
    importedMetadata: Object.fromEntries(Object.entries(row).filter(([header, fieldValue]) =>
      !mappedHeaders.has(header) && fieldValue !== ""
    )),
  };
  return {
    input,
    readingSession: {
      startedAt: value("startDate") || null,
      finishedAt: value("finishDate") || null,
    },
    tags: value("tags").split(/[,;]/).map(tag => tag.trim()).filter(Boolean),
  };
}

export function importPresets() {
  return {
    presets: Object.entries(presets).map(([key, preset]) => ({
      key,
      label: preset.label,
    })),
  };
}

export async function previewImport(db, context, userId, input) {
  assertHouseholdAdmin(context);
  const parsed = parseCsv(input.csv);
  const preset = Object.hasOwn(presets, input.preset) ? input.preset : "generic";
  const inferred = inferredMapping(parsed.headers, preset);
  const mapping = { ...inferred, ...(input.mapping || {}) };
  if (!mapping.title) throw Object.assign(new Error("Map a CSV column to Title before continuing"), { status: 400 });
  const preview = parsed.rows.slice(0, 500).map((row, index) => {
    const imported = rowInput(row, mapping);
    const errors = [];
    if (!imported.input.title) errors.push("Title is required");
    if (row[mapping.isbn] && !imported.input.isbn) errors.push("ISBN checksum is invalid");
    const duplicates = imported.input.title
      ? duplicateWarnings(db, context, imported.input, userId).warnings.slice(0, 5)
      : [];
    return {
      row: index + 2,
      data: imported.input,
      readingSession: imported.readingSession,
      tags: imported.tags,
      unknownFields: imported.input.importedMetadata,
      errors,
      duplicateCount: duplicates.length,
      duplicates,
    };
  });
  await mkdir(importDirectory, { recursive: true });
  const filename = `.import-${randomBytes(16).toString("hex")}.csv`;
  const path = join(importDirectory, filename);
  await writeFile(path, String(input.csv), { flag: "wx", mode: 0o600 });
  const unknownHeaders = parsed.headers.filter(header => !new Set(Object.values(mapping)).has(header));
  const result = db.prepare(`
    INSERT INTO import_runs (
      household_id, requested_by, preset, source_filename, mapping,
      dry_run, status, report_path, unknown_fields
    ) VALUES (?, ?, ?, ?, ?, 1, 'previewed', ?, ?)
  `).run(
    context.household_id,
    userId,
    preset,
    basename(String(input.filename || "import.csv")).slice(0, 255),
    JSON.stringify(mapping),
    path,
    JSON.stringify(unknownHeaders),
  );
  return {
    runId: String(result.lastInsertRowid),
    preset,
    headers: parsed.headers,
    mapping,
    unknownHeaders,
    rowCount: parsed.rows.length,
    preview,
    truncatedPreview: parsed.rows.length > preview.length,
    canCommit: preview.every(row => !row.errors.length),
  };
}

export async function commitImport(db, context, userId, runId, options = {}) {
  assertHouseholdAdmin(context);
  const id = Number(runId);
  const run = db.prepare(`
    SELECT * FROM import_runs
    WHERE id = ? AND household_id = ? AND status = 'previewed' AND dry_run = 1
  `).get(id, context.household_id);
  if (!run || !run.report_path || !resolve(run.report_path).startsWith(resolve(importDirectory))) {
    throw Object.assign(new Error("Import preview not found"), { status: 404 });
  }
  const parsed = parseCsv(await readFile(run.report_path, "utf8"));
  const mapping = JSON.parse(run.mapping || "{}");
  const duplicateAction = ["add_another_copy", "cancel"].includes(options.duplicateAction)
    ? options.duplicateAction
    : "cancel";
  const created = [];
  const createdSessions = [];
  const results = [];
  const unknownRows = [];
  db.prepare("UPDATE import_runs SET status = 'running' WHERE id = ?").run(id);
  try {
    for (let index = 0; index < parsed.rows.length; index += 1) {
      const imported = rowInput(parsed.rows[index], mapping);
      if (Object.keys(imported.input.importedMetadata).length) {
        unknownRows.push({ row: index + 2, fields: imported.input.importedMetadata });
      }
      if (!imported.input.title) throw new Error(`Row ${index + 2}: title is required`);
      const duplicates = duplicateWarnings(db, context, imported.input, userId).warnings;
      if (duplicates.length && duplicateAction === "cancel") {
        results.push({ row: index + 2, state: "warning", reason: "Duplicate skipped" });
        continue;
      }
      const result = createCatalogItem(db, context, userId, imported.input);
      created.push(...result.created);
      const start = imported.readingSession.startedAt;
      const finish = imported.readingSession.finishedAt;
      if (start || finish) {
        const normalizedDate = value => {
          if (!value) return null;
          const parsedDate = new Date(value);
          return Number.isNaN(parsedDate.getTime()) ? null : parsedDate.toISOString().slice(0, 10);
        };
        const session = createReadingSession(db, context, userId, result.workId, {
          editionId: result.editionId,
          startedAt: normalizedDate(start),
          finishedAt: normalizedDate(finish),
          rating: imported.input.rating,
          formatUsed: imported.input.formats[0],
        });
        createdSessions.push(Number(session.id));
      }
      for (const tagName of imported.tags.slice(0, 100)) {
        const normalizedName = tagName.normalize("NFKD").replace(/\p{Mark}/gu, "").toLocaleLowerCase().trim();
        if (!normalizedName || normalizedName.length > 100) continue;
        let tag = db.prepare(`
          SELECT id FROM tags WHERE household_id = ? AND normalized_name = ?
        `).get(context.household_id, normalizedName);
        if (!tag) {
          tag = { id: Number(db.prepare(`
            INSERT INTO tags (household_id, name, normalized_name) VALUES (?, ?, ?)
          `).run(context.household_id, tagName.slice(0, 100), normalizedName).lastInsertRowid) };
        }
        db.prepare("INSERT OR IGNORE INTO work_tags (work_id, tag_id) VALUES (?, ?)").run(result.workId, tag.id);
      }
      results.push({ row: index + 2, state: "success", workId: String(result.workId), editionId: String(result.editionId) });
    }
    const reportPath = join(importDirectory, `import-report-${id}.json`);
    await writeFile(reportPath, JSON.stringify({
      runId: String(id),
      completedAt: new Date().toISOString(),
      results,
      unknownRows,
    }, null, 2), { mode: 0o600 });
    db.prepare(`
      UPDATE import_runs SET dry_run = 0, status = 'complete', report_path = ?,
        unknown_fields = ?, completed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(reportPath, JSON.stringify(unknownRows), id);
    return {
      runId: String(id),
      status: "complete",
      imported: results.filter(result => result.state === "success").length,
      skipped: results.filter(result => result.state === "warning").length,
      results,
    };
  } catch (error) {
    try {
      db.exec("BEGIN IMMEDIATE");
      for (const sessionId of createdSessions.reverse()) {
        db.prepare("DELETE FROM reading_sessions WHERE id = ? AND household_id = ?").run(sessionId, context.household_id);
      }
      for (const entity of created.reverse()) {
        if (entity.type === "copy") db.prepare("DELETE FROM copies WHERE id = ? AND household_id = ?").run(entity.id, context.household_id);
        if (entity.type === "list") db.prepare("DELETE FROM list_entries WHERE id = ? AND household_id = ?").run(entity.id, context.household_id);
      }
      db.exec("COMMIT");
    } catch {
      try { db.exec("ROLLBACK"); } catch {}
    }
    db.prepare(`
      UPDATE import_runs SET status = 'failed', completed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(id);
    throw Object.assign(new Error(`Import rolled back: ${error.message || error}`), { status: 400 });
  } finally {
    if (run.report_path !== db.prepare("SELECT report_path FROM import_runs WHERE id = ?").get(id)?.report_path) {
      try { await unlink(run.report_path); } catch {}
    }
  }
}

function catalogExportRows(db, householdId) {
  return db.prepare(`
    SELECT work.id AS work_id, edition.id AS edition_id, copy.id AS copy_id,
      work.title, work.subtitle, work.primary_author AS author,
      edition.isbn10, edition.isbn13, edition.publisher, edition.binding,
      edition.language, edition.publication_date, edition.page_count,
      edition.edition_label, copy.format, copy.condition_grade, copy.condition_notes,
      copy.purchase_date, copy.purchase_price_cents, copy.purchase_currency,
      copy.purchase_source, copy.custom_barcode, copy.copy_notes,
      COALESCE(owner.name, 'Household') AS owner,
      location.name AS location,
      copy.copy_status, copy.created_at
    FROM copies copy
    JOIN editions edition ON edition.id = copy.edition_id
    JOIN works work ON work.id = edition.work_id
    LEFT JOIN users owner ON owner.id = copy.owner_user_id
    LEFT JOIN locations location ON location.id = copy.location_id
    WHERE copy.household_id = ?
    ORDER BY work.title, edition.id, copy.id
  `).all(householdId);
}

export function exportCatalogCsv(db, context) {
  assertHouseholdAdmin(context);
  const rows = catalogExportRows(db, context.household_id).map(row => ({
    ...row,
    purchase_price: row.purchase_price_cents == null ? "" : row.purchase_price_cents / 100,
  }));
  const columns = [
    ["work_id", "Work ID"], ["edition_id", "Edition ID"], ["copy_id", "Copy ID"],
    ["title", "Title"], ["subtitle", "Subtitle"], ["author", "Author"],
    ["isbn10", "ISBN-10"], ["isbn13", "ISBN-13"], ["publisher", "Publisher"],
    ["binding", "Binding"], ["language", "Language"], ["publication_date", "Publication Date"],
    ["page_count", "Page Count"], ["edition_label", "Edition"], ["format", "Format"],
    ["owner", "Owner"], ["location", "Location"], ["condition_grade", "Condition"],
    ["condition_notes", "Condition Notes"], ["purchase_date", "Purchase Date"],
    ["purchase_price", "Purchase Price"], ["purchase_currency", "Currency"],
    ["purchase_source", "Purchase Source"], ["custom_barcode", "Custom Barcode"],
    ["copy_notes", "Copy Notes"], ["copy_status", "Copy Status"], ["created_at", "Date Added"],
  ].map(([key, label]) => ({ key, label }));
  return csv(rows, columns);
}

export function exportLoansCsv(db, context) {
  assertHouseholdAdmin(context);
  const rows = db.prepare(`
    SELECT loan.id, work.title, work.primary_author AS author, copy.id AS copy_id,
      COALESCE(member.name, external.display_name) AS borrower,
      CASE WHEN member.id IS NOT NULL THEN 'household_member' ELSE 'external' END AS borrower_type,
      loan.checkout_at, loan.due_at, loan.returned_at, loan.renewed_count,
      loan.loan_status, loan.notes
    FROM loans loan
    JOIN copies copy ON copy.id = loan.copy_id
    JOIN editions edition ON edition.id = copy.edition_id
    JOIN works work ON work.id = edition.work_id
    LEFT JOIN users member ON member.id = loan.borrower_user_id
    LEFT JOIN external_borrowers external ON external.id = loan.external_borrower_id
    WHERE loan.household_id = ? ORDER BY loan.checkout_at DESC
  `).all(context.household_id);
  const columns = Object.keys(rows[0] || {
    id: "", title: "", author: "", copy_id: "", borrower: "", borrower_type: "",
    checkout_at: "", due_at: "", returned_at: "", renewed_count: "", loan_status: "", notes: "",
  }).map(key => ({ key, label: key }));
  return csv(rows, columns);
}

const householdTables = [
  "households", "household_members", "locations", "works", "contributors",
  "work_contributors", "editions", "edition_provider_records", "series", "work_series",
  "copies", "copy_events", "external_borrowers", "loans", "loan_holds",
  "household_reading_statuses", "user_work_state", "reading_sessions",
  "reading_state_history", "list_entries", "tags", "work_tags",
  "custom_collections", "collection_works", "custom_field_definitions",
  "custom_field_values", "user_preferences", "metadata_provider_settings",
  "import_runs", "backup_records", "background_jobs", "audit_events",
];

function scopedRows(db, table, context, viewerUserId) {
  const householdId = context.household_id;
  const direct = new Set([
    "households", "household_members", "locations", "works", "contributors", "editions",
    "series", "copies", "external_borrowers", "loans", "loan_holds",
    "household_reading_statuses", "reading_sessions", "list_entries", "tags",
    "custom_collections", "custom_field_definitions", "metadata_provider_settings",
    "import_runs", "background_jobs", "audit_events",
  ]);
  let rows;
  if (table === "households") {
    rows = db.prepare("SELECT * FROM households WHERE id = ?").all(householdId);
  } else if (direct.has(table)) {
    rows = db.prepare(`SELECT * FROM ${table} WHERE household_id = ?`).all(householdId);
  }
  const queries = {
    work_contributors: "SELECT value.* FROM work_contributors value JOIN works ON works.id = value.work_id WHERE works.household_id = ?",
    edition_provider_records: "SELECT value.* FROM edition_provider_records value JOIN editions ON editions.id = value.edition_id WHERE editions.household_id = ?",
    work_series: "SELECT value.* FROM work_series value JOIN works ON works.id = value.work_id WHERE works.household_id = ?",
    copy_events: "SELECT value.* FROM copy_events value JOIN copies ON copies.id = value.copy_id WHERE copies.household_id = ?",
    user_work_state: "SELECT value.* FROM user_work_state value JOIN works ON works.id = value.work_id WHERE works.household_id = ?",
    reading_state_history: "SELECT value.* FROM reading_state_history value JOIN works ON works.id = value.work_id WHERE works.household_id = ?",
    work_tags: "SELECT value.* FROM work_tags value JOIN works ON works.id = value.work_id WHERE works.household_id = ?",
    collection_works: "SELECT value.* FROM collection_works value JOIN custom_collections collection ON collection.id = value.collection_id WHERE collection.household_id = ?",
    custom_field_values: `SELECT value.* FROM custom_field_values value
      JOIN custom_field_definitions definition ON definition.id = value.field_id WHERE definition.household_id = ?`,
    user_preferences: `SELECT value.* FROM user_preferences value
      JOIN household_members member ON member.user_id = value.user_id WHERE member.household_id = ?`,
    backup_records: "SELECT * FROM backup_records WHERE household_id = ?",
  };
  if (!rows) rows = queries[table] ? db.prepare(queries[table]).all(householdId) : [];
  if (["user_work_state", "reading_sessions"].includes(table)) {
    return rows.map(row => {
      const safe = { ...row };
      delete safe.private_notes;
      return safe;
    });
  }
  if (table === "list_entries") {
    return rows.filter(row => !(
      row.gift_private
      && row.intended_recipient_id === viewerUserId
      && row.requested_by !== viewerUserId
    ));
  }
  return rows;
}

export function exportHouseholdJson(db, context, viewerUserId) {
  assertHouseholdAdmin(context);
  return {
    application: "Book Vault",
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    householdId: String(context.household_id),
    data: Object.fromEntries(householdTables.map(table => [table, scopedRows(db, table, context, viewerUserId)])),
  };
}

export function exportUserReadingJson(db, context, userId) {
  const state = db.prepare(`
    SELECT state.*, work.title, work.primary_author
    FROM user_work_state state JOIN works ON works.id = state.work_id
    WHERE state.user_id = ? AND works.household_id = ?
  `).all(userId, context.household_id);
  const sessions = db.prepare(`
    SELECT session.*, work.title, work.primary_author
    FROM reading_sessions session JOIN works ON works.id = session.work_id
    WHERE session.user_id = ? AND session.household_id = ?
  `).all(userId, context.household_id);
  const lists = db.prepare(`
    SELECT entry.*, work.title, work.primary_author
    FROM list_entries entry JOIN works ON works.id = entry.work_id
    WHERE entry.requested_by = ? AND entry.household_id = ?
  `).all(userId, context.household_id);
  return {
    application: "Book Vault",
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    userId: String(userId),
    readingState: state,
    readingSessions: sessions,
    lists,
  };
}
