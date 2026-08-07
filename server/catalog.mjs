import { normalizeIsbn } from "./book-search.mjs";
import { canEditInventory, canEditPersonalReading, isHouseholdAdmin } from "./households.mjs";
import { assertLocationInHousehold, locationInventory } from "./locations.mjs";

function text(value, max, required = false) {
  const result = String(value || "").trim();
  if ((required && !result) || result.length > max) {
    throw Object.assign(new Error(required ? "A required catalog field is missing" : "A catalog field is too long"), { status: 400 });
  }
  return result;
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

function isbn13From10(isbn10) {
  const base = `978${isbn10.slice(0, 9)}`;
  const sum = [...base].reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 3 : 1), 0);
  return `${base}${(10 - (sum % 10)) % 10}`;
}

function isbn10From13(isbn13) {
  if (!/^978\d{10}$/.test(isbn13)) return null;
  const base = isbn13.slice(3, 12);
  const sum = [...base].reduce((total, digit, index) => total + Number(digit) * (10 - index), 0);
  const check = (11 - (sum % 11)) % 11;
  return `${base}${check === 10 ? "X" : check}`;
}

function isbnPair(value) {
  const normalized = normalizeIsbn(value);
  if (!normalized) return { isbn10: null, isbn13: null, originalIsbn: text(value, 30) || null };
  if (normalized.length === 10) {
    return { isbn10: normalized, isbn13: isbn13From10(normalized), originalIsbn: text(value, 30) || normalized };
  }
  return { isbn10: isbn10From13(normalized), isbn13: normalized, originalIsbn: text(value, 30) || normalized };
}

function parseArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function json(value, fallback) {
  try {
    return JSON.parse(value || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

function validDate(value, { allowDateTime = false } = {}) {
  if (value == null || value === "") return null;
  const candidate = String(value);
  const pattern = allowDateTime ? /^\d{4}-\d{2}-\d{2}(?:[T ][0-9:.+-Z]+)?$/ : /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/;
  if (!pattern.test(candidate) || Number.isNaN(Date.parse(candidate.length === 4 ? `${candidate}-01-01` : candidate))) {
    throw Object.assign(new Error("A catalog date is invalid"), { status: 400 });
  }
  return candidate;
}

function currentSeries(db, workId) {
  return db.prepare(`
    SELECT series.id, series.name, link.volume_label, link.volume_sort,
      link.reading_order, link.series_role, link.included_volumes
    FROM work_series link
    JOIN series ON series.id = link.series_id
    WHERE link.work_id = ?
    ORDER BY CASE link.series_role WHEN 'main' THEN 0 ELSE 1 END, link.reading_order, series.name
    LIMIT 1
  `).get(workId);
}

function ensureSeries(db, householdId, workId, input) {
  const name = text(input.series, 150);
  if (!name) return;
  const normalized = normalizedText(name);
  let series = db.prepare(`
    SELECT id FROM series WHERE household_id = ? AND normalized_name = ? ORDER BY id LIMIT 1
  `).get(householdId, normalized);
  if (!series) {
    series = { id: Number(db.prepare(`
      INSERT INTO series (household_id, name, normalized_name) VALUES (?, ?, ?)
    `).run(householdId, name, normalized).lastInsertRowid) };
  }
  const volumeLabel = text(input.seriesNumber, 30);
  const numeric = Number(volumeLabel);
  const volumeSort = Number.isFinite(numeric) ? numeric : null;
  const readingOrderInput = input.readingOrder == null || input.readingOrder === "" ? volumeSort : Number(input.readingOrder);
  const readingOrder = Number.isFinite(readingOrderInput) ? readingOrderInput : null;
  const role = ["main", "prequel", "novella", "omnibus", "companion"].includes(input.seriesRole)
    ? input.seriesRole
    : "main";
  const includedVolumes = Array.isArray(input.includedVolumes)
    ? input.includedVolumes.map(value => text(value, 30)).filter(Boolean).slice(0, 50)
    : [];
  db.prepare(`
    INSERT INTO work_series (
      work_id, series_id, volume_label, volume_sort, reading_order, series_role, included_volumes
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(work_id, series_id, series_role, volume_label) DO UPDATE SET
      volume_sort = excluded.volume_sort,
      reading_order = excluded.reading_order,
      included_volumes = excluded.included_volumes
  `).run(workId, series.id, volumeLabel || null, volumeSort, readingOrder, role, JSON.stringify(includedVolumes));
}

function ensureWork(db, householdId, userId, input, editionMatch) {
  if (editionMatch) return db.prepare("SELECT * FROM works WHERE id = ?").get(editionMatch.work_id);
  const title = text(input.title, 300, true);
  const author = text(input.author, 300, true);
  const normalizedTitle = normalizedText(title);
  const normalizedAuthor = normalizedText(author);
  let work = db.prepare(`
    SELECT * FROM works
    WHERE household_id = ? AND normalized_title = ? AND normalized_author = ?
      AND archived_at IS NULL
    ORDER BY id LIMIT 1
  `).get(householdId, normalizedTitle, normalizedAuthor);
  if (work || input.forceNewWork === true) {
    if (work && input.forceNewWork !== true) return work;
  }
  const result = db.prepare(`
    INSERT INTO works (
      household_id, title, subtitle, normalized_title, primary_author,
      normalized_author, description, original_language, metadata_quality, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unreviewed', ?)
  `).run(
    householdId,
    title,
    text(input.subtitle, 300) || null,
    normalizedTitle,
    author,
    normalizedAuthor,
    text(input.description, 5000) || null,
    text(input.originalLanguage, 50) || null,
    userId,
  );
  work = db.prepare("SELECT * FROM works WHERE id = ?").get(result.lastInsertRowid);
  const normalizedAuthorName = normalizedText(author);
  let contributor = db.prepare(`
    SELECT id FROM contributors WHERE household_id = ? AND normalized_name = ? ORDER BY id LIMIT 1
  `).get(householdId, normalizedAuthorName);
  if (!contributor) {
    contributor = { id: Number(db.prepare(`
      INSERT INTO contributors (household_id, name, normalized_name) VALUES (?, ?, ?)
    `).run(householdId, author, normalizedAuthorName).lastInsertRowid) };
  }
  db.prepare(`
    INSERT OR IGNORE INTO work_contributors (work_id, contributor_id, contribution_role, sort_order)
    VALUES (?, ?, 'author', 0)
  `).run(work.id, contributor.id);
  return work;
}

function existingEdition(db, householdId, input, pair) {
  if (input.forceNewEdition === true) return null;
  if (pair.isbn13) {
    const edition = db.prepare(`
      SELECT * FROM editions WHERE household_id = ? AND isbn13 = ? AND archived_at IS NULL
      ORDER BY id LIMIT 1
    `).get(householdId, pair.isbn13);
    if (edition) return edition;
  }
  if (pair.isbn10) {
    const edition = db.prepare(`
      SELECT * FROM editions WHERE household_id = ? AND isbn10 = ? AND archived_at IS NULL
      ORDER BY id LIMIT 1
    `).get(householdId, pair.isbn10);
    if (edition) return edition;
  }
  const provider = ["google_books", "open_library", "manual"].includes(input.source) ? input.source : "manual";
  const sourceId = text(input.sourceId, 100);
  if (sourceId && provider !== "manual") {
    return db.prepare(`
      SELECT * FROM editions
      WHERE household_id = ? AND provider = ? AND provider_record_id = ? AND archived_at IS NULL
      ORDER BY id LIMIT 1
    `).get(householdId, provider, sourceId) || null;
  }
  return null;
}

function ensureEdition(db, householdId, work, input, pair, editionMatch) {
  if (editionMatch) return editionMatch;
  const provider = ["google_books", "open_library"].includes(input.source) ? input.source : "manual";
  const publicationDate = input.publicationDate
    ? validDate(input.publicationDate)
    : input.publishedYear ? validDate(String(input.publishedYear)) : null;
  const pageCount = input.pageCount === "" || input.pageCount == null ? null : Number(input.pageCount);
  if (pageCount != null && (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 100000)) {
    throw Object.assign(new Error("Page count must be a positive whole number"), { status: 400 });
  }
  const provenance = {};
  const importantFields = ["isbn", "publisher", "binding", "language", "publicationDate", "coverUrl", "pageCount"];
  for (const field of importantFields) {
    if (input[field] != null && input[field] !== "") provenance[field] = provider;
  }
  const manualOverrides = Array.isArray(input.manualOverrides)
    ? [...new Set(input.manualOverrides.map(value => text(value, 50)).filter(Boolean))].slice(0, 50)
    : provider === "manual" ? importantFields : [];
  const result = db.prepare(`
    INSERT INTO editions (
      household_id, work_id, isbn10, isbn13, original_isbn, publisher, binding,
      media_format, language, publication_date, page_count, edition_label, cover_url,
      cover_options, provider, provider_record_id, lookup_date, field_provenance,
      manual_overrides, legacy_fingerprint
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?)
  `).run(
    householdId,
    work.id,
    pair.isbn10,
    pair.isbn13,
    pair.originalIsbn,
    text(input.publisher, 200) || null,
    text(input.binding, 50) || null,
    text(input.mediaFormat, 50) || null,
    text(input.language, 50) || null,
    publicationDate,
    pageCount,
    text(input.edition, 150) || null,
    text(input.coverUrl, 2000) || null,
    JSON.stringify(Array.isArray(input.coverOptions) ? input.coverOptions.slice(0, 20) : []),
    provider,
    text(input.sourceId, 100) || null,
    JSON.stringify(provenance),
    JSON.stringify(manualOverrides),
    `${normalizedText(input.publisher)}|${publicationDate || ""}|${input.binding || ""}|${normalizedText(input.edition)}`,
  );
  const edition = db.prepare("SELECT * FROM editions WHERE id = ?").get(result.lastInsertRowid);
  if (provider !== "manual") {
    db.prepare(`
      INSERT OR IGNORE INTO edition_provider_records (
        edition_id, provider, provider_record_id, original_isbn
      ) VALUES (?, ?, ?, ?)
    `).run(edition.id, provider, edition.provider_record_id, pair.originalIsbn);
  }
  return edition;
}

function validateCopy(db, context, userId, input, format) {
  if (!["physical", "ebook", "audiobook"].includes(format)) {
    throw Object.assign(new Error("Invalid copy format"), { status: 400 });
  }
  let ownerUserId;
  if (input.householdOwned === true || input.ownerUserId === null) {
    if (!isHouseholdAdmin(context) && input.existingOwnerUserId !== null) {
      throw Object.assign(new Error("Only a household administrator can add an unassigned household copy"), { status: 403 });
    }
    ownerUserId = null;
  } else {
    ownerUserId = input.ownerUserId == null ? userId : Number(input.ownerUserId);
    if (!Number.isSafeInteger(ownerUserId)) throw Object.assign(new Error("Invalid copy owner"), { status: 400 });
    if (ownerUserId !== userId && !isHouseholdAdmin(context)
      && Number(input.existingOwnerUserId) !== ownerUserId) {
      throw Object.assign(new Error("Only a household administrator can assign a copy to another member"), { status: 403 });
    }
    if (!db.prepare(`
      SELECT 1 FROM household_members WHERE household_id = ? AND user_id = ? AND disabled = 0
    `).get(context.household_id, ownerUserId)) {
      throw Object.assign(new Error("Copy owner must be an active household member"), { status: 400 });
    }
  }
  const locationId = input.locationId == null || input.locationId === "" ? null : Number(input.locationId);
  if (locationId != null) assertLocationInHousehold(db, context.household_id, locationId, { allowArchived: false });
  const purchasePrice = input.purchasePrice === "" || input.purchasePrice == null ? null : Number(input.purchasePrice);
  if (purchasePrice != null && (!Number.isFinite(purchasePrice) || purchasePrice < 0 || purchasePrice > 1000000)) {
    throw Object.assign(new Error("Invalid purchase price"), { status: 400 });
  }
  return {
    ownerUserId,
    locationId: format === "physical" ? locationId : null,
    conditionGrade: format === "physical" ? text(input.conditionGrade, 30) || null : null,
    conditionNotes: format === "physical" ? text(input.conditionNotes, 2000) || null : null,
    purchaseDate: validDate(input.purchaseDate),
    purchasePriceCents: purchasePrice == null ? null : Math.round(purchasePrice * 100),
    purchaseCurrency: text(input.purchaseCurrency || "USD", 3).toUpperCase(),
    purchaseSource: text(input.purchaseSource, 150) || null,
    customBarcode: text(input.customBarcode, 100) || null,
    copyNotes: text(input.copyNotes, 2000) || null,
  };
}

function setReadingState(db, householdId, userId, workId, editionId, input) {
  if (!input.readStatus && input.rating == null && input.favorite == null
    && input.privateNotes == null && input.householdNotes == null) return;
  const status = text(input.readStatus || "unread", 40);
  if (!db.prepare(`
    SELECT 1 FROM household_reading_statuses
    WHERE household_id = ? AND status_key = ? AND enabled = 1
  `).get(householdId, status)) {
    throw Object.assign(new Error("That reading status is not enabled for this household"), { status: 400 });
  }
  const rating = input.rating === "" || input.rating == null ? null : Number(input.rating);
  if (rating != null && (!Number.isFinite(rating) || rating < 0 || rating > 10)) {
    throw Object.assign(new Error("Rating must be between 0 and 10"), { status: 400 });
  }
  db.prepare(`
    INSERT INTO user_work_state (
      user_id, work_id, edition_id, status_key, rating, favorite,
      private_notes, household_notes, preferred_formats, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, work_id) DO UPDATE SET
      edition_id = excluded.edition_id,
      status_key = excluded.status_key,
      rating = COALESCE(excluded.rating, user_work_state.rating),
      favorite = excluded.favorite,
      private_notes = COALESCE(excluded.private_notes, user_work_state.private_notes),
      household_notes = COALESCE(excluded.household_notes, user_work_state.household_notes),
      preferred_formats = excluded.preferred_formats,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    userId,
    workId,
    editionId,
    status,
    rating,
    input.favorite === true ? 1 : 0,
    input.privateNotes == null ? null : text(input.privateNotes, 5000),
    input.householdNotes == null ? null : text(input.householdNotes, 5000),
    JSON.stringify(Array.isArray(input.preferredFormats) ? input.preferredFormats.slice(0, 3) : []),
  );
}

export function createCatalogItem(db, context, userId, input) {
  const requestedStatus = input.status || "owned";
  if (!canEditPersonalReading(context)) {
    throw Object.assign(new Error("This household role cannot add catalog records"), { status: 403 });
  }
  if (!canEditInventory(context) && requestedStatus === "owned") {
    throw Object.assign(new Error("This household role cannot add owned copies"), { status: 403 });
  }
  const pair = isbnPair(input.isbn);
  if (input.isbn && !pair.isbn10 && !pair.isbn13) {
    throw Object.assign(new Error("ISBN must be a valid ISBN-10 or ISBN-13"), { status: 400 });
  }
  const editionMatch = existingEdition(db, context.household_id, input, pair);
  let result;
  try {
    db.exec("BEGIN IMMEDIATE");
    const work = ensureWork(db, context.household_id, userId, input, editionMatch);
    const edition = ensureEdition(db, context.household_id, work, input, pair, editionMatch);
    ensureSeries(db, context.household_id, work.id, input);
    if (Array.isArray(input.tags) || text(input.genre, 100)) {
      replaceWorkTags(db, context.household_id, work.id, catalogTags(input));
    }
    if (text(input.collection, 150)) {
      linkWorkCollection(db, context.household_id, userId, work.id, input.collection);
    }
    setReadingState(db, context.household_id, userId, work.id, edition.id, input);
    const created = [];
    if (requestedStatus === "owned") {
      const requestedFormats = Array.isArray(input.formats) && input.formats.length ? input.formats : ["physical"];
      const formats = [...new Set(requestedFormats)];
      const copyCount = input.copyCount == null ? 1 : Number(input.copyCount);
      if (!Number.isInteger(copyCount) || copyCount < 1 || copyCount > 100) {
        throw Object.assign(new Error("Copy count must be between 1 and 100"), { status: 400 });
      }
      for (const format of formats) {
        for (let index = 0; index < copyCount; index += 1) {
          const copyInput = Array.isArray(input.copies) ? { ...input, ...(input.copies[index] || {}) } : input;
          const copy = validateCopy(db, context, userId, copyInput, format);
          const inserted = db.prepare(`
            INSERT INTO copies (
              household_id, edition_id, owner_user_id, format, location_id,
              condition_grade, condition_notes, purchase_date, purchase_price_cents,
              purchase_currency, purchase_source, custom_barcode, copy_notes,
              copy_status, added_by, acquired_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
          `).run(
            context.household_id,
            edition.id,
            copy.ownerUserId,
            format,
            copy.locationId,
            copy.conditionGrade,
            copy.conditionNotes,
            copy.purchaseDate,
            copy.purchasePriceCents,
            copy.purchaseCurrency,
            copy.purchaseSource,
            copy.customBarcode,
            copy.copyNotes,
            userId,
            input.acquiredAt ? validDate(input.acquiredAt) : new Date().toISOString().slice(0, 10),
          );
          const copyId = Number(inserted.lastInsertRowid);
          db.prepare(`
            INSERT INTO copy_events (copy_id, actor_user_id, event_type, to_location_id, details)
            VALUES (?, ?, 'added', ?, ?)
          `).run(copyId, userId, copy.locationId, JSON.stringify({ format }));
          created.push({ type: "copy", id: copyId });
        }
      }
      if (input.moveWishlistToOwned === true) {
        db.prepare(`
          UPDATE list_entries SET
            purchase_state = 'purchased',
            archived_at = CURRENT_TIMESTAMP
          WHERE household_id = ? AND requested_by = ?
            AND list_type = 'wishlist' AND archived_at IS NULL
            AND (
              edition_id = ?
              OR (edition_id IS NULL AND work_id = ?)
            )
        `).run(context.household_id, userId, edition.id, work.id);
      }
    } else {
      const listType = input.status === "backlog" ? "backlog" : "wishlist";
      const scope = input.scope === "household" ? "household" : "personal";
      const expectedPrice = input.expectedPrice === "" || input.expectedPrice == null ? null : Number(input.expectedPrice);
      if (expectedPrice != null && (!Number.isFinite(expectedPrice) || expectedPrice < 0 || expectedPrice > 1000000)) {
        throw Object.assign(new Error("Expected price is invalid"), { status: 400 });
      }
      const intendedRecipientId = input.intendedRecipientId === "" || input.intendedRecipientId == null
        ? null
        : Number(input.intendedRecipientId);
      if (intendedRecipientId !== null && (
        !Number.isSafeInteger(intendedRecipientId)
        || !db.prepare(`
          SELECT 1 FROM household_members member
          JOIN users user ON user.id = member.user_id
          WHERE member.household_id = ? AND member.user_id = ? AND user.disabled = 0
        `).get(context.household_id, intendedRecipientId)
      )) {
        throw Object.assign(new Error("The intended recipient must be an active member of this household"), { status: 400 });
      }
      if (input.giftPrivate === true && intendedRecipientId === null) {
        throw Object.assign(new Error("A private gift needs an intended household recipient"), { status: 400 });
      }
      const inserted = db.prepare(`
        INSERT INTO list_entries (
          household_id, requested_by, work_id, edition_id, list_type, scope,
          desired_edition, preferred_formats, priority, expected_price_cents,
          expected_currency, notes, gift_private, intended_recipient_id, purchase_state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'wanted')
      `).run(
        context.household_id,
        userId,
        work.id,
        edition.id,
        listType,
        scope,
        text(input.desiredEdition || input.edition, 150) || null,
        JSON.stringify(Array.isArray(input.formats) ? input.formats.slice(0, 3) : []),
        ["low", "medium", "high"].includes(input.priority) ? input.priority : null,
        expectedPrice == null ? null : Math.round(expectedPrice * 100),
        text(input.expectedCurrency || "USD", 3).toUpperCase(),
        text(input.notes, 3000) || null,
        input.giftPrivate === true ? 1 : 0,
        intendedRecipientId,
      );
      created.push({ type: "list", id: Number(inserted.lastInsertRowid) });
    }
    db.exec("COMMIT");
    result = { workId: work.id, editionId: edition.id, created };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    if (String(error).includes("idx_copies_barcode")) {
      throw Object.assign(new Error("That custom barcode is already assigned to another copy"), { status: 409 });
    }
    if (String(error).includes("idx_editions_household_isbn")) {
      throw Object.assign(new Error("That ISBN already identifies an edition in this household. Add another copy, or choose an edition with a different ISBN."), { status: 409 });
    }
    throw error;
  }
  return result;
}

const itemRowsSql = `
  SELECT
    'copy' AS entity_type,
    copy.id AS entity_id,
    work.id AS work_id,
    edition.id AS edition_id,
    work.title,
    work.subtitle,
    work.primary_author,
    work.description,
    (SELECT json_group_array(tag.name) FROM work_tags wt JOIN tags tag ON tag.id = wt.tag_id WHERE wt.work_id = work.id) AS tags_json,
    edition.isbn10,
    edition.isbn13,
    edition.publisher,
    edition.binding,
    edition.language,
    edition.publication_date,
    edition.page_count,
    edition.edition_label,
    edition.cover_url,
    edition.cover_path,
    edition.cover_options,
    edition.estimated_value_cents,
    edition.estimated_value_currency,
    edition.provider,
    edition.provider_record_id,
    copy.owner_user_id,
    owner.name AS owner_name,
    copy.format,
    json_array(copy.format) AS formats_json,
    copy.location_id,
    location.name AS location_name,
    copy.condition_grade,
    copy.condition_notes,
    copy.purchase_date,
    copy.purchase_price_cents,
    copy.purchase_currency,
    copy.purchase_source,
    copy.custom_barcode,
    copy.copy_notes,
    copy.copy_status,
    'owned' AS item_status,
    copy.created_at AS date_added,
    reading.status_key AS read_status,
    reading.rating,
    reading.favorite,
    reading.private_notes,
    reading.household_notes,
    NULL AS list_scope,
    NULL AS priority,
    NULL AS expected_price_cents,
    NULL AS expected_currency,
    NULL AS gift_private,
    NULL AS intended_recipient_id,
    NULL AS purchase_state,
    NULL AS desired_edition,
    active_loan.id AS active_loan_id,
    active_loan.checkout_at,
    active_loan.due_at,
    active_loan.loan_status,
    borrower_user.name AS borrower_user_name,
    external_borrower.display_name AS external_borrower_name,
    (
      SELECT series.name FROM work_series link
      JOIN series ON series.id = link.series_id
      WHERE link.work_id = work.id
      ORDER BY CASE link.series_role WHEN 'main' THEN 0 ELSE 1 END, link.reading_order
      LIMIT 1
    ) AS series_name,
    (
      SELECT link.volume_label FROM work_series link
      WHERE link.work_id = work.id
      ORDER BY CASE link.series_role WHEN 'main' THEN 0 ELSE 1 END, link.reading_order
      LIMIT 1
    ) AS series_number,
    (
      SELECT link.reading_order FROM work_series link
      WHERE link.work_id = work.id
      ORDER BY CASE link.series_role WHEN 'main' THEN 0 ELSE 1 END, link.reading_order
      LIMIT 1
    ) AS reading_order,
    (SELECT COUNT(*) FROM editions sibling WHERE sibling.work_id = work.id AND sibling.archived_at IS NULL) AS edition_count,
    (SELECT COUNT(*) FROM copies sibling WHERE sibling.household_id = copy.household_id AND sibling.edition_id = edition.id AND sibling.archived_at IS NULL AND sibling.copy_status = 'active') AS edition_copy_count,
    (SELECT COUNT(*) FROM copies sibling JOIN editions sibling_edition ON sibling_edition.id = sibling.edition_id WHERE sibling.household_id = copy.household_id AND sibling_edition.work_id = work.id AND sibling.archived_at IS NULL AND sibling.copy_status = 'active') AS work_copy_count,
    '' AS search_text
  FROM copies copy
  JOIN editions edition ON edition.id = copy.edition_id
  JOIN works work ON work.id = edition.work_id
  LEFT JOIN users owner ON owner.id = copy.owner_user_id
  LEFT JOIN locations location ON location.id = copy.location_id
  LEFT JOIN user_work_state reading ON reading.work_id = work.id AND reading.user_id = ?
  LEFT JOIN loans active_loan ON active_loan.copy_id = copy.id
    AND active_loan.returned_at IS NULL AND active_loan.loan_status IN ('checked_out', 'overdue')
  LEFT JOIN users borrower_user ON borrower_user.id = active_loan.borrower_user_id
  LEFT JOIN external_borrowers external_borrower ON external_borrower.id = active_loan.external_borrower_id
  WHERE copy.household_id = ? AND copy.archived_at IS NULL AND copy.copy_status = 'active'

  UNION ALL

  SELECT
    'list' AS entity_type,
    entry.id AS entity_id,
    work.id AS work_id,
    edition.id AS edition_id,
    work.title,
    work.subtitle,
    work.primary_author,
    work.description,
    (SELECT json_group_array(tag.name) FROM work_tags wt JOIN tags tag ON tag.id = wt.tag_id WHERE wt.work_id = work.id) AS tags_json,
    edition.isbn10,
    edition.isbn13,
    edition.publisher,
    edition.binding,
    edition.language,
    edition.publication_date,
    edition.page_count,
    edition.edition_label,
    edition.cover_url,
    edition.cover_path,
    edition.cover_options,
    edition.estimated_value_cents,
    edition.estimated_value_currency,
    edition.provider,
    edition.provider_record_id,
    entry.requested_by AS owner_user_id,
    requester.name AS owner_name,
    NULL AS format,
    entry.preferred_formats AS formats_json,
    NULL AS location_id,
    NULL AS location_name,
    NULL AS condition_grade,
    NULL AS condition_notes,
    NULL AS purchase_date,
    NULL AS purchase_price_cents,
    NULL AS purchase_currency,
    NULL AS purchase_source,
    NULL AS custom_barcode,
    entry.notes AS copy_notes,
    NULL AS copy_status,
    entry.list_type AS item_status,
    entry.added_at AS date_added,
    reading.status_key AS read_status,
    reading.rating,
    reading.favorite,
    reading.private_notes,
    reading.household_notes,
    entry.scope AS list_scope,
    entry.priority,
    entry.expected_price_cents,
    entry.expected_currency,
    entry.gift_private,
    entry.intended_recipient_id,
    entry.purchase_state,
    entry.desired_edition,
    NULL AS active_loan_id,
    NULL AS checkout_at,
    NULL AS due_at,
    NULL AS loan_status,
    NULL AS borrower_user_name,
    NULL AS external_borrower_name,
    (
      SELECT series.name FROM work_series link
      JOIN series ON series.id = link.series_id
      WHERE link.work_id = work.id
      ORDER BY CASE link.series_role WHEN 'main' THEN 0 ELSE 1 END, link.reading_order
      LIMIT 1
    ) AS series_name,
    (
      SELECT link.volume_label FROM work_series link
      WHERE link.work_id = work.id
      ORDER BY CASE link.series_role WHEN 'main' THEN 0 ELSE 1 END, link.reading_order
      LIMIT 1
    ) AS series_number,
    (
      SELECT link.reading_order FROM work_series link
      WHERE link.work_id = work.id
      ORDER BY CASE link.series_role WHEN 'main' THEN 0 ELSE 1 END, link.reading_order
      LIMIT 1
    ) AS reading_order,
    (SELECT COUNT(*) FROM editions sibling WHERE sibling.work_id = work.id AND sibling.archived_at IS NULL) AS edition_count,
    (SELECT COUNT(*) FROM copies sibling WHERE sibling.household_id = entry.household_id AND sibling.edition_id = edition.id AND sibling.archived_at IS NULL AND sibling.copy_status = 'active') AS edition_copy_count,
    (SELECT COUNT(*) FROM copies sibling JOIN editions sibling_edition ON sibling_edition.id = sibling.edition_id WHERE sibling.household_id = entry.household_id AND sibling_edition.work_id = work.id AND sibling.archived_at IS NULL AND sibling.copy_status = 'active') AS work_copy_count,
    '' AS search_text
  FROM list_entries entry
  JOIN works work ON work.id = entry.work_id
  LEFT JOIN editions edition ON edition.id = entry.edition_id
  JOIN users requester ON requester.id = entry.requested_by
  LEFT JOIN user_work_state reading ON reading.work_id = work.id AND reading.user_id = ?
  WHERE entry.household_id = ? AND entry.archived_at IS NULL
    AND (
      (entry.list_type = 'backlog' AND entry.requested_by = ?)
      OR (entry.list_type = 'wishlist' AND (
        entry.requested_by = ?
        OR (
          entry.scope = 'household'
          AND NOT(entry.gift_private = 1 AND entry.intended_recipient_id = ?)
        )
      ))
    )
`;

const sortColumns = {
  title: "title COLLATE NOCASE",
  author: "primary_author COLLATE NOCASE",
  series: "series_name COLLATE NOCASE",
  seriesNumber: "COALESCE(reading_order, CAST(series_number AS REAL), 999999)",
  publicationDate: "publication_date",
  dateAdded: "date_added",
  owner: "owner_name COLLATE NOCASE",
  location: "location_name COLLATE NOCASE",
  format: "COALESCE(format, formats_json)",
  readingStatus: "read_status",
  rating: "rating",
};

function publicCatalogRow(row, locationById, userId, context) {
  const location = row.location_id ? locationById.get(String(row.location_id)) : null;
  const formats = parseArray(row.formats_json).filter(format => ["physical", "ebook", "audiobook"].includes(format));
  const tags = parseArray(row.tags_json);
  const shared = row.entity_type === "copy" && (row.owner_user_id == null || row.owner_user_id !== userId);
  const canDelete = row.entity_type === "list"
    ? row.owner_user_id === userId || isHouseholdAdmin(context)
    : isHouseholdAdmin(context) || row.owner_user_id === userId;
  return {
    id: `${row.entity_type}:${row.entity_id}`,
    kind: row.entity_type,
    bookId: String(row.work_id),
    workId: String(row.work_id),
    editionId: row.edition_id ? String(row.edition_id) : null,
    copyId: row.entity_type === "copy" ? String(row.entity_id) : null,
    book: {
      id: String(row.work_id),
      title: row.title,
      subtitle: row.subtitle || undefined,
      author: row.primary_author,
      isbn: row.isbn13 || row.isbn10 || undefined,
      isbn10: row.isbn10 || undefined,
      isbn13: row.isbn13 || undefined,
      series: row.series_name || undefined,
      seriesNumber: row.series_number || undefined,
      readingOrder: row.reading_order ?? undefined,
      coverUrl: row.cover_path ? `/api/covers/${row.edition_id}` : row.cover_url || undefined,
      coverOptions: parseArray(row.cover_options),
      pageCount: row.page_count || undefined,
      publishedYear: row.publication_date ? Number(String(row.publication_date).slice(0, 4)) : undefined,
      publicationDate: row.publication_date || undefined,
      publisher: row.publisher || undefined,
      language: row.language || undefined,
      description: row.description || undefined,
      genre: tags[0] || undefined,
      binding: row.binding || undefined,
      edition: row.edition_label || undefined,
    source: row.provider,
    sourceId: row.provider_record_id || undefined,
    estimatedValue: row.estimated_value_cents == null ? null : row.estimated_value_cents / 100,
    estimatedCurrency: row.estimated_value_currency || null,
    },
    status: row.item_status,
    readStatus: row.read_status || "unread",
    formats: formats.length ? formats : row.format ? [row.format] : [],
    storageLocation: location?.breadcrumb || row.location_name || undefined,
    location: location || null,
    conditionGrade: row.condition_grade || undefined,
    conditionNotes: row.condition_notes || undefined,
    purchaseDate: row.purchase_date || null,
    purchasePrice: row.purchase_price_cents == null ? null : row.purchase_price_cents / 100,
    purchaseCurrency: row.purchase_currency || null,
    purchaseSource: row.purchase_source || null,
    customBarcode: row.custom_barcode || null,
    notes: row.copy_notes || "",
    owner: row.owner_user_id == null
      ? { id: null, name: "Household" }
      : { id: String(row.owner_user_id), name: row.owner_name },
    shared,
    canDelete,
    rating: row.rating ?? undefined,
    favorite: Boolean(row.favorite),
    loanedOut: Boolean(row.active_loan_id),
    activeLoan: row.active_loan_id ? {
      id: String(row.active_loan_id),
      checkoutAt: row.checkout_at,
      dueAt: row.due_at || null,
      status: row.loan_status,
      borrower: row.borrower_user_name || row.external_borrower_name || "Unknown borrower",
      overdue: Boolean(row.due_at && row.due_at < new Date().toISOString() && row.loan_status !== "returned"),
    } : null,
    list: row.entity_type === "list" ? {
      scope: row.list_scope,
      priority: row.priority || null,
      expectedPrice: row.expected_price_cents == null ? null : row.expected_price_cents / 100,
      expectedCurrency: row.expected_currency || null,
      giftPrivate: Boolean(row.gift_private),
      intendedRecipientId: row.intended_recipient_id ? String(row.intended_recipient_id) : null,
      purchaseState: row.purchase_state,
      desiredEdition: row.desired_edition || null,
      notes: row.copy_notes || "",
    } : null,
    counts: {
      editions: row.edition_count,
      editionCopies: row.edition_copy_count,
      workCopies: row.work_copy_count,
    },
    dateAdded: row.date_added,
  };
}

export function listCatalog(db, context, userId, options = {}) {
  const page = Math.max(1, Number.parseInt(options.page || "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(options.pageSize || "50", 10) || 50));
  const search = String(options.search || "").trim().slice(0, 200).toLocaleLowerCase();
  const statuses = String(options.status || "").split(",").filter(status => ["owned", "wishlist", "backlog"].includes(status));
  const formats = String(options.format || "").split(",").filter(format => ["physical", "ebook", "audiobook"].includes(format));
  const readingStatuses = String(options.readStatus || "").split(",").filter(Boolean).slice(0, 20);
  const ownership = ["mine", "household"].includes(String(options.ownership || ""))
    ? String(options.ownership)
    : "all";
  const ownerIds = String(options.owner || "")
    .split(",")
    .filter(Boolean)
    .map(Number)
    .filter(ownerId => Number.isSafeInteger(ownerId) && ownerId > 0)
    .slice(0, 100);
  const requesterIds = String(options.requester || "")
    .split(",")
    .filter(Boolean)
    .map(Number)
    .filter(requesterId => Number.isSafeInteger(requesterId) && requesterId > 0)
    .slice(0, 100);
  const locationId = options.locationId == null || options.locationId === "" ? null : Number(options.locationId);
  if (locationId != null) assertLocationInHousehold(db, context.household_id, locationId);
  const filters = [];
  const parameters = [userId, context.household_id, userId, context.household_id, userId, userId, userId];
  if (search) {
    const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
    const normalizedSearch = search.replace(/[^0-9a-z]/g, "");
    filters.push(`(
      work_id IN (
        SELECT work.id FROM works work
        WHERE work.household_id = ?
          AND (
            lower(work.title) LIKE ? ESCAPE '\\'
            OR lower(COALESCE(work.subtitle, '')) LIKE ? ESCAPE '\\'
            OR lower(work.primary_author) LIKE ? ESCAPE '\\'
          )
        UNION
        SELECT edition.work_id FROM editions edition
        WHERE edition.household_id = ?
          AND (
            lower(COALESCE(edition.isbn10, '') || COALESCE(edition.isbn13, '')) LIKE ? ESCAPE '\\'
            OR lower(COALESCE(edition.provider_record_id, '')) LIKE ? ESCAPE '\\'
          )
        UNION
        SELECT link.work_id FROM work_contributors link
        JOIN contributors contributor ON contributor.id = link.contributor_id
        WHERE contributor.household_id = ? AND lower(contributor.name) LIKE ? ESCAPE '\\'
        UNION
        SELECT link.work_id FROM work_series link
        JOIN series ON series.id = link.series_id
        WHERE series.household_id = ?
          AND lower(series.name || ' ' || COALESCE(link.volume_label, '')) LIKE ? ESCAPE '\\'
        UNION
        SELECT link.work_id FROM work_tags link
        JOIN tags tag ON tag.id = link.tag_id
        WHERE tag.household_id = ? AND lower(tag.name) LIKE ? ESCAPE '\\'
        UNION
        SELECT link.work_id FROM collection_works link
        JOIN custom_collections collection ON collection.id = link.collection_id
        WHERE collection.household_id = ? AND lower(collection.name) LIKE ? ESCAPE '\\'
        UNION
        SELECT state.work_id FROM user_work_state state
        WHERE state.user_id = ?
          AND (
            lower(COALESCE(state.private_notes, '')) LIKE ? ESCAPE '\\'
            OR lower(COALESCE(state.household_notes, '')) LIKE ? ESCAPE '\\'
          )
        UNION
        SELECT CASE definition.applies_to
          WHEN 'work' THEN value.entity_id
          WHEN 'edition' THEN edition.work_id
        END
        FROM custom_field_values value
        JOIN custom_field_definitions definition ON definition.id = value.field_id
        LEFT JOIN editions edition
          ON definition.applies_to = 'edition' AND edition.id = value.entity_id
        WHERE definition.household_id = ? AND definition.applies_to IN ('work', 'edition')
          AND lower(value.value) LIKE ? ESCAPE '\\'
      )
      OR (
        entity_type = 'copy' AND entity_id IN (
          SELECT copy.id FROM copies copy
          WHERE copy.household_id = ?
            AND (
              lower(COALESCE(copy.custom_barcode, '')) LIKE ? ESCAPE '\\'
              OR lower(COALESCE(copy.copy_notes, '')) LIKE ? ESCAPE '\\'
              OR lower(COALESCE(copy.condition_notes, '')) LIKE ? ESCAPE '\\'
              OR copy.location_id IN (
                WITH RECURSIVE matching_locations(id) AS (
                  SELECT id FROM locations
                  WHERE household_id = ? AND lower(name) LIKE ? ESCAPE '\\'
                  UNION ALL
                  SELECT child.id FROM locations child
                  JOIN matching_locations parent ON child.parent_id = parent.id
                  WHERE child.household_id = ?
                )
                SELECT id FROM matching_locations
              )
            )
          UNION
          SELECT value.entity_id FROM custom_field_values value
          JOIN custom_field_definitions definition ON definition.id = value.field_id
          WHERE definition.household_id = ? AND definition.applies_to = 'copy'
            AND lower(value.value) LIKE ? ESCAPE '\\'
        )
      )
      OR (
        entity_type = 'list' AND entity_id IN (
          SELECT id FROM list_entries
          WHERE household_id = ? AND lower(COALESCE(notes, '')) LIKE ? ESCAPE '\\'
        )
      )
    )`);
    parameters.push(
      context.household_id, pattern, pattern, pattern,
      context.household_id, `%${normalizedSearch}%`, pattern,
      context.household_id, pattern,
      context.household_id, pattern,
      context.household_id, pattern,
      context.household_id, pattern,
      userId, pattern, pattern,
      context.household_id, pattern,
      context.household_id, pattern, pattern, pattern,
      context.household_id, pattern, context.household_id,
      context.household_id, pattern,
      context.household_id, pattern,
    );
  }
  if (statuses.length) {
    filters.push(`item_status IN (${statuses.map(() => "?").join(",")})`);
    parameters.push(...statuses);
  }
  if (formats.length) {
    filters.push(`(${formats.map(() => "instr(formats_json, ?) > 0").join(" OR ")})`);
    parameters.push(...formats.map(format => `\"${format}\"`));
  }
  if (readingStatuses.length) {
    filters.push(`COALESCE(read_status, 'unread') IN (${readingStatuses.map(() => "?").join(",")})`);
    parameters.push(...readingStatuses);
  }
  if (ownership === "mine") {
    filters.push("owner_user_id = ?");
    parameters.push(userId);
  } else if (ownership === "household") {
    filters.push("owner_user_id IS NULL");
  } else if (ownerIds.length) {
    filters.push(`owner_user_id IN (${ownerIds.map(() => "?").join(",")})`);
    parameters.push(...ownerIds);
  }
  if (requesterIds.length) {
    filters.push(`(entity_type = 'list' AND owner_user_id IN (${requesterIds.map(() => "?").join(",")}))`);
    parameters.push(...requesterIds);
  }
  if (locationId != null) {
    filters.push(`location_id IN (
      WITH RECURSIVE descendants(id) AS (
        SELECT id FROM locations WHERE id = ? AND household_id = ?
        UNION ALL
        SELECT child.id FROM locations child
        JOIN descendants parent ON child.parent_id = parent.id
        WHERE child.household_id = ?
      )
      SELECT id FROM descendants
    )`);
    parameters.push(locationId, context.household_id, context.household_id);
  }
  const sort = sortColumns[options.sort] || sortColumns.title;
  const direction = String(options.direction).toLocaleLowerCase() === "desc" ? "DESC" : "ASC";
  const rows = db.prepare(`
    WITH item_rows AS (${itemRowsSql})
    SELECT *, COUNT(*) OVER() AS total_count
    FROM item_rows
    ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
    ORDER BY ${sort} ${direction}, entity_type, entity_id
    LIMIT ? OFFSET ?
  `).all(...parameters, pageSize, (page - 1) * pageSize);
  const inventory = locationInventory(db, context.household_id);
  const locationById = new Map(inventory.locations.map(location => [location.id, location]));
  const total = rows[0]?.total_count || 0;
  return {
    items: rows.map(row => publicCatalogRow(row, locationById, userId, context)),
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    },
  };
}

export function duplicateWarnings(db, context, input, viewerUserId = null) {
  const pair = isbnPair(input.isbn);
  const normalizedTitle = normalizedText(input.title);
  const normalizedAuthor = normalizedText(input.author);
  const provider = ["google_books", "open_library", "hardcover"].includes(input.source) ? input.source : null;
  const sourceId = text(input.sourceId, 100);
  const candidates = db.prepare(`
    SELECT DISTINCT
      work.id AS work_id,
      work.title,
      work.primary_author,
      edition.id AS edition_id,
      edition.isbn10,
      edition.isbn13,
      edition.edition_label,
      edition.binding,
      edition.cover_url,
      edition.cover_path,
      edition.provider,
      edition.provider_record_id,
      CASE
        WHEN (? IS NOT NULL AND edition.isbn13 = ?) OR (? IS NOT NULL AND edition.isbn10 = ?) THEN 'exact_isbn'
        WHEN (? IS NOT NULL AND edition.provider = ? AND edition.provider_record_id = ?) THEN 'same_provider_record'
        WHEN work.normalized_title = ? AND work.normalized_author = ? THEN 'same_work'
        ELSE 'probable_work'
      END AS match_type
    FROM works work
    JOIN editions edition ON edition.work_id = work.id
    WHERE work.household_id = ? AND work.archived_at IS NULL AND edition.archived_at IS NULL
      AND (
        (? IS NOT NULL AND edition.isbn13 = ?)
        OR (? IS NOT NULL AND edition.isbn10 = ?)
        OR (? IS NOT NULL AND edition.provider = ? AND edition.provider_record_id = ?)
        OR (work.normalized_title = ? AND work.normalized_author = ?)
      )
    ORDER BY
      CASE match_type WHEN 'exact_isbn' THEN 0 WHEN 'same_provider_record' THEN 1 WHEN 'same_work' THEN 2 ELSE 3 END,
      work.title
    LIMIT 20
  `).all(
    pair.isbn13, pair.isbn13,
    pair.isbn10, pair.isbn10,
    sourceId || null, provider, sourceId || null,
    normalizedTitle, normalizedAuthor,
    context.household_id,
    pair.isbn13, pair.isbn13,
    pair.isbn10, pair.isbn10,
    sourceId || null, provider, sourceId || null,
    normalizedTitle, normalizedAuthor,
  );
  const inventory = locationInventory(db, context.household_id);
  const locationById = new Map(inventory.locations.map(location => [Number(location.id), location]));
  const warnings = candidates.map(candidate => {
      const copies = db.prepare(`
        SELECT copy.id, copy.owner_user_id, owner.name AS owner_name, copy.format,
          copy.location_id, copy.condition_grade, loan.id AS loan_id, loan.loan_status,
          loan.due_at
        FROM copies copy
        LEFT JOIN users owner ON owner.id = copy.owner_user_id
        LEFT JOIN loans loan ON loan.copy_id = copy.id AND loan.returned_at IS NULL
        WHERE copy.household_id = ? AND copy.edition_id = ?
          AND copy.archived_at IS NULL AND copy.copy_status = 'active'
        ORDER BY copy.id
      `).all(context.household_id, candidate.edition_id).map(copy => ({
        id: String(copy.id),
        owner: copy.owner_user_id == null ? { id: null, name: "Household" } : { id: String(copy.owner_user_id), name: copy.owner_name },
        format: copy.format,
        location: copy.location_id ? locationById.get(copy.location_id)?.breadcrumb || null : null,
        condition: copy.condition_grade || null,
        loan: copy.loan_id ? { id: String(copy.loan_id), status: copy.loan_status, dueAt: copy.due_at || null } : null,
      }));
      const lists = db.prepare(`
        SELECT entry.id, entry.list_type, entry.scope, entry.requested_by, requester.name AS requested_by_name
        FROM list_entries entry
        JOIN users requester ON requester.id = entry.requested_by
        WHERE entry.household_id = ? AND entry.edition_id = ? AND entry.archived_at IS NULL
          AND NOT(entry.gift_private = 1 AND entry.intended_recipient_id = ?)
      `).all(context.household_id, candidate.edition_id, viewerUserId).map(entry => ({
        id: String(entry.id),
        type: entry.list_type,
        scope: entry.scope,
        requestedBy: { id: String(entry.requested_by), name: entry.requested_by_name },
      }));
      return {
        matchType: candidate.match_type,
        work: { id: String(candidate.work_id), title: candidate.title, author: candidate.primary_author },
        edition: {
          id: String(candidate.edition_id),
          isbn10: candidate.isbn10 || null,
          isbn13: candidate.isbn13 || null,
          label: candidate.edition_label || null,
          binding: candidate.binding || null,
          coverUrl: candidate.cover_path ? `/api/covers/${candidate.edition_id}` : candidate.cover_url || null,
        },
        copyCount: copies.length,
        hasOwnedCopies: copies.length > 0,
        hasRequests: lists.length > 0,
        copies,
        lists,
        anotherHouseholdMemberOwnsIt: copies.some(copy =>
          copy.owner.id != null && (viewerUserId == null || Number(copy.owner.id) !== Number(viewerUserId))
        ),
      };
    }).filter(warning => warning.hasOwnedCopies || warning.hasRequests);
  return { warnings };
}

export function moveCopies(db, context, userId, copyIds, locationId) {
  if (!canEditInventory(context)) throw Object.assign(new Error("This role cannot move household inventory"), { status: 403 });
  const ids = [...new Set(copyIds.map(Number))];
  if (!ids.length || ids.length > 500 || ids.some(id => !Number.isSafeInteger(id) || id < 1)) {
    throw Object.assign(new Error("Select between 1 and 500 copies"), { status: 400 });
  }
  const destination = locationId == null || locationId === "" ? null : Number(locationId);
  if (destination != null) assertLocationInHousehold(db, context.household_id, destination, { allowArchived: false });
  const placeholders = ids.map(() => "?").join(",");
  const copies = db.prepare(`
    SELECT id, location_id FROM copies
    WHERE household_id = ? AND id IN (${placeholders}) AND archived_at IS NULL
  `).all(context.household_id, ...ids);
  if (copies.length !== ids.length) throw Object.assign(new Error("One or more copies were not found in this household"), { status: 404 });
  try {
    db.exec("BEGIN IMMEDIATE");
    const update = db.prepare("UPDATE copies SET location_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
    const event = db.prepare(`
      INSERT INTO copy_events (
        copy_id, actor_user_id, event_type, from_location_id, to_location_id
      ) VALUES (?, ?, 'moved', ?, ?)
    `);
    for (const copy of copies) {
      update.run(destination, copy.id);
      event.run(copy.id, userId, copy.location_id, destination);
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
  return { moved: ids.length, locationId: destination == null ? null : String(destination) };
}

export function archiveCatalogItems(db, context, userId, copyIds) {
  if (!canEditInventory(context)) throw Object.assign(new Error("This role cannot remove household inventory"), { status: 403 });
  const ids = [...new Set((Array.isArray(copyIds) ? copyIds : []).map(Number))];
  if (!ids.length || ids.length > 500 || ids.some(id => !Number.isSafeInteger(id) || id < 1)) {
    throw Object.assign(new Error("Select between 1 and 500 copies"), { status: 400 });
  }
  const placeholders = ids.map(() => "?").join(",");
  const copies = db.prepare(`
    SELECT id FROM copies
    WHERE household_id = ? AND id IN (${placeholders})
      AND archived_at IS NULL AND copy_status = 'active'
  `).all(context.household_id, ...ids);
  if (copies.length !== ids.length) throw Object.assign(new Error("One or more copies were not found in this household"), { status: 404 });
  db.prepare(`
    UPDATE copies SET archived_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE household_id = ? AND id IN (${placeholders})
  `).run(context.household_id, ...ids);
  return { archived: ids.length, ids: ids.map(String) };
}

export function archiveCatalogItem(db, context, userId, kind, entityId) {
  const id = Number(entityId);
  if (!Number.isSafeInteger(id) || id < 1 || !["copy", "list"].includes(kind)) {
    throw Object.assign(new Error("Invalid catalog item"), { status: 400 });
  }
  if (kind === "list") {
    const entry = db.prepare(`
      SELECT id, requested_by FROM list_entries
      WHERE id = ? AND household_id = ? AND archived_at IS NULL
    `).get(id, context.household_id);
    if (!entry) throw Object.assign(new Error("Catalog item not found"), { status: 404 });
    if (entry.requested_by !== userId && !isHouseholdAdmin(context)) {
      throw Object.assign(new Error("Only the requester or a household administrator can remove this list entry"), { status: 403 });
    }
    db.prepare(`
      UPDATE list_entries SET archived_at = CURRENT_TIMESTAMP
      WHERE id = ? AND household_id = ?
    `).run(id, context.household_id);
    return { archived: true, kind, id: String(id) };
  }
  const copy = db.prepare(`
    SELECT copy.id, copy.owner_user_id,
      EXISTS(
        SELECT 1 FROM loans
        WHERE copy_id = copy.id AND returned_at IS NULL
          AND loan_status IN ('checked_out', 'overdue')
      ) AS on_loan
    FROM copies copy
    WHERE copy.id = ? AND copy.household_id = ?
      AND copy.archived_at IS NULL AND copy.copy_status = 'active'
  `).get(id, context.household_id);
  if (!copy) throw Object.assign(new Error("Catalog item not found"), { status: 404 });
  if (copy.owner_user_id !== userId && !isHouseholdAdmin(context)) {
    throw Object.assign(new Error("Only the copy owner or a household administrator can remove this copy"), { status: 403 });
  }
  if (copy.on_loan) {
    throw Object.assign(new Error("Check this copy in before removing it from the active collection"), { status: 409 });
  }
  try {
    db.exec("BEGIN IMMEDIATE");
    db.prepare(`
      UPDATE copies SET copy_status = 'previously_owned',
        archived_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND household_id = ?
    `).run(id, context.household_id);
    db.prepare(`
      INSERT INTO copy_events (copy_id, actor_user_id, event_type, details)
      VALUES (?, ?, 'removed', ?)
    `).run(id, userId, JSON.stringify({ disposition: "previously_owned" }));
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
  return { archived: true, kind, id: String(id) };
}

export function catalogItemDetail(db, context, userId, kind, entityId) {
  const id = Number(entityId);
  if (!Number.isSafeInteger(id) || !["copy", "list"].includes(kind)) {
    throw Object.assign(new Error("Invalid catalog item"), { status: 400 });
  }
  const parameters = [userId, context.household_id, userId, context.household_id, userId, userId, userId, kind, id];
  const row = db.prepare(`
    WITH item_rows AS (${itemRowsSql})
    SELECT * FROM item_rows WHERE entity_type = ? AND entity_id = ?
  `).get(...parameters);
  if (!row) throw Object.assign(new Error("Catalog item not found"), { status: 404 });
  const inventory = locationInventory(db, context.household_id);
  const locationById = new Map(inventory.locations.map(location => [location.id, location]));
  const item = publicCatalogRow(row, locationById, userId, context);
  const editions = db.prepare(`
    SELECT edition.id, edition.isbn10, edition.isbn13, edition.publisher,
      edition.binding, edition.media_format, edition.language,
      edition.publication_date, edition.page_count, edition.edition_label,
      edition.cover_url, edition.cover_path, edition.provider,
      edition.provider_record_id, edition.lookup_date, edition.last_refresh_at,
      edition.field_provenance, edition.manual_overrides,
      COUNT(copy.id) AS copy_count
    FROM editions edition
    LEFT JOIN copies copy ON copy.edition_id = edition.id
      AND copy.household_id = ? AND copy.archived_at IS NULL
    WHERE edition.work_id = ? AND edition.household_id = ? AND edition.archived_at IS NULL
    GROUP BY edition.id ORDER BY edition.publication_date, edition.id
  `).all(context.household_id, row.work_id, context.household_id).map(edition => ({
    id: String(edition.id),
    isbn10: edition.isbn10 || null,
    isbn13: edition.isbn13 || null,
    publisher: edition.publisher || null,
    binding: edition.binding || null,
    mediaFormat: edition.media_format || null,
    language: edition.language || null,
    publicationDate: edition.publication_date || null,
    pageCount: edition.page_count,
    label: edition.edition_label || null,
    coverUrl: edition.cover_path ? `/api/covers/${edition.id}` : edition.cover_url || null,
    provider: edition.provider,
    providerRecordId: edition.provider_record_id || null,
    lookupDate: edition.lookup_date || null,
    lastRefreshAt: edition.last_refresh_at || null,
    provenance: json(edition.field_provenance, {}),
    manualOverrides: parseArray(edition.manual_overrides),
    copyCount: edition.copy_count,
  }));
  const copies = db.prepare(`
    SELECT copy.id, copy.edition_id, copy.owner_user_id, owner.name AS owner_name,
      copy.format, copy.location_id, copy.condition_grade, copy.condition_notes,
      copy.purchase_date, copy.purchase_price_cents, copy.purchase_currency,
      copy.purchase_source, copy.custom_barcode, copy.copy_notes, copy.copy_status,
      copy.acquired_at, copy.created_at,
      loan.id AS active_loan_id, loan.loan_status, loan.due_at
    FROM copies copy
    LEFT JOIN users owner ON owner.id = copy.owner_user_id
    LEFT JOIN loans loan ON loan.copy_id = copy.id AND loan.returned_at IS NULL
    WHERE copy.household_id = ? AND copy.edition_id IN (
      SELECT id FROM editions WHERE work_id = ? AND household_id = ?
    )
    ORDER BY copy.archived_at IS NOT NULL, copy.id
  `).all(context.household_id, row.work_id, context.household_id).map(copy => {
    const location = copy.location_id ? locationById.get(String(copy.location_id)) : null;
    return {
      id: String(copy.id),
      editionId: String(copy.edition_id),
      owner: copy.owner_user_id == null
        ? { id: null, name: "Household" }
        : { id: String(copy.owner_user_id), name: copy.owner_name },
      format: copy.format,
      location,
      conditionGrade: copy.condition_grade || null,
      conditionNotes: copy.condition_notes || "",
      purchaseDate: copy.purchase_date || null,
      purchasePrice: copy.purchase_price_cents == null ? null : copy.purchase_price_cents / 100,
      purchaseCurrency: copy.purchase_currency || null,
      purchaseSource: copy.purchase_source || null,
      customBarcode: copy.custom_barcode || null,
      notes: copy.copy_notes || "",
      status: copy.copy_status,
      acquiredAt: copy.acquired_at || null,
      activeLoan: copy.active_loan_id
        ? { id: String(copy.active_loan_id), status: copy.loan_status, dueAt: copy.due_at || null }
        : null,
      createdAt: copy.created_at,
    };
  });
  const tags = db.prepare(`
    SELECT tag.id, tag.name FROM work_tags link JOIN tags tag ON tag.id = link.tag_id
    WHERE link.work_id = ? ORDER BY tag.name COLLATE NOCASE
  `).all(row.work_id).map(tag => ({ id: String(tag.id), name: tag.name }));
  const collections = db.prepare(`
    SELECT collection.id, collection.name FROM collection_works link
    JOIN custom_collections collection ON collection.id = link.collection_id
    WHERE link.work_id = ? AND collection.household_id = ?
      AND (collection.owner_user_id IS NULL OR collection.owner_user_id = ?)
    ORDER BY collection.name COLLATE NOCASE
  `).all(row.work_id, context.household_id, userId).map(collection => ({
    id: String(collection.id), name: collection.name,
  }));
  const customFields = db.prepare(`
    SELECT definition.id, definition.name, definition.field_type,
      definition.applies_to, value.value
    FROM custom_field_definitions definition
    LEFT JOIN custom_field_values value
      ON value.field_id = definition.id
      AND value.entity_type = definition.applies_to
      AND value.entity_id = CASE definition.applies_to
        WHEN 'work' THEN ?
        WHEN 'edition' THEN ?
        WHEN 'copy' THEN ?
      END
    WHERE definition.household_id = ?
    ORDER BY definition.sort_order, definition.name COLLATE NOCASE
  `).all(
    row.work_id,
    row.edition_id,
    kind === "copy" ? id : null,
    context.household_id,
  ).map(field => ({
    id: String(field.id),
    name: field.name,
    type: field.field_type,
    appliesTo: field.applies_to,
    value: field.value ?? "",
  }));
  item.book.genre = tags[0]?.name || undefined;
  item.book.collection = collections[0]?.name || undefined;
  return { item, editions, copies, tags, collections, customFields };
}

function catalogTags(input) {
  if (Array.isArray(input.tags)) return input.tags;
  if (input.genre === undefined) return [];
  return String(input.genre || "").split(",").map(value => value.trim()).filter(Boolean);
}

function replaceWorkTags(db, householdId, workId, inputTags) {
  if (!Array.isArray(inputTags)) return;
  const names = [...new Set(inputTags.map(value => text(value, 100)).filter(Boolean))].slice(0, 100);
  db.prepare("DELETE FROM work_tags WHERE work_id = ?").run(workId);
  for (const name of names) {
    const normalizedName = normalizedText(name);
    let tag = db.prepare(`
      SELECT id FROM tags WHERE household_id = ? AND normalized_name = ?
    `).get(householdId, normalizedName);
    if (!tag) {
      tag = { id: Number(db.prepare(`
        INSERT INTO tags (household_id, name, normalized_name) VALUES (?, ?, ?)
      `).run(householdId, name, normalizedName).lastInsertRowid) };
    }
    db.prepare("INSERT OR IGNORE INTO work_tags (work_id, tag_id) VALUES (?, ?)").run(workId, tag.id);
  }
}

function linkWorkCollection(db, householdId, userId, workId, collectionName) {
  if (collectionName === undefined) return;
  db.prepare(`
    DELETE FROM collection_works
    WHERE work_id = ? AND collection_id IN (
      SELECT id FROM custom_collections
      WHERE household_id = ? AND owner_user_id = ?
    )
  `).run(workId, householdId, userId);
  const name = text(collectionName, 150);
  if (!name) return;
  let collection = db.prepare(`
    SELECT id FROM custom_collections
    WHERE household_id = ? AND owner_user_id = ? AND lower(name) = lower(?)
    ORDER BY id LIMIT 1
  `).get(householdId, userId, name);
  if (!collection) {
    collection = { id: Number(db.prepare(`
      INSERT INTO custom_collections (household_id, owner_user_id, name)
      VALUES (?, ?, ?)
    `).run(householdId, userId, name).lastInsertRowid) };
  }
  db.prepare("INSERT OR IGNORE INTO collection_works (collection_id, work_id) VALUES (?, ?)")
    .run(collection.id, workId);
}

export function updateCatalogItem(db, context, userId, kind, entityId, input) {
  const id = Number(entityId);
  if (!Number.isSafeInteger(id) || !["copy", "list"].includes(kind)) {
    throw Object.assign(new Error("Invalid catalog item"), { status: 400 });
  }
  const entity = kind === "copy"
    ? db.prepare(`
      SELECT copy.*, edition.work_id, edition.isbn10, edition.isbn13,
        edition.publisher, edition.binding, edition.media_format, edition.language,
        edition.publication_date, edition.page_count, edition.edition_label,
        edition.cover_url, edition.cover_options, edition.provider, edition.provider_record_id,
        work.title, work.subtitle, work.primary_author, work.description
      FROM copies copy
      JOIN editions edition ON edition.id = copy.edition_id
      JOIN works work ON work.id = edition.work_id
      WHERE copy.id = ? AND copy.household_id = ? AND copy.archived_at IS NULL
    `).get(id, context.household_id)
    : db.prepare(`
      SELECT entry.*, edition.isbn10, edition.isbn13, edition.publisher,
        edition.binding, edition.language, edition.publication_date,
        edition.page_count, edition.edition_label, edition.cover_url,
        edition.cover_options, edition.provider, edition.provider_record_id,
        work.title, work.subtitle, work.primary_author, work.description
      FROM list_entries entry
      JOIN works work ON work.id = entry.work_id
      LEFT JOIN editions edition ON edition.id = entry.edition_id
      WHERE entry.id = ? AND entry.household_id = ? AND entry.archived_at IS NULL
    `).get(id, context.household_id);
  if (!entity) throw Object.assign(new Error("Catalog item not found"), { status: 404 });
  const workId = entity.work_id;
  const editionId = entity.edition_id;
  const editingInventory = kind === "copy";
  if (editingInventory && !canEditInventory(context)) {
    throw Object.assign(new Error("This role cannot edit household inventory"), { status: 403 });
  }
  if (kind === "list" && entity.requested_by !== userId && !isHouseholdAdmin(context)) {
    throw Object.assign(new Error("Only the requester or a household administrator can edit this list entry"), { status: 403 });
  }
  try {
    db.exec("BEGIN IMMEDIATE");
    if (editingInventory) {
      const title = input.title === undefined ? entity.title : text(input.title, 300, true);
      const author = input.author === undefined ? entity.primary_author : text(input.author, 300, true);
      db.prepare(`
        UPDATE works SET title = ?, subtitle = ?, normalized_title = ?,
          primary_author = ?, normalized_author = ?, description = ?,
          metadata_quality = 'reviewed', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND household_id = ?
      `).run(
        title,
        input.subtitle === undefined ? entity.subtitle : text(input.subtitle, 300) || null,
        normalizedText(title),
        author,
        normalizedText(author),
        input.description === undefined ? entity.description : text(input.description, 5000) || null,
        workId,
        context.household_id,
      );
      const pair = input.isbn === undefined
        ? { isbn10: entity.isbn10, isbn13: entity.isbn13, originalIsbn: entity.isbn13 || entity.isbn10 }
        : isbnPair(input.isbn);
      if (input.isbn && !pair.isbn10 && !pair.isbn13) {
        throw Object.assign(new Error("ISBN must be a valid ISBN-10 or ISBN-13"), { status: 400 });
      }
      const pageCount = input.pageCount === undefined ? entity.page_count
        : input.pageCount === "" || input.pageCount == null ? null : Number(input.pageCount);
      if (pageCount != null && (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 100000)) {
        throw Object.assign(new Error("Page count must be a positive whole number"), { status: 400 });
      }
      const publicationDate = input.publicationDate === undefined
        ? entity.publication_date
        : validDate(input.publicationDate);
      const overrideFields = [
        ["isbn", input.isbn],
        ["publisher", input.publisher],
        ["binding", input.binding],
        ["language", input.language],
        ["publicationDate", input.publicationDate],
        ["pageCount", input.pageCount],
        ["coverUrl", input.coverUrl],
      ].filter(([, value]) => value !== undefined).map(([field]) => field);
      db.prepare(`
        UPDATE editions SET isbn10 = ?, isbn13 = ?, original_isbn = ?,
          publisher = ?, binding = ?, media_format = ?, language = ?,
          publication_date = ?, page_count = ?, edition_label = ?, cover_url = ?,
          cover_options = ?,
          manual_overrides = (
            SELECT json_group_array(DISTINCT value) FROM (
              SELECT value FROM json_each(COALESCE(editions.manual_overrides, '[]'))
              UNION ALL SELECT value FROM json_each(?)
            )
          ),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND household_id = ?
      `).run(
        pair.isbn10,
        pair.isbn13,
        pair.originalIsbn,
        input.publisher === undefined ? entity.publisher : text(input.publisher, 200) || null,
        input.binding === undefined ? entity.binding : text(input.binding, 50) || null,
        input.mediaFormat === undefined ? entity.media_format : text(input.mediaFormat, 50) || null,
        input.language === undefined ? entity.language : text(input.language, 50) || null,
        publicationDate,
        pageCount,
        input.edition === undefined ? entity.edition_label : text(input.edition, 150) || null,
        input.coverUrl === undefined ? entity.cover_url : text(input.coverUrl, 2000) || null,
        input.coverOptions === undefined ? entity.cover_options : JSON.stringify(input.coverOptions.slice(0, 20)),
        JSON.stringify(overrideFields),
        editionId,
        context.household_id,
      );
      const currentCopyInput = {
        ownerUserId: entity.owner_user_id,
        existingOwnerUserId: entity.owner_user_id,
        householdOwned: entity.owner_user_id == null,
        locationId: entity.location_id,
        conditionGrade: entity.condition_grade,
        conditionNotes: entity.condition_notes,
        purchaseDate: entity.purchase_date,
        purchasePrice: entity.purchase_price_cents == null ? null : entity.purchase_price_cents / 100,
        purchaseCurrency: entity.purchase_currency,
        purchaseSource: entity.purchase_source,
        customBarcode: entity.custom_barcode,
        copyNotes: entity.copy_notes,
        ...input,
      };
      const format = input.format || entity.format;
      const copy = validateCopy(db, context, userId, currentCopyInput, format);
      db.prepare(`
        UPDATE copies SET owner_user_id = ?, format = ?, location_id = ?,
          condition_grade = ?, condition_notes = ?, purchase_date = ?,
          purchase_price_cents = ?, purchase_currency = ?, purchase_source = ?,
          custom_barcode = ?, copy_notes = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND household_id = ?
      `).run(
        copy.ownerUserId,
        format,
        copy.locationId,
        copy.conditionGrade,
        copy.conditionNotes,
        copy.purchaseDate,
        copy.purchasePriceCents,
        copy.purchaseCurrency,
        copy.purchaseSource,
        copy.customBarcode,
        copy.copyNotes,
        id,
        context.household_id,
      );
      ensureSeries(db, context.household_id, workId, input);
      if (input.tags !== undefined || input.genre !== undefined) {
        replaceWorkTags(db, context.household_id, workId, catalogTags(input));
      }
      linkWorkCollection(db, context.household_id, userId, workId, input.collection);
    } else {
      const expectedPrice = input.expectedPrice === undefined
        ? entity.expected_price_cents
        : input.expectedPrice === "" || input.expectedPrice == null ? null : Math.round(Number(input.expectedPrice) * 100);
      if (expectedPrice != null && (!Number.isSafeInteger(expectedPrice) || expectedPrice < 0 || expectedPrice > 100000000)) {
        throw Object.assign(new Error("Expected price is invalid"), { status: 400 });
      }
      const intendedRecipientId = input.intendedRecipientId === undefined
        ? entity.intended_recipient_id
        : input.intendedRecipientId === "" || input.intendedRecipientId == null ? null : Number(input.intendedRecipientId);
      if (intendedRecipientId !== null && (
        !Number.isSafeInteger(intendedRecipientId)
        || !db.prepare(`
          SELECT 1 FROM household_members member
          JOIN users user ON user.id = member.user_id
          WHERE member.household_id = ? AND member.user_id = ? AND user.disabled = 0
        `).get(context.household_id, intendedRecipientId)
      )) {
        throw Object.assign(new Error("The intended recipient must be an active member of this household"), { status: 400 });
      }
      const giftPrivate = input.giftPrivate === undefined ? Boolean(entity.gift_private) : input.giftPrivate === true;
      if (giftPrivate && intendedRecipientId === null) {
        throw Object.assign(new Error("A private gift needs an intended household recipient"), { status: 400 });
      }
      db.prepare(`
        UPDATE list_entries SET scope = ?, desired_edition = ?, preferred_formats = ?,
          priority = ?, expected_price_cents = ?, expected_currency = ?, notes = ?,
          gift_private = ?, intended_recipient_id = ?, purchase_state = ?
        WHERE id = ? AND household_id = ?
      `).run(
        input.scope === undefined ? entity.scope : input.scope === "household" ? "household" : "personal",
        input.desiredEdition === undefined ? entity.desired_edition : text(input.desiredEdition, 150) || null,
        input.formats === undefined ? entity.preferred_formats : JSON.stringify(input.formats.slice(0, 3)),
        input.priority === undefined ? entity.priority : ["low", "medium", "high"].includes(input.priority) ? input.priority : null,
        expectedPrice,
        input.expectedCurrency === undefined ? entity.expected_currency : text(input.expectedCurrency, 3).toUpperCase(),
        input.notes === undefined ? entity.notes : text(input.notes, 3000) || null,
        giftPrivate ? 1 : 0,
        intendedRecipientId,
        input.purchaseState === undefined ? entity.purchase_state
          : ["wanted", "considering", "ordered", "purchased", "received", "cancelled"].includes(input.purchaseState)
            ? input.purchaseState : "wanted",
        id,
        context.household_id,
      );
    }
    if (canEditPersonalReading(context)) {
      setReadingState(db, context.household_id, userId, workId, editionId, input);
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    if (String(error).includes("idx_copies_barcode")) {
      throw Object.assign(new Error("That custom barcode is already assigned to another copy"), { status: 409 });
    }
    if (String(error).includes("idx_editions_household_isbn")) {
      throw Object.assign(new Error("That ISBN is already assigned to another edition"), { status: 409 });
    }
    throw error;
  }
  return catalogItemDetail(db, context, userId, kind, id);
}

export function duplicateCopyGroups(db, context) {
  const works = db.prepare(`
    SELECT work.id, work.title, work.primary_author, COUNT(copy.id) AS copy_count,
      COUNT(DISTINCT edition.id) AS edition_count
    FROM works work
    JOIN editions edition ON edition.work_id = work.id AND edition.archived_at IS NULL
    JOIN copies copy ON copy.edition_id = edition.id
      AND copy.household_id = ? AND copy.archived_at IS NULL AND copy.copy_status = 'active'
    WHERE work.household_id = ? AND work.archived_at IS NULL
    GROUP BY work.id HAVING COUNT(copy.id) > 1
    ORDER BY copy_count DESC, work.title COLLATE NOCASE
  `).all(context.household_id, context.household_id);
  return {
    groups: works.map(work => {
      const copies = db.prepare(`
        SELECT copy.id, copy.format, copy.condition_grade, copy.location_id,
          edition.id AS edition_id, edition.isbn10, edition.isbn13,
          edition.binding, edition.edition_label, edition.cover_url, edition.cover_path,
          owner.id AS owner_id, owner.name AS owner_name,
          loan.id AS loan_id, loan.loan_status
        FROM editions edition
        JOIN copies copy ON copy.edition_id = edition.id
        LEFT JOIN users owner ON owner.id = copy.owner_user_id
        LEFT JOIN loans loan ON loan.copy_id = copy.id AND loan.returned_at IS NULL
        WHERE edition.work_id = ? AND copy.household_id = ?
          AND copy.archived_at IS NULL AND copy.copy_status = 'active'
        ORDER BY edition.id, copy.id
      `).all(work.id, context.household_id);
      return {
        work: { id: String(work.id), title: work.title, author: work.primary_author },
        copyCount: work.copy_count,
        editionCount: work.edition_count,
        copies: copies.map(copy => ({
          id: String(copy.id),
          editionId: String(copy.edition_id),
          isbn: copy.isbn13 || copy.isbn10 || null,
          binding: copy.binding || null,
          edition: copy.edition_label || null,
          coverUrl: copy.cover_path ? `/api/covers/${copy.edition_id}` : copy.cover_url || null,
          format: copy.format,
          condition: copy.condition_grade || null,
          owner: copy.owner_id ? { id: String(copy.owner_id), name: copy.owner_name } : { id: null, name: "Household" },
          locationId: copy.location_id ? String(copy.location_id) : null,
          loan: copy.loan_id ? { id: String(copy.loan_id), status: copy.loan_status } : null,
        })),
      };
    }),
    totalGroups: works.length,
    totalCopies: works.reduce((total, work) => total + work.copy_count, 0),
  };
}

export function seriesInventory(db, context) {
  const rows = db.prepare(`
    SELECT series.id AS series_id, series.name, work.id AS work_id,
      work.title, work.primary_author, link.volume_label, link.volume_sort,
      link.reading_order, link.series_role, link.included_volumes,
      COUNT(DISTINCT edition.id) AS edition_count,
      COUNT(DISTINCT copy.id) AS copy_count,
      MIN(copy.id) AS representative_copy_id,
      MIN(CASE WHEN entry.archived_at IS NULL THEN entry.id END) AS representative_list_id,
      MAX(CASE WHEN entry.list_type = 'wishlist' AND entry.archived_at IS NULL THEN 1 ELSE 0 END) AS wishlisted
    FROM series
    JOIN work_series link ON link.series_id = series.id
    JOIN works work ON work.id = link.work_id AND work.archived_at IS NULL
    LEFT JOIN editions edition ON edition.work_id = work.id AND edition.archived_at IS NULL
    LEFT JOIN copies copy ON copy.edition_id = edition.id
      AND copy.household_id = ? AND copy.archived_at IS NULL AND copy.copy_status = 'active'
    LEFT JOIN list_entries entry ON entry.work_id = work.id AND entry.household_id = ?
    WHERE series.household_id = ?
    GROUP BY series.id, work.id, link.series_role, link.volume_label
    ORDER BY series.name COLLATE NOCASE,
      COALESCE(link.reading_order, link.volume_sort, 999999), work.title
  `).all(context.household_id, context.household_id, context.household_id);
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.series_id)) groups.set(row.series_id, { id: String(row.series_id), name: row.name, books: [] });
    groups.get(row.series_id).books.push({
      workId: String(row.work_id),
      title: row.title,
      author: row.primary_author,
      volume: row.volume_label || null,
      volumeSort: row.volume_sort,
      readingOrder: row.reading_order,
      role: row.series_role,
      includedVolumes: parseArray(row.included_volumes),
      editionCount: row.edition_count,
      copyCount: row.copy_count,
      copyId: row.representative_copy_id ? String(row.representative_copy_id) : null,
      listId: row.representative_list_id ? String(row.representative_list_id) : null,
      wishlisted: Boolean(row.wishlisted),
    });
  }
  return {
    series: [...groups.values()].map(group => {
      const ownedIntegerVolumes = new Set(group.books
        .filter(book => book.copyCount > 0 && Number.isInteger(book.volumeSort) && book.volumeSort > 0)
        .map(book => book.volumeSort));
      const maximum = Math.max(0, ...ownedIntegerVolumes);
      const missingVolumes = [];
      for (let volume = 1; volume <= maximum; volume += 1) {
        if (!ownedIntegerVolumes.has(volume)) missingVolumes.push(volume);
      }
      return {
        ...group,
        workCount: group.books.length,
        ownedWorkCount: group.books.filter(book => book.copyCount > 0).length,
        missingVolumes,
      };
    }),
  };
}

export function deleteSeries(db, context, seriesId) {
  if (!isHouseholdAdmin(context)) throw Object.assign(new Error("Household administrator access required"), { status: 403 });
  const id = Number(seriesId);
  if (!Number.isSafeInteger(id) || id < 1) throw Object.assign(new Error("Invalid series"), { status: 400 });
  const series = db.prepare("SELECT id, name FROM series WHERE id = ? AND household_id = ?").get(id, context.household_id);
  if (!series) throw Object.assign(new Error("Series not found"), { status: 404 });
  const owned = db.prepare(`
    SELECT COUNT(*) AS count
    FROM work_series link
    JOIN works work ON work.id = link.work_id
    JOIN editions edition ON edition.work_id = work.id
    JOIN copies copy ON copy.edition_id = edition.id
    WHERE link.series_id = ? AND work.household_id = ?
      AND work.archived_at IS NULL AND edition.archived_at IS NULL
      AND copy.archived_at IS NULL AND copy.copy_status = 'active'
  `).get(id, context.household_id).count;
  if (owned) throw Object.assign(new Error("This series has collected books and cannot be deleted"), { status: 409, ownedCount: owned });
  db.prepare("DELETE FROM work_series WHERE series_id = ?").run(id);
  db.prepare("DELETE FROM series WHERE id = ? AND household_id = ?").run(id, context.household_id);
  return { deleted: true, id: String(id), name: series.name };
}

export function catalogStats(db, householdId) {
  return db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM works WHERE household_id = ? AND archived_at IS NULL) AS works,
      (SELECT COUNT(*) FROM editions WHERE household_id = ? AND archived_at IS NULL) AS editions,
      (SELECT COUNT(*) FROM copies WHERE household_id = ? AND archived_at IS NULL AND copy_status = 'active') AS copies,
      (SELECT COUNT(*) FROM list_entries WHERE household_id = ? AND archived_at IS NULL AND list_type = 'wishlist') AS wishlist,
      (SELECT COUNT(*) FROM loans WHERE household_id = ? AND returned_at IS NULL) AS active_loans,
      (SELECT COUNT(*) FROM loans WHERE household_id = ? AND returned_at IS NULL AND due_at < CURRENT_TIMESTAMP) AS overdue_loans
  `).get(householdId, householdId, householdId, householdId, householdId, householdId);
}

export function catalogActivity(db, context, userId) {
  const recentlyMoved = db.prepare(`
    SELECT work.title, work.primary_author AS author, event.created_at AS at,
      COALESCE(destination.name, 'No location') AS detail
    FROM copy_events event
    JOIN copies copy ON copy.id = event.copy_id
    JOIN editions edition ON edition.id = copy.edition_id
    JOIN works work ON work.id = edition.work_id
    LEFT JOIN locations destination ON destination.id = event.to_location_id
    WHERE copy.household_id = ? AND event.event_type = 'moved'
    ORDER BY event.created_at DESC LIMIT 10
  `).all(context.household_id);
  const recentlyLoaned = db.prepare(`
    SELECT work.title, work.primary_author AS author, loan.checkout_at AS at,
      COALESCE(member.name, external.display_name, 'Unknown borrower') AS detail
    FROM loans loan
    JOIN copies copy ON copy.id = loan.copy_id
    JOIN editions edition ON edition.id = copy.edition_id
    JOIN works work ON work.id = edition.work_id
    LEFT JOIN users member ON member.id = loan.borrower_user_id
    LEFT JOIN external_borrowers external ON external.id = loan.external_borrower_id
    WHERE loan.household_id = ? ORDER BY loan.checkout_at DESC LIMIT 10
  `).all(context.household_id);
  const recentlyRead = db.prepare(`
    SELECT work.title, work.primary_author AS author,
      COALESCE(session.finished_at, session.started_at, session.created_at) AS at,
      CASE WHEN session.finished_at IS NULL THEN 'Reading session' ELSE 'Completed' END AS detail
    FROM reading_sessions session JOIN works work ON work.id = session.work_id
    WHERE session.household_id = ? AND session.user_id = ?
    ORDER BY COALESCE(session.finished_at, session.started_at, session.created_at) DESC LIMIT 10
  `).all(context.household_id, userId);
  const previouslyOwned = db.prepare(`
    SELECT work.title, work.primary_author AS author,
      copy.archived_at AS at, COALESCE(copy.format, 'copy') AS detail
    FROM copies copy
    JOIN editions edition ON edition.id = copy.edition_id
    JOIN works work ON work.id = edition.work_id
    WHERE copy.household_id = ? AND copy.archived_at IS NOT NULL
    ORDER BY copy.archived_at DESC LIMIT 25
  `).all(context.household_id);
  return { recentlyMoved, recentlyLoaned, recentlyRead, previouslyOwned };
}
