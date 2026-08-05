import { assertInventoryEditor, isHouseholdAdmin } from "./households.mjs";

function text(value, max, required = false) {
  const result = String(value || "").trim();
  if ((required && !result) || result.length > max) {
    throw Object.assign(new Error(required ? "A required loan field is missing" : "A loan field is too long"), { status: 400 });
  }
  return result;
}

function dateTime(value, { required = false } = {}) {
  if (value == null || value === "") {
    if (required) throw Object.assign(new Error("A checkout date is required"), { status: 400 });
    return null;
  }
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw Object.assign(new Error("A loan date is invalid"), { status: 400 });
  return parsed.toISOString();
}

function activeMember(db, householdId, userId) {
  return db.prepare(`
    SELECT users.id, users.name
    FROM household_members
    JOIN users ON users.id = household_members.user_id
    WHERE household_members.household_id = ? AND household_members.user_id = ?
      AND household_members.disabled = 0 AND users.disabled = 0
  `).get(householdId, userId);
}

function publicLoan(row) {
  return {
    id: String(row.id),
    copyId: String(row.copy_id),
    workId: String(row.work_id),
    editionId: String(row.edition_id),
    title: row.title,
    author: row.primary_author,
    coverUrl: row.cover_path ? `/api/covers/${row.edition_id}` : row.cover_url || null,
    isbn: row.isbn13 || row.isbn10 || null,
    customBarcode: row.custom_barcode || null,
    format: row.format,
    owner: row.owner_user_id == null
      ? { id: null, name: "Household" }
      : { id: String(row.owner_user_id), name: row.owner_name },
    borrower: row.borrower_user_id
      ? { type: "member", id: String(row.borrower_user_id), name: row.borrower_user_name }
      : { type: "external", id: String(row.external_borrower_id), name: row.external_borrower_name },
    checkoutAt: row.checkout_at,
    dueAt: row.due_at || null,
    returnedAt: row.returned_at || null,
    renewedCount: row.renewed_count,
    status: row.computed_status,
    notes: row.notes || "",
    overdue: row.computed_status === "overdue",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const loanRows = `
  SELECT loan.*, copy.edition_id, copy.owner_user_id, copy.format, copy.custom_barcode,
    edition.work_id, edition.isbn10, edition.isbn13, edition.cover_url, edition.cover_path,
    work.title, work.primary_author,
    owner.name AS owner_name,
    member.name AS borrower_user_name,
    external.display_name AS external_borrower_name,
    CASE
      WHEN loan.returned_at IS NOT NULL THEN 'returned'
      WHEN loan.loan_status IN ('lost', 'damaged') THEN loan.loan_status
      WHEN loan.due_at IS NOT NULL AND loan.due_at < CURRENT_TIMESTAMP THEN 'overdue'
      ELSE loan.loan_status
    END AS computed_status
  FROM loans loan
  JOIN copies copy ON copy.id = loan.copy_id
  JOIN editions edition ON edition.id = copy.edition_id
  JOIN works work ON work.id = edition.work_id
  LEFT JOIN users owner ON owner.id = copy.owner_user_id
  LEFT JOIN users member ON member.id = loan.borrower_user_id
  LEFT JOIN external_borrowers external ON external.id = loan.external_borrower_id
`;

export function listLoans(db, context, options = {}) {
  const history = options.history === true;
  const overdueOnly = options.overdue === true;
  const filters = ["loan.household_id = ?"];
  const parameters = [context.household_id];
  if (!history) filters.push("loan.returned_at IS NULL");
  if (overdueOnly) filters.push("loan.returned_at IS NULL", "loan.due_at IS NOT NULL", "loan.due_at < CURRENT_TIMESTAMP");
  const rows = db.prepare(`
    ${loanRows}
    WHERE ${filters.join(" AND ")}
    ORDER BY
      CASE WHEN loan.returned_at IS NULL THEN 0 ELSE 1 END,
      CASE WHEN loan.due_at IS NOT NULL AND loan.due_at < CURRENT_TIMESTAMP THEN 0 ELSE 1 END,
      COALESCE(loan.due_at, loan.checkout_at) ASC,
      loan.id DESC
    LIMIT 1000
  `).all(...parameters);
  return { loans: rows.map(publicLoan) };
}

export function checkoutCopy(db, context, userId, input) {
  assertInventoryEditor(context);
  const copyId = Number(input.copyId);
  if (!Number.isSafeInteger(copyId) || copyId < 1) throw Object.assign(new Error("Select a valid copy"), { status: 400 });
  const copy = db.prepare(`
    SELECT id FROM copies
    WHERE id = ? AND household_id = ? AND archived_at IS NULL AND copy_status = 'active'
  `).get(copyId, context.household_id);
  if (!copy) throw Object.assign(new Error("Copy not found in this household"), { status: 404 });
  if (db.prepare(`
    SELECT id FROM loans WHERE copy_id = ? AND returned_at IS NULL
      AND loan_status IN ('checked_out', 'overdue')
  `).get(copyId)) {
    throw Object.assign(new Error("This copy is already checked out"), { status: 409 });
  }
  const borrowerUserId = input.borrowerUserId == null || input.borrowerUserId === ""
    ? null
    : Number(input.borrowerUserId);
  const externalName = text(input.externalBorrower?.name ?? input.externalName, 150);
  if ((borrowerUserId == null) === !externalName) {
    throw Object.assign(new Error("Choose one household member or enter one external borrower"), { status: 400 });
  }
  if (borrowerUserId != null && (!Number.isSafeInteger(borrowerUserId)
    || !activeMember(db, context.household_id, borrowerUserId))) {
    throw Object.assign(new Error("Borrower must be an active household member"), { status: 400 });
  }
  const checkoutAt = dateTime(input.checkoutAt) || new Date().toISOString();
  const dueAt = dateTime(input.dueAt);
  if (dueAt && dueAt <= checkoutAt) throw Object.assign(new Error("Due date must follow the checkout date"), { status: 400 });
  const notes = text(input.notes, 2000);
  let loanId;
  try {
    db.exec("BEGIN IMMEDIATE");
    let externalBorrowerId = null;
    if (externalName) {
      const contactEmail = text(input.externalBorrower?.email, 254);
      if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
        throw Object.assign(new Error("External borrower email is invalid"), { status: 400 });
      }
      const external = db.prepare(`
        INSERT INTO external_borrowers (household_id, display_name, contact_email, notes)
        VALUES (?, ?, ?, ?)
      `).run(
        context.household_id,
        externalName,
        contactEmail || null,
        text(input.externalBorrower?.notes, 500) || null,
      );
      externalBorrowerId = Number(external.lastInsertRowid);
    }
    const result = db.prepare(`
      INSERT INTO loans (
        household_id, copy_id, borrower_user_id, external_borrower_id,
        checkout_at, due_at, notes, checked_out_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      context.household_id,
      copyId,
      borrowerUserId,
      externalBorrowerId,
      checkoutAt,
      dueAt,
      notes || null,
      userId,
    );
    loanId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO copy_events (copy_id, actor_user_id, event_type, details)
      VALUES (?, ?, 'checked_out', ?)
    `).run(copyId, userId, JSON.stringify({ loanId, borrowerType: borrowerUserId ? "member" : "external", dueAt }));
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    if (String(error).includes("idx_active_loan_copy")) {
      throw Object.assign(new Error("This copy is already checked out"), { status: 409 });
    }
    throw error;
  }
  return publicLoan(db.prepare(`${loanRows} WHERE loan.id = ? AND loan.household_id = ?`).get(loanId, context.household_id));
}

function activeLoan(db, householdId, loanId) {
  const loan = db.prepare(`
    SELECT * FROM loans
    WHERE id = ? AND household_id = ? AND returned_at IS NULL
  `).get(loanId, householdId);
  if (!loan) throw Object.assign(new Error("Active loan not found"), { status: 404 });
  return loan;
}

export function returnLoan(db, context, userId, loanId, input = {}) {
  assertInventoryEditor(context);
  const loan = activeLoan(db, context.household_id, Number(loanId));
  const returnedAt = dateTime(input.returnedAt) || new Date().toISOString();
  if (returnedAt < loan.checkout_at) throw Object.assign(new Error("Return date cannot precede checkout"), { status: 400 });
  const finalStatus = ["returned", "damaged", "lost"].includes(input.status) ? input.status : "returned";
  try {
    db.exec("BEGIN IMMEDIATE");
    db.prepare(`
      UPDATE loans SET returned_at = ?, loan_status = ?, checked_in_by = ?,
        notes = CASE WHEN ? = '' THEN notes ELSE trim(COALESCE(notes, '') || char(10) || ?) END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND household_id = ?
    `).run(
      returnedAt,
      finalStatus,
      userId,
      text(input.notes, 2000),
      text(input.notes, 2000),
      loan.id,
      context.household_id,
    );
    db.prepare(`
      INSERT INTO copy_events (copy_id, actor_user_id, event_type, details)
      VALUES (?, ?, 'checked_in', ?)
    `).run(loan.copy_id, userId, JSON.stringify({ loanId: loan.id, finalStatus }));
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
  return publicLoan(db.prepare(`${loanRows} WHERE loan.id = ?`).get(loan.id));
}

export function renewLoan(db, context, userId, loanId, input) {
  assertInventoryEditor(context);
  const loan = activeLoan(db, context.household_id, Number(loanId));
  const dueAt = dateTime(input.dueAt, { required: true });
  const baseline = loan.due_at || loan.checkout_at;
  if (dueAt <= baseline) throw Object.assign(new Error("A renewal must extend the current due date"), { status: 400 });
  db.prepare(`
    UPDATE loans SET due_at = ?, renewed_count = renewed_count + 1,
      loan_status = 'checked_out', updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND household_id = ?
  `).run(dueAt, loan.id, context.household_id);
  db.prepare(`
    INSERT INTO copy_events (copy_id, actor_user_id, event_type, details)
    VALUES (?, ?, 'loan_renewed', ?)
  `).run(loan.copy_id, userId, JSON.stringify({ loanId: loan.id, dueAt }));
  return publicLoan(db.prepare(`${loanRows} WHERE loan.id = ?`).get(loan.id));
}

export function markLoan(db, context, userId, loanId, status, notes) {
  assertInventoryEditor(context);
  if (!["checked_out", "lost", "damaged"].includes(status)) {
    throw Object.assign(new Error("Invalid loan status"), { status: 400 });
  }
  const loan = activeLoan(db, context.household_id, Number(loanId));
  db.prepare(`
    UPDATE loans SET loan_status = ?,
      notes = CASE WHEN ? = '' THEN notes ELSE trim(COALESCE(notes, '') || char(10) || ?) END,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND household_id = ?
  `).run(status, text(notes, 2000), text(notes, 2000), loan.id, context.household_id);
  db.prepare(`
    INSERT INTO copy_events (copy_id, actor_user_id, event_type, details)
    VALUES (?, ?, 'loan_status_changed', ?)
  `).run(loan.copy_id, userId, JSON.stringify({ loanId: loan.id, status }));
  return publicLoan(db.prepare(`${loanRows} WHERE loan.id = ?`).get(loan.id));
}

function copiesByBarcode(db, householdId, value) {
  const barcode = text(value, 100, true).replace(/[\s-]/g, "").toUpperCase();
  return db.prepare(`
    SELECT DISTINCT copy.id
    FROM copies copy
    JOIN editions edition ON edition.id = copy.edition_id
    WHERE copy.household_id = ? AND copy.archived_at IS NULL
      AND (
        upper(replace(replace(COALESCE(copy.custom_barcode, ''), '-', ''), ' ', '')) = ?
        OR replace(replace(COALESCE(edition.isbn10, ''), '-', ''), ' ', '') = ?
        OR replace(replace(COALESCE(edition.isbn13, ''), '-', ''), ' ', '') = ?
      )
  `).all(householdId, barcode, barcode, barcode);
}

export function batchCheckIn(db, context, userId, barcodes) {
  assertInventoryEditor(context);
  if (!Array.isArray(barcodes) || !barcodes.length || barcodes.length > 500) {
    throw Object.assign(new Error("Scan between 1 and 500 barcodes"), { status: 400 });
  }
  const results = [];
  for (const rawBarcode of barcodes) {
    try {
      const copies = copiesByBarcode(db, context.household_id, rawBarcode);
      const active = copies.flatMap(copy => db.prepare(`
        SELECT id FROM loans WHERE copy_id = ? AND returned_at IS NULL
      `).all(copy.id));
      if (active.length === 0) {
        results.push({ barcode: String(rawBarcode), state: "warning", message: "No active loan found" });
      } else if (active.length > 1) {
        results.push({
          barcode: String(rawBarcode),
          state: "duplicate",
          message: "More than one matching copy is checked out; choose the copy manually",
          loanIds: active.map(loan => String(loan.id)),
        });
      } else {
        const loan = returnLoan(db, context, userId, active[0].id);
        results.push({ barcode: String(rawBarcode), state: "success", loan });
      }
    } catch (error) {
      results.push({ barcode: String(rawBarcode), state: "failure", message: error.message || "Check-in failed" });
    }
  }
  return { results };
}

export function listHolds(db, context) {
  const holds = db.prepare(`
    SELECT hold.*, work.title, work.primary_author, users.name AS requested_by_name
    FROM loan_holds hold
    JOIN works work ON work.id = hold.work_id
    JOIN users ON users.id = hold.requested_by
    WHERE hold.household_id = ? AND hold.status = 'waiting'
    ORDER BY work.title COLLATE NOCASE, hold.queue_position, hold.created_at
  `).all(context.household_id).map(hold => ({
    id: String(hold.id),
    workId: String(hold.work_id),
    title: hold.title,
    author: hold.primary_author,
    requestedBy: { id: String(hold.requested_by), name: hold.requested_by_name },
    queuePosition: hold.queue_position,
    status: hold.status,
    createdAt: hold.created_at,
  }));
  return { holds };
}

export function createHold(db, context, userId, workId) {
  const id = Number(workId);
  if (!Number.isSafeInteger(id) || !db.prepare(`
    SELECT 1 FROM works WHERE id = ? AND household_id = ? AND archived_at IS NULL
  `).get(id, context.household_id)) {
    throw Object.assign(new Error("Work not found in this household"), { status: 404 });
  }
  const existing = db.prepare(`
    SELECT id FROM loan_holds
    WHERE household_id = ? AND work_id = ? AND requested_by = ? AND status = 'waiting'
  `).get(context.household_id, id, userId);
  if (existing) throw Object.assign(new Error("You already have an active hold on this work"), { status: 409 });
  const position = db.prepare(`
    SELECT COALESCE(MAX(queue_position), 0) + 1 AS position
    FROM loan_holds WHERE household_id = ? AND work_id = ? AND status = 'waiting'
  `).get(context.household_id, id).position;
  const result = db.prepare(`
    INSERT INTO loan_holds (household_id, work_id, requested_by, queue_position)
    VALUES (?, ?, ?, ?)
  `).run(context.household_id, id, userId, position);
  return { id: String(result.lastInsertRowid), queuePosition: position };
}

export function cancelHold(db, context, userId, holdId) {
  const id = Number(holdId);
  const hold = db.prepare(`
    SELECT * FROM loan_holds WHERE id = ? AND household_id = ? AND status = 'waiting'
  `).get(id, context.household_id);
  if (!hold) throw Object.assign(new Error("Active hold not found"), { status: 404 });
  if (hold.requested_by !== userId && !isHouseholdAdmin(context)) {
    throw Object.assign(new Error("Only the requester or a household administrator can cancel this hold"), { status: 403 });
  }
  db.prepare("UPDATE loan_holds SET status = 'cancelled' WHERE id = ?").run(id);
  return { ok: true };
}
