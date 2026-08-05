import { assertHouseholdAdmin, canEditInventory, isHouseholdAdmin } from "./households.mjs";

function text(value, max, required = false) {
  const result = String(value || "").trim();
  if ((required && !result) || result.length > max) {
    throw Object.assign(new Error(required ? "A name is required" : "A value is too long"), { status: 400 });
  }
  return result;
}

function parseJson(value, fallback) {
  try { return JSON.parse(value || JSON.stringify(fallback)); } catch { return fallback; }
}

export function userPreferences(db, userId) {
  const row = db.prepare("SELECT * FROM user_preferences WHERE user_id = ?").get(userId);
  return {
    catalogView: row?.catalog_view || "cover",
    catalogSort: row?.catalog_sort || "title",
    catalogFilters: parseJson(row?.catalog_filters, {}),
    visibleColumns: parseJson(row?.visible_columns, []),
    readingGoal: parseJson(row?.reading_goal, {}),
    preferredFormats: parseJson(row?.preferred_formats, []),
    theme: row?.theme || "system",
    updatedAt: row?.updated_at || null,
  };
}

export function updateUserPreferences(db, context, userId, input) {
  const current = userPreferences(db, userId);
  const view = input.catalogView === undefined ? current.catalogView : input.catalogView;
  const sort = input.catalogSort === undefined ? current.catalogSort : input.catalogSort;
  const theme = input.theme === undefined ? current.theme : input.theme;
  if (!["cover", "detailed", "compact"].includes(view)
    || !["title", "author", "series", "seriesNumber", "publicationDate", "dateAdded", "owner", "location", "format", "readingStatus", "rating"].includes(sort)
    || !["light", "dark", "system"].includes(theme)) {
    throw Object.assign(new Error("One or more display preferences are invalid"), { status: 400 });
  }
  const filters = input.catalogFilters === undefined ? current.catalogFilters : input.catalogFilters;
  if (!filters || typeof filters !== "object" || Array.isArray(filters) || JSON.stringify(filters).length > 10_000) {
    throw Object.assign(new Error("Saved catalog filters are invalid"), { status: 400 });
  }
  const allowedColumns = new Set([
    "cover", "title", "author", "series", "seriesNumber", "isbn", "publicationDate",
    "edition", "copies", "owner", "location", "format", "condition", "readingStatus",
    "rating", "loan", "dateAdded",
  ]);
  const columns = input.visibleColumns === undefined
    ? current.visibleColumns
    : [...new Set(input.visibleColumns)].filter(column => allowedColumns.has(column));
  db.prepare(`
    INSERT INTO user_preferences (
      user_id, catalog_view, catalog_sort, catalog_filters,
      visible_columns, reading_goal, preferred_formats, theme
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      catalog_view = excluded.catalog_view,
      catalog_sort = excluded.catalog_sort,
      catalog_filters = excluded.catalog_filters,
      visible_columns = excluded.visible_columns,
      reading_goal = excluded.reading_goal,
      preferred_formats = excluded.preferred_formats,
      theme = excluded.theme,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    userId,
    view,
    sort,
    JSON.stringify(filters),
    JSON.stringify(columns),
    JSON.stringify(current.readingGoal),
    JSON.stringify(current.preferredFormats),
    theme,
  );
  return userPreferences(db, userId);
}

export function listCollections(db, context, userId) {
  const rows = db.prepare(`
    SELECT collection.id, collection.owner_user_id, collection.name,
      collection.smart_filter, collection.created_at, owner.name AS owner_name,
      COUNT(link.work_id) AS work_count
    FROM custom_collections collection
    LEFT JOIN collection_works link ON link.collection_id = collection.id
    LEFT JOIN users owner ON owner.id = collection.owner_user_id
    WHERE collection.household_id = ?
      AND (collection.owner_user_id IS NULL OR collection.owner_user_id = ?)
    GROUP BY collection.id
    ORDER BY collection.owner_user_id IS NULL DESC, collection.name COLLATE NOCASE
  `).all(context.household_id, userId);
  return {
    collections: rows.map(row => ({
      id: String(row.id),
      name: row.name,
      scope: row.owner_user_id == null ? "household" : "personal",
      owner: row.owner_user_id ? { id: String(row.owner_user_id), name: row.owner_name } : null,
      smartFilter: parseJson(row.smart_filter, null),
      workCount: row.work_count,
      createdAt: row.created_at,
    })),
  };
}

export function createCollection(db, context, userId, input) {
  const name = text(input.name, 100, true);
  const householdScope = input.scope === "household";
  if (householdScope && !isHouseholdAdmin(context)) {
    throw Object.assign(new Error("Only a household administrator can create a shared collection"), { status: 403 });
  }
  const smartFilter = input.smartFilter == null ? null : input.smartFilter;
  if (smartFilter !== null && (typeof smartFilter !== "object" || Array.isArray(smartFilter)
    || JSON.stringify(smartFilter).length > 10_000)) {
    throw Object.assign(new Error("Smart shelf filter is invalid"), { status: 400 });
  }
  const result = db.prepare(`
    INSERT INTO custom_collections (household_id, owner_user_id, name, smart_filter)
    VALUES (?, ?, ?, ?)
  `).run(context.household_id, householdScope ? null : userId, name, smartFilter ? JSON.stringify(smartFilter) : null);
  return { id: String(result.lastInsertRowid), name, scope: householdScope ? "household" : "personal", smartFilter };
}

function collectionForEdit(db, context, userId, collectionId) {
  const id = Number(collectionId);
  const collection = Number.isSafeInteger(id) && db.prepare(`
    SELECT * FROM custom_collections WHERE id = ? AND household_id = ?
  `).get(id, context.household_id);
  if (!collection) throw Object.assign(new Error("Collection not found"), { status: 404 });
  if (collection.owner_user_id !== userId && !isHouseholdAdmin(context)) {
    throw Object.assign(new Error("Only the owner or a household administrator can change this collection"), { status: 403 });
  }
  return collection;
}

export function updateCollection(db, context, userId, collectionId, input) {
  const collection = collectionForEdit(db, context, userId, collectionId);
  const name = input.name === undefined ? collection.name : text(input.name, 100, true);
  const smartFilter = input.smartFilter === undefined
    ? collection.smart_filter
    : input.smartFilter == null ? null : JSON.stringify(input.smartFilter);
  if (smartFilter && smartFilter.length > 10_000) throw Object.assign(new Error("Smart shelf filter is too large"), { status: 400 });
  const ids = Array.isArray(input.workIds) ? [...new Set(input.workIds.map(Number))] : null;
  if (ids) {
    if (ids.length > 10_000 || ids.some(id => !Number.isSafeInteger(id) || !db.prepare(`
      SELECT 1 FROM works WHERE id = ? AND household_id = ? AND archived_at IS NULL
    `).get(id, context.household_id))) {
      throw Object.assign(new Error("Collection contains an invalid work"), { status: 400 });
    }
  }
  try {
    db.exec("BEGIN IMMEDIATE");
    db.prepare(`
      UPDATE custom_collections SET name = ?, smart_filter = ? WHERE id = ?
    `).run(name, smartFilter, collection.id);
    if (ids) {
      db.prepare("DELETE FROM collection_works WHERE collection_id = ?").run(collection.id);
      const insert = db.prepare("INSERT INTO collection_works (collection_id, work_id) VALUES (?, ?)");
      for (const workId of ids) insert.run(collection.id, workId);
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
  return { ok: true };
}

export function deleteCollection(db, context, userId, collectionId) {
  const collection = collectionForEdit(db, context, userId, collectionId);
  db.prepare("DELETE FROM custom_collections WHERE id = ?").run(collection.id);
  return { ok: true };
}

export function listCustomFields(db, context) {
  const fields = db.prepare(`
    SELECT id, name, field_type, applies_to, sort_order
    FROM custom_field_definitions WHERE household_id = ?
    ORDER BY sort_order, name COLLATE NOCASE
  `).all(context.household_id).map(field => ({
    id: String(field.id),
    name: field.name,
    type: field.field_type,
    appliesTo: field.applies_to,
    sortOrder: field.sort_order,
  }));
  return { fields };
}

export function createCustomField(db, context, input) {
  assertHouseholdAdmin(context);
  const name = text(input.name, 100, true);
  const fieldType = ["text", "number", "date", "boolean", "choice"].includes(input.type) ? input.type : null;
  const appliesTo = ["work", "edition", "copy"].includes(input.appliesTo) ? input.appliesTo : null;
  if (!fieldType || !appliesTo) throw Object.assign(new Error("Custom field type or target is invalid"), { status: 400 });
  const result = db.prepare(`
    INSERT INTO custom_field_definitions (household_id, name, field_type, applies_to, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `).run(context.household_id, name, fieldType, appliesTo, Number.isInteger(input.sortOrder) ? input.sortOrder : 0);
  return { id: String(result.lastInsertRowid), name, type: fieldType, appliesTo };
}

export function setCustomFieldValue(db, context, fieldId, entityType, entityId, input) {
  if (!canEditInventory(context)) throw Object.assign(new Error("This role cannot edit catalog fields"), { status: 403 });
  const field = db.prepare(`
    SELECT * FROM custom_field_definitions WHERE id = ? AND household_id = ?
  `).get(Number(fieldId), context.household_id);
  if (!field || field.applies_to !== entityType) throw Object.assign(new Error("Custom field does not apply to this item"), { status: 400 });
  const id = Number(entityId);
  const tables = { work: "works", edition: "editions", copy: "copies" };
  if (!Number.isSafeInteger(id) || !db.prepare(`
    SELECT 1 FROM ${tables[entityType]} WHERE id = ? AND household_id = ?
  `).get(id, context.household_id)) {
    throw Object.assign(new Error("Catalog item not found"), { status: 404 });
  }
  const value = input.value == null ? null : text(input.value, 5000);
  if (value === null || value === "") {
    db.prepare(`
      DELETE FROM custom_field_values WHERE field_id = ? AND entity_type = ? AND entity_id = ?
    `).run(field.id, entityType, id);
  } else {
    if (field.field_type === "number" && !Number.isFinite(Number(value))) {
      throw Object.assign(new Error("Custom field requires a number"), { status: 400 });
    }
    if (field.field_type === "boolean" && !["true", "false"].includes(value)) {
      throw Object.assign(new Error("Custom field requires true or false"), { status: 400 });
    }
    db.prepare(`
      INSERT INTO custom_field_values (field_id, entity_type, entity_id, value)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(field_id, entity_type, entity_id) DO UPDATE SET value = excluded.value
    `).run(field.id, entityType, id, value);
  }
  return { ok: true };
}
