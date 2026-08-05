const locationLevels = new Set(["household", "building", "room", "bookcase", "shelf", "bin", "custom"]);

function locationPath(row, byId) {
  const names = [];
  const visited = new Set();
  let current = row;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    names.unshift(current.name);
    current = current.parent_id ? byId.get(current.parent_id) : null;
  }
  return names;
}

export function locationInventory(db, householdId, { includeArchived = true } = {}) {
  const rows = db.prepare(`
    SELECT id, parent_id, name, level_type, sort_order, archived_at, created_at, updated_at
    FROM locations
    WHERE household_id = ? ${includeArchived ? "" : "AND archived_at IS NULL"}
    ORDER BY parent_id, sort_order, name COLLATE NOCASE, id
  `).all(householdId);
  const directCounts = new Map(db.prepare(`
    SELECT location_id, COUNT(*) AS count
    FROM copies
    WHERE household_id = ? AND copy_status = 'active' AND archived_at IS NULL
      AND location_id IS NOT NULL
    GROUP BY location_id
  `).all(householdId).map(row => [row.location_id, row.count]));
  const byId = new Map(rows.map(row => [row.id, row]));
  const children = new Map();
  for (const row of rows) {
    const group = children.get(row.parent_id || null) || [];
    group.push(row);
    children.set(row.parent_id || null, group);
  }
  const countMemo = new Map();
  function countBelow(id, visiting = new Set()) {
    if (countMemo.has(id)) return countMemo.get(id);
    if (visiting.has(id)) return directCounts.get(id) || 0;
    const nextVisiting = new Set(visiting).add(id);
    const count = (directCounts.get(id) || 0)
      + (children.get(id) || []).reduce((total, child) => total + countBelow(child.id, nextVisiting), 0);
    countMemo.set(id, count);
    return count;
  }
  function publicLocation(row) {
    const path = locationPath(row, byId);
    return {
      id: String(row.id),
      parentId: row.parent_id ? String(row.parent_id) : null,
      name: row.name,
      levelType: row.level_type,
      sortOrder: row.sort_order,
      archived: Boolean(row.archived_at),
      archivedAt: row.archived_at || null,
      breadcrumb: path.join(" / "),
      path,
      directCopyCount: directCounts.get(row.id) || 0,
      copyCount: countBelow(row.id),
      qrValue: `bookvault-location:${row.id}`,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  function treeFor(parentId) {
    return (children.get(parentId) || []).map(row => ({
      ...publicLocation(row),
      children: treeFor(row.id),
    }));
  }
  return { locations: rows.map(publicLocation), tree: treeFor(null) };
}

export function validatedLocationInput(input) {
  const name = String(input.name || "").trim();
  const levelType = locationLevels.has(input.levelType) ? input.levelType : "custom";
  const parentId = input.parentId === "" || input.parentId == null ? null : Number(input.parentId);
  const sortOrder = input.sortOrder == null ? 0 : Number(input.sortOrder);
  if (!name || name.length > 150) {
    throw Object.assign(new Error("Location name is required and must be 150 characters or fewer"), { status: 400 });
  }
  if (parentId !== null && (!Number.isSafeInteger(parentId) || parentId < 1)) {
    throw Object.assign(new Error("Invalid parent location"), { status: 400 });
  }
  if (!Number.isInteger(sortOrder) || sortOrder < -100000 || sortOrder > 100000) {
    throw Object.assign(new Error("Invalid location order"), { status: 400 });
  }
  return { name, levelType, parentId, sortOrder };
}

export function assertLocationInHousehold(db, householdId, locationId, { allowArchived = true } = {}) {
  const row = db.prepare(`
    SELECT * FROM locations WHERE id = ? AND household_id = ?
      ${allowArchived ? "" : "AND archived_at IS NULL"}
  `).get(locationId, householdId);
  if (!row) throw Object.assign(new Error("Location not found"), { status: 404 });
  return row;
}

export function assertValidLocationParent(db, householdId, locationId, parentId) {
  if (parentId == null) return;
  assertLocationInHousehold(db, householdId, parentId, { allowArchived: false });
  if (locationId == null) return;
  if (locationId === parentId) throw Object.assign(new Error("A location cannot contain itself"), { status: 400 });
  const descendants = db.prepare(`
    WITH RECURSIVE descendants(id) AS (
      SELECT id FROM locations WHERE parent_id = ? AND household_id = ?
      UNION ALL
      SELECT child.id FROM locations child
      JOIN descendants parent ON child.parent_id = parent.id
      WHERE child.household_id = ?
    )
    SELECT id FROM descendants WHERE id = ? LIMIT 1
  `).get(locationId, householdId, householdId, parentId);
  if (descendants) throw Object.assign(new Error("A location cannot be moved below one of its children"), { status: 400 });
}
