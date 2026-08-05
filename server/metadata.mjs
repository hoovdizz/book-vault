import { createHash } from "node:crypto";
import { lookupBooks } from "./book-search.mjs";
import { assertHouseholdAdmin } from "./households.mjs";

const knownProviders = new Set(["google_books", "open_library", "manual"]);

function parseJson(value, fallback) {
  try { return JSON.parse(value || JSON.stringify(fallback)); } catch { return fallback; }
}

export function providerSettings(db, householdId) {
  const settings = db.prepare(`
    SELECT provider, enabled, priority, settings
    FROM metadata_provider_settings
    WHERE household_id = ?
    ORDER BY priority, provider
  `).all(householdId).map(row => ({
    provider: row.provider,
    enabled: Boolean(row.enabled),
    priority: row.priority,
    settings: parseJson(row.settings, {}),
  }));
  return {
    providers: settings,
    lookupOrder: settings.filter(row => row.enabled && row.provider !== "manual").map(row => row.provider),
    manualEntry: true,
  };
}

export function updateProviderSettings(db, context, input) {
  assertHouseholdAdmin(context);
  if (!Array.isArray(input.providers) || input.providers.length !== 3) {
    throw Object.assign(new Error("Configure Google Books, Open Library, and manual entry"), { status: 400 });
  }
  const normalized = input.providers.map((provider, index) => ({
    provider: String(provider.provider || ""),
    enabled: provider.provider === "manual" ? true : provider.enabled !== false,
    priority: index,
    settings: provider.settings && typeof provider.settings === "object" ? provider.settings : {},
  }));
  if (new Set(normalized.map(item => item.provider)).size !== 3
    || normalized.some(item => !knownProviders.has(item.provider))) {
    throw Object.assign(new Error("Metadata provider list is invalid"), { status: 400 });
  }
  try {
    db.exec("BEGIN IMMEDIATE");
    const upsert = db.prepare(`
      INSERT INTO metadata_provider_settings (household_id, provider, enabled, priority, settings)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(household_id, provider) DO UPDATE SET
        enabled = excluded.enabled, priority = excluded.priority, settings = excluded.settings
    `);
    for (const provider of normalized) {
      upsert.run(
        context.household_id,
        provider.provider,
        provider.enabled ? 1 : 0,
        provider.priority,
        JSON.stringify(provider.settings),
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
  return providerSettings(db, context.household_id);
}

function cacheKey(householdId, query, type, order) {
  return createHash("sha256")
    .update(JSON.stringify({ householdId, query: query.toLocaleLowerCase(), type, order }))
    .digest("hex");
}

export async function configuredLookup(db, context, query, type, options = {}) {
  const config = providerSettings(db, context.household_id);
  const order = config.lookupOrder;
  const key = cacheKey(context.household_id, query, type, order);
  const cached = db.prepare(`
    SELECT response_json FROM metadata_cache
    WHERE cache_key = ? AND expires_at > CURRENT_TIMESTAMP
  `).get(key);
  if (cached) return { ...parseJson(cached.response_json, {}), cached: true };
  const result = await lookupBooks(query, type, {
    ...options,
    providerOrder: order,
    enabledProviders: order,
  });
  db.prepare(`
    INSERT INTO metadata_cache (cache_key, provider, response_json, expires_at)
    VALUES (?, 'configured', ?, datetime('now', '+24 hours'))
    ON CONFLICT(cache_key) DO UPDATE SET
      response_json = excluded.response_json,
      expires_at = excluded.expires_at,
      created_at = CURRENT_TIMESTAMP
  `).run(key, JSON.stringify(result));
  db.prepare("DELETE FROM metadata_cache WHERE expires_at <= CURRENT_TIMESTAMP").run();
  return { ...result, cached: false };
}

export function metadataQuality(db, context) {
  const householdId = context.household_id;
  const totals = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM works WHERE household_id = ? AND archived_at IS NULL) AS works,
      (SELECT COUNT(*) FROM editions WHERE household_id = ? AND archived_at IS NULL) AS editions,
      (SELECT COUNT(*) FROM editions WHERE household_id = ? AND archived_at IS NULL
        AND cover_path IS NULL AND cover_url IS NULL) AS missing_covers,
      (SELECT COUNT(*) FROM editions WHERE household_id = ? AND archived_at IS NULL
        AND isbn10 IS NULL AND isbn13 IS NULL) AS missing_isbns,
      (SELECT COUNT(*) FROM works WHERE household_id = ? AND archived_at IS NULL
        AND trim(primary_author) IN ('', 'Unknown author')) AS missing_authors,
      (SELECT COUNT(*) FROM editions WHERE household_id = ? AND archived_at IS NULL
        AND publication_date IS NOT NULL
        AND (
          CAST(substr(publication_date, 1, 4) AS INTEGER) < 1000
          OR CAST(substr(publication_date, 1, 4) AS INTEGER) > CAST(strftime('%Y', 'now') AS INTEGER) + 5
        )) AS suspicious_dates,
      (SELECT COUNT(*) FROM work_series link
        JOIN series ON series.id = link.series_id
        WHERE series.household_id = ? AND link.volume_label IS NULL AND link.reading_order IS NULL
      ) AS unknown_series_numbers
  `).get(householdId, householdId, householdId, householdId, householdId, householdId, householdId);
  const duplicateEditions = db.prepare(`
    SELECT work.title, work.primary_author, edition.isbn13, COUNT(*) AS count,
      group_concat(edition.id) AS edition_ids
    FROM editions edition
    JOIN works work ON work.id = edition.work_id
    WHERE edition.household_id = ? AND edition.archived_at IS NULL
    GROUP BY work.normalized_title, work.normalized_author,
      COALESCE(edition.isbn13, edition.legacy_fingerprint)
    HAVING COUNT(*) > 1
    ORDER BY count DESC, work.title LIMIT 200
  `).all(householdId).map(row => ({
    title: row.title,
    author: row.primary_author,
    isbn13: row.isbn13 || null,
    count: row.count,
    editionIds: String(row.edition_ids).split(","),
  }));
  const incomplete = db.prepare(`
    SELECT work.id AS work_id, work.title, work.primary_author, edition.id AS edition_id,
      edition.isbn13, edition.cover_url, edition.cover_path, edition.publication_date,
      edition.page_count
    FROM works work
    LEFT JOIN editions edition ON edition.work_id = work.id AND edition.archived_at IS NULL
    WHERE work.household_id = ? AND work.archived_at IS NULL
      AND (
        trim(work.primary_author) IN ('', 'Unknown author')
        OR edition.id IS NULL
        OR (edition.isbn10 IS NULL AND edition.isbn13 IS NULL)
        OR (edition.cover_url IS NULL AND edition.cover_path IS NULL)
      )
    ORDER BY work.title LIMIT 500
  `).all(householdId).map(row => ({
    workId: String(row.work_id),
    editionId: row.edition_id ? String(row.edition_id) : null,
    title: row.title,
    author: row.primary_author,
    missing: [
      !row.primary_author || row.primary_author === "Unknown author" ? "author" : null,
      !row.edition_id ? "edition" : null,
      row.edition_id && !row.isbn13 ? "isbn" : null,
      row.edition_id && !row.cover_url && !row.cover_path ? "cover" : null,
    ].filter(Boolean),
  }));
  return {
    totals: {
      works: totals.works,
      editions: totals.editions,
      missingCovers: totals.missing_covers,
      missingIsbns: totals.missing_isbns,
      missingAuthors: totals.missing_authors,
      suspiciousDates: totals.suspicious_dates,
      unknownSeriesNumbers: totals.unknown_series_numbers,
      duplicateEditions: duplicateEditions.length,
      incompleteRecords: incomplete.length,
    },
    duplicateEditions,
    incomplete,
  };
}

export async function refreshEditionMetadata(db, context, editionId, options = {}) {
  assertHouseholdAdmin(context);
  const id = Number(editionId);
  const edition = Number.isSafeInteger(id) && db.prepare(`
    SELECT edition.*, work.title, work.primary_author
    FROM editions edition JOIN works work ON work.id = edition.work_id
    WHERE edition.id = ? AND edition.household_id = ? AND edition.archived_at IS NULL
  `).get(id, context.household_id);
  if (!edition) throw Object.assign(new Error("Edition not found"), { status: 404 });
  const query = edition.isbn13 || edition.isbn10 || edition.title;
  const type = edition.isbn13 || edition.isbn10 ? "isbn" : "title";
  const lookup = await configuredLookup(db, context, query, type, options);
  const match = lookup.results?.[0];
  if (!match) return { editionId: String(id), refreshed: false, reason: "No provider match" };
  const overrides = new Set(parseJson(edition.manual_overrides, []));
  const changes = {};
  const setIfAllowed = (field, column, value) => {
    if (value != null && value !== "" && !overrides.has(field)) changes[column] = value;
  };
  setIfAllowed("publisher", "publisher", match.publisher);
  setIfAllowed("pageCount", "page_count", match.pageCount);
  setIfAllowed("publicationDate", "publication_date", match.publicationDate || match.publishedYear);
  setIfAllowed("coverUrl", "cover_url", match.coverUrl);
  if (!Object.keys(changes).length) {
    db.prepare("UPDATE editions SET last_refresh_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
    return { editionId: String(id), refreshed: true, changedFields: [] };
  }
  const assignments = Object.keys(changes).map(column => `${column} = ?`).join(", ");
  db.prepare(`
    UPDATE editions SET ${assignments}, last_refresh_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(...Object.values(changes), id);
  db.prepare(`
    INSERT OR IGNORE INTO edition_provider_records (
      edition_id, provider, provider_record_id, original_isbn, raw_metadata
    ) VALUES (?, ?, ?, ?, ?)
  `).run(id, match.source, match.sourceId || null, query, JSON.stringify(match));
  return { editionId: String(id), refreshed: true, changedFields: Object.keys(changes), coverUrl: changes.cover_url || null };
}
