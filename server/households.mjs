const householdRoles = new Set(["household_admin", "adult", "child", "viewer"]);

export function householdContext(db, userId) {
  return db.prepare(`
    SELECT
      h.id AS household_id,
      h.name AS household_name,
      h.default_location_id,
      h.default_binding,
      h.default_condition,
      h.rating_scale,
      h.rating_increment,
      h.backup_retention,
      h.scheduled_backup,
      hm.household_role,
      hm.disabled AS membership_disabled,
      u.system_role,
      u.disabled AS user_disabled
    FROM household_members hm
    JOIN households h ON h.id = hm.household_id
    JOIN users u ON u.id = hm.user_id
    WHERE hm.user_id = ?
  `).get(userId);
}

export function assertActiveContext(context) {
  if (!context || context.user_disabled || context.membership_disabled) {
    throw Object.assign(new Error("This account is disabled or has no active household"), { status: 403 });
  }
  return context;
}

export function isSystemAdmin(context) {
  return context?.system_role === "system_admin";
}

export function isHouseholdAdmin(context) {
  return isSystemAdmin(context) || context?.household_role === "household_admin";
}

export function canEditInventory(context) {
  return isHouseholdAdmin(context) || context?.household_role === "adult";
}

export function canEditPersonalReading(context) {
  return Boolean(context && !context.user_disabled && !context.membership_disabled && context.household_role !== "viewer");
}

export function assertHouseholdAdmin(context) {
  assertActiveContext(context);
  if (!isHouseholdAdmin(context)) {
    throw Object.assign(new Error("Household administrator access required"), { status: 403 });
  }
}

export function assertInventoryEditor(context) {
  assertActiveContext(context);
  if (!canEditInventory(context)) {
    throw Object.assign(new Error("This household role cannot change the physical collection"), { status: 403 });
  }
}

export function validatedHouseholdRole(value) {
  return householdRoles.has(value) ? value : null;
}

export function writeAuditEvent(db, {
  householdId = null,
  actorUserId = null,
  eventType,
  targetType = null,
  targetId = null,
  address = null,
  details = {},
}) {
  const safeDetails = Object.fromEntries(
    Object.entries(details).filter(([key]) => !/password|token|secret|private.?note/i.test(key)),
  );
  db.prepare(`
    INSERT INTO audit_events (
      household_id, actor_user_id, event_type, target_type, target_id, address, details
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    householdId,
    actorUserId,
    eventType,
    targetType,
    targetId == null ? null : String(targetId),
    address,
    JSON.stringify(safeDetails),
  );
}

export function householdMembers(db, householdId) {
  return db.prepare(`
    SELECT
      u.id,
      u.name,
      u.email,
      u.system_role,
      u.disabled AS user_disabled,
      u.created_at,
      hm.household_role,
      hm.disabled AS membership_disabled,
      hm.joined_at
    FROM household_members hm
    JOIN users u ON u.id = hm.user_id
    WHERE hm.household_id = ?
    ORDER BY
      CASE hm.household_role
        WHEN 'household_admin' THEN 0
        WHEN 'adult' THEN 1
        WHEN 'child' THEN 2
        ELSE 3
      END,
      u.name COLLATE NOCASE,
      u.id
  `).all(householdId).map(member => ({
    id: member.id,
    name: member.name,
    email: member.email,
    systemRole: member.system_role,
    householdRole: member.household_role,
    disabled: Boolean(member.user_disabled || member.membership_disabled),
    joinedAt: member.joined_at,
    createdAt: member.created_at,
  }));
}

export function householdSummary(db, context) {
  const household = db.prepare(`
    SELECT id, name, default_location_id, default_binding, default_condition,
      rating_scale, rating_increment, backup_retention, scheduled_backup,
      created_at, updated_at
    FROM households WHERE id = ?
  `).get(context.household_id);
  return {
    id: String(household.id),
    name: household.name,
    role: context.household_role,
    systemRole: context.system_role,
    defaults: {
      locationId: household.default_location_id ? String(household.default_location_id) : null,
      binding: household.default_binding || "",
      condition: household.default_condition || "",
    },
    ratings: {
      scale: household.rating_scale,
      increment: household.rating_increment,
    },
    backups: {
      retention: household.backup_retention,
      schedule: household.scheduled_backup || "",
    },
    createdAt: household.created_at,
    updatedAt: household.updated_at,
  };
}
