import { canEditPersonalReading } from "./households.mjs";

function text(value, max) {
  const result = String(value || "").trim();
  if (result.length > max) throw Object.assign(new Error("A reading field is too long"), { status: 400 });
  return result;
}

function optionalDate(value) {
  if (value == null || value === "") return null;
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw Object.assign(new Error("A reading date is invalid"), { status: 400 });
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? String(value) : parsed.toISOString();
}

function whole(value, label, max = 10_000_000) {
  if (value == null || value === "") return null;
  const result = Number(value);
  if (!Number.isInteger(result) || result < 0 || result > max) {
    throw Object.assign(new Error(`${label} must be a non-negative whole number`), { status: 400 });
  }
  return result;
}

function number(value, label, max = 100) {
  if (value == null || value === "") return null;
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0 || result > max) {
    throw Object.assign(new Error(`${label} is outside the allowed range`), { status: 400 });
  }
  return result;
}

function assertWork(db, householdId, workId) {
  const id = Number(workId);
  const work = Number.isSafeInteger(id) && db.prepare(`
    SELECT * FROM works WHERE id = ? AND household_id = ? AND archived_at IS NULL
  `).get(id, householdId);
  if (!work) throw Object.assign(new Error("Work not found in this household"), { status: 404 });
  return work;
}

function assertEdition(db, householdId, workId, editionId) {
  if (editionId == null || editionId === "") return null;
  const id = Number(editionId);
  const edition = Number.isSafeInteger(id) && db.prepare(`
    SELECT * FROM editions
    WHERE id = ? AND household_id = ? AND work_id = ? AND archived_at IS NULL
  `).get(id, householdId, workId);
  if (!edition) throw Object.assign(new Error("Edition does not belong to this work"), { status: 400 });
  return edition;
}

function status(db, householdId, value) {
  const key = text(value || "unread", 40).toLocaleLowerCase();
  if (!db.prepare(`
    SELECT 1 FROM household_reading_statuses
    WHERE household_id = ? AND status_key = ? AND enabled = 1
  `).get(householdId, key)) {
    throw Object.assign(new Error("That reading status is not enabled for this household"), { status: 400 });
  }
  return key;
}

function rating(db, householdId, value) {
  if (value == null || value === "") return null;
  const household = db.prepare(`
    SELECT rating_scale, rating_increment FROM households WHERE id = ?
  `).get(householdId);
  const result = Number(value);
  const maximum = household.rating_scale === "points10" ? 10 : 5;
  const increment = Number(household.rating_increment);
  const multiple = Math.abs(result / increment - Math.round(result / increment)) < 0.000001;
  if (!Number.isFinite(result) || result < 0 || result > maximum || !multiple) {
    throw Object.assign(new Error(`Rating must be from 0 to ${maximum} in ${increment}-point increments`), { status: 400 });
  }
  return result;
}

function publicState(row, own) {
  if (!row) return null;
  return {
    workId: String(row.work_id),
    editionId: row.edition_id ? String(row.edition_id) : null,
    status: row.status_key,
    rating: row.rating,
    favorite: Boolean(row.favorite),
    privateNotes: own ? row.private_notes || "" : undefined,
    householdNotes: row.household_notes || "",
    preferredFormats: JSON.parse(row.preferred_formats || "[]"),
    updatedAt: row.updated_at,
  };
}

function publicSession(row, own) {
  return {
    id: String(row.id),
    workId: String(row.work_id),
    editionId: row.edition_id ? String(row.edition_id) : null,
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
    progress: row.progress_value,
    progressUnit: row.progress_unit || null,
    currentPage: row.current_page,
    percentage: row.percentage,
    minutesRead: row.minutes_read,
    audiobookMinutes: row.audiobook_minutes,
    formatUsed: row.format_used || null,
    rating: row.rating,
    privateNotes: own ? row.private_notes || "" : undefined,
    householdNotes: row.household_notes || "",
    favorite: Boolean(row.favorite),
    reread: Boolean(row.reread),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function readingDetail(db, context, viewerUserId, workId, requestedUserId = viewerUserId) {
  const work = assertWork(db, context.household_id, workId);
  const targetUserId = Number(requestedUserId);
  if (!db.prepare(`
    SELECT 1 FROM household_members
    WHERE household_id = ? AND user_id = ? AND disabled = 0
  `).get(context.household_id, targetUserId)) {
    throw Object.assign(new Error("Household member not found"), { status: 404 });
  }
  const own = targetUserId === viewerUserId;
  const state = db.prepare(`
    SELECT * FROM user_work_state WHERE user_id = ? AND work_id = ?
  `).get(targetUserId, work.id);
  const sessions = db.prepare(`
    SELECT * FROM reading_sessions
    WHERE household_id = ? AND user_id = ? AND work_id = ?
    ORDER BY COALESCE(finished_at, started_at, created_at) DESC, id DESC
  `).all(context.household_id, targetUserId, work.id);
  return {
    work: { id: String(work.id), title: work.title, author: work.primary_author },
    userId: String(targetUserId),
    state: publicState(state, own),
    sessions: sessions.map(session => publicSession(session, own)),
  };
}

export function updateReadingState(db, context, userId, workId, input) {
  if (!canEditPersonalReading(context)) throw Object.assign(new Error("This role cannot change reading activity"), { status: 403 });
  const work = assertWork(db, context.household_id, workId);
  const edition = assertEdition(db, context.household_id, work.id, input.editionId);
  const statusKey = status(db, context.household_id, input.status);
  const current = db.prepare(`
    SELECT * FROM user_work_state WHERE user_id = ? AND work_id = ?
  `).get(userId, work.id);
  const personalRating = input.rating === undefined ? current?.rating ?? null : rating(db, context.household_id, input.rating);
  const favorite = input.favorite === undefined ? Boolean(current?.favorite) : input.favorite === true;
  const privateNotes = input.privateNotes === undefined ? current?.private_notes ?? null : text(input.privateNotes, 5000) || null;
  const householdNotes = input.householdNotes === undefined ? current?.household_notes ?? null : text(input.householdNotes, 5000) || null;
  const preferredFormats = Array.isArray(input.preferredFormats)
    ? [...new Set(input.preferredFormats)].filter(format => ["physical", "ebook", "audiobook"].includes(format)).slice(0, 3)
    : JSON.parse(current?.preferred_formats || "[]");
  try {
    db.exec("BEGIN IMMEDIATE");
    db.prepare(`
      INSERT INTO user_work_state (
        user_id, work_id, edition_id, status_key, rating, favorite,
        private_notes, household_notes, preferred_formats, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, work_id) DO UPDATE SET
        edition_id = excluded.edition_id,
        status_key = excluded.status_key,
        rating = excluded.rating,
        favorite = excluded.favorite,
        private_notes = excluded.private_notes,
        household_notes = excluded.household_notes,
        preferred_formats = excluded.preferred_formats,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      userId,
      work.id,
      edition?.id || current?.edition_id || null,
      statusKey,
      personalRating,
      favorite ? 1 : 0,
      privateNotes,
      householdNotes,
      JSON.stringify(preferredFormats),
    );
    if (!current || current.status_key !== statusKey) {
      db.prepare(`
        INSERT INTO reading_state_history (
          user_id, work_id, edition_id, status_key, source
        ) VALUES (?, ?, ?, ?, 'user')
      `).run(userId, work.id, edition?.id || current?.edition_id || null, statusKey);
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
  return publicState(db.prepare(`
    SELECT * FROM user_work_state WHERE user_id = ? AND work_id = ?
  `).get(userId, work.id), true);
}

function sessionValues(db, context, input, existing = {}) {
  const startedAt = input.startedAt === undefined ? existing.started_at ?? null : optionalDate(input.startedAt);
  const finishedAt = input.finishedAt === undefined ? existing.finished_at ?? null : optionalDate(input.finishedAt);
  if (startedAt && finishedAt && finishedAt < startedAt) {
    throw Object.assign(new Error("Finish date cannot precede start date"), { status: 400 });
  }
  const formatUsed = input.formatUsed === undefined ? existing.format_used ?? null : text(input.formatUsed, 30) || null;
  if (formatUsed && !["physical", "ebook", "audiobook"].includes(formatUsed)) {
    throw Object.assign(new Error("Invalid reading format"), { status: 400 });
  }
  const percentage = input.percentage === undefined ? existing.percentage ?? null : number(input.percentage, "Percentage", 100);
  return {
    startedAt,
    finishedAt,
    progress: input.progress === undefined ? existing.progress_value ?? null : number(input.progress, "Progress", 10_000_000),
    progressUnit: input.progressUnit === undefined ? existing.progress_unit ?? null : text(input.progressUnit, 30) || null,
    currentPage: input.currentPage === undefined ? existing.current_page ?? null : whole(input.currentPage, "Current page"),
    percentage,
    minutesRead: input.minutesRead === undefined ? existing.minutes_read ?? null : whole(input.minutesRead, "Minutes read"),
    audiobookMinutes: input.audiobookMinutes === undefined ? existing.audiobook_minutes ?? null : whole(input.audiobookMinutes, "Audiobook minutes"),
    formatUsed,
    rating: input.rating === undefined ? existing.rating ?? null : rating(db, context.household_id, input.rating),
    privateNotes: input.privateNotes === undefined ? existing.private_notes ?? null : text(input.privateNotes, 5000) || null,
    householdNotes: input.householdNotes === undefined ? existing.household_notes ?? null : text(input.householdNotes, 5000) || null,
    favorite: input.favorite === undefined ? Boolean(existing.favorite) : input.favorite === true,
    reread: input.reread === undefined ? Boolean(existing.reread) : input.reread === true,
  };
}

export function createReadingSession(db, context, userId, workId, input) {
  if (!canEditPersonalReading(context)) throw Object.assign(new Error("This role cannot change reading activity"), { status: 403 });
  const work = assertWork(db, context.household_id, workId);
  const edition = assertEdition(db, context.household_id, work.id, input.editionId);
  const values = sessionValues(db, context, input);
  const result = db.prepare(`
    INSERT INTO reading_sessions (
      household_id, user_id, work_id, edition_id, started_at, finished_at,
      progress_value, progress_unit, current_page, percentage, minutes_read,
      audiobook_minutes, format_used, rating, private_notes, household_notes,
      favorite, reread
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    context.household_id,
    userId,
    work.id,
    edition?.id || null,
    values.startedAt,
    values.finishedAt,
    values.progress,
    values.progressUnit,
    values.currentPage,
    values.percentage,
    values.minutesRead,
    values.audiobookMinutes,
    values.formatUsed,
    values.rating,
    values.privateNotes,
    values.householdNotes,
    values.favorite ? 1 : 0,
    values.reread ? 1 : 0,
  );
  if (values.finishedAt) updateReadingState(db, context, userId, work.id, {
    status: "read",
    editionId: edition?.id,
    rating: values.rating,
    favorite: values.favorite,
  });
  return publicSession(db.prepare("SELECT * FROM reading_sessions WHERE id = ?").get(result.lastInsertRowid), true);
}

export function updateReadingSession(db, context, userId, sessionId, input) {
  if (!canEditPersonalReading(context)) throw Object.assign(new Error("This role cannot change reading activity"), { status: 403 });
  const id = Number(sessionId);
  const existing = db.prepare(`
    SELECT * FROM reading_sessions
    WHERE id = ? AND household_id = ? AND user_id = ?
  `).get(id, context.household_id, userId);
  if (!existing) throw Object.assign(new Error("Reading session not found"), { status: 404 });
  const edition = input.editionId === undefined
    ? (existing.edition_id ? assertEdition(db, context.household_id, existing.work_id, existing.edition_id) : null)
    : assertEdition(db, context.household_id, existing.work_id, input.editionId);
  const values = sessionValues(db, context, input, existing);
  db.prepare(`
    UPDATE reading_sessions SET edition_id = ?, started_at = ?, finished_at = ?,
      progress_value = ?, progress_unit = ?, current_page = ?, percentage = ?,
      minutes_read = ?, audiobook_minutes = ?, format_used = ?, rating = ?,
      private_notes = ?, household_notes = ?, favorite = ?, reread = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
  `).run(
    edition?.id || null,
    values.startedAt,
    values.finishedAt,
    values.progress,
    values.progressUnit,
    values.currentPage,
    values.percentage,
    values.minutesRead,
    values.audiobookMinutes,
    values.formatUsed,
    values.rating,
    values.privateNotes,
    values.householdNotes,
    values.favorite ? 1 : 0,
    values.reread ? 1 : 0,
    id,
    userId,
  );
  if (values.finishedAt && !existing.finished_at) {
    updateReadingState(db, context, userId, existing.work_id, {
      status: "read",
      editionId: edition?.id,
      rating: values.rating,
      favorite: values.favorite,
    });
  }
  return publicSession(db.prepare("SELECT * FROM reading_sessions WHERE id = ?").get(id), true);
}

function parseJson(value, fallback) {
  try { return JSON.parse(value || JSON.stringify(fallback)); } catch { return fallback; }
}

export function updateReadingPreferences(db, context, userId, input) {
  if (!canEditPersonalReading(context)) throw Object.assign(new Error("This role cannot change reading preferences"), { status: 403 });
  const year = new Date().getFullYear();
  const goal = input.goal == null ? {} : input.goal;
  const normalizedGoal = {
    year: Number.isInteger(Number(goal.year)) ? Number(goal.year) : year,
    books: whole(goal.books, "Book goal", 10000),
    pages: whole(goal.pages, "Page goal", 100_000_000),
    minutes: whole(goal.minutes, "Minute goal", 100_000_000),
  };
  const formats = Array.isArray(input.preferredFormats)
    ? [...new Set(input.preferredFormats)].filter(format => ["physical", "ebook", "audiobook"].includes(format))
    : [];
  db.prepare(`
    INSERT INTO user_preferences (user_id, reading_goal, preferred_formats)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      reading_goal = excluded.reading_goal,
      preferred_formats = excluded.preferred_formats,
      updated_at = CURRENT_TIMESTAMP
  `).run(userId, JSON.stringify(normalizedGoal), JSON.stringify(formats));
  return { goal: normalizedGoal, preferredFormats: formats };
}

export function readingStatistics(db, context, userId) {
  const totals = db.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE finished_at IS NOT NULL) AS books_completed,
      COALESCE(SUM(minutes_read), 0) AS minutes_read,
      COALESCE(SUM(audiobook_minutes), 0) AS audiobook_minutes,
      COUNT(*) FILTER (WHERE reread = 1 AND finished_at IS NOT NULL) AS rereads,
      AVG(rating) FILTER (WHERE rating IS NOT NULL) AS average_rating
    FROM reading_sessions
    WHERE household_id = ? AND user_id = ?
  `).get(context.household_id, userId);
  const pages = db.prepare(`
    SELECT COALESCE(SUM(
      CASE
        WHEN session.finished_at IS NOT NULL THEN COALESCE(edition.page_count, session.current_page, 0)
        ELSE COALESCE(session.current_page, 0)
      END
    ), 0) AS pages
    FROM reading_sessions session
    LEFT JOIN editions edition ON edition.id = session.edition_id
    WHERE session.household_id = ? AND session.user_id = ?
  `).get(context.household_id, userId).pages;
  const byFormat = db.prepare(`
    SELECT COALESCE(format_used, 'unspecified') AS label, COUNT(*) AS count
    FROM reading_sessions
    WHERE household_id = ? AND user_id = ? AND finished_at IS NOT NULL
    GROUP BY COALESCE(format_used, 'unspecified') ORDER BY count DESC
  `).all(context.household_id, userId);
  const byAuthor = db.prepare(`
    SELECT work.primary_author AS label, COUNT(*) AS count
    FROM reading_sessions session
    JOIN works work ON work.id = session.work_id
    WHERE session.household_id = ? AND session.user_id = ? AND session.finished_at IS NOT NULL
    GROUP BY work.normalized_author, work.primary_author ORDER BY count DESC, label LIMIT 20
  `).all(context.household_id, userId);
  const byGenre = db.prepare(`
    SELECT tag.name AS label, COUNT(DISTINCT session.id) AS count
    FROM reading_sessions session
    JOIN work_tags link ON link.work_id = session.work_id
    JOIN tags tag ON tag.id = link.tag_id
    WHERE session.household_id = ? AND session.user_id = ? AND session.finished_at IS NOT NULL
    GROUP BY tag.id, tag.name ORDER BY count DESC, label LIMIT 20
  `).all(context.household_id, userId);
  const byMonth = db.prepare(`
    SELECT substr(finished_at, 1, 7) AS label, COUNT(*) AS count
    FROM reading_sessions
    WHERE household_id = ? AND user_id = ? AND finished_at IS NOT NULL
    GROUP BY substr(finished_at, 1, 7) ORDER BY label
  `).all(context.household_id, userId);
  const dnf = db.prepare(`
    SELECT COUNT(*) AS count FROM user_work_state
    JOIN works ON works.id = user_work_state.work_id
    WHERE user_work_state.user_id = ? AND works.household_id = ?
      AND user_work_state.status_key IN ('did_not_finish', 'abandoned')
  `).get(userId, context.household_id).count;
  const readingDays = db.prepare(`
    SELECT DISTINCT substr(COALESCE(finished_at, started_at), 1, 10) AS day
    FROM reading_sessions
    WHERE household_id = ? AND user_id = ?
      AND COALESCE(finished_at, started_at) IS NOT NULL
    ORDER BY day DESC
  `).all(context.household_id, userId).map(row => row.day);
  let streak = 0;
  let cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  const days = new Set(readingDays);
  if (!days.has(cursor.toISOString().slice(0, 10))) cursor.setDate(cursor.getDate() - 1);
  while (days.has(cursor.toISOString().slice(0, 10))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  const preferences = db.prepare(`
    SELECT reading_goal, preferred_formats FROM user_preferences WHERE user_id = ?
  `).get(userId);
  return {
    totals: {
      booksCompleted: totals.books_completed,
      pagesRead: pages,
      minutesRead: totals.minutes_read,
      audiobookMinutes: totals.audiobook_minutes,
      audiobookHours: Math.round((totals.audiobook_minutes / 60) * 10) / 10,
      readingStreakDays: streak,
      averageRating: totals.average_rating,
      didNotFinish: dnf,
      rereads: totals.rereads,
    },
    byFormat,
    byGenre,
    byAuthor,
    byMonth,
    goals: parseJson(preferences?.reading_goal, {}),
    preferredFormats: parseJson(preferences?.preferred_formats, []),
  };
}

export function householdReadingStatistics(db, context) {
  const inventory = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM works WHERE household_id = ? AND archived_at IS NULL) AS works,
      (SELECT COUNT(*) FROM editions WHERE household_id = ? AND archived_at IS NULL) AS editions,
      (SELECT COUNT(*) FROM copies WHERE household_id = ? AND archived_at IS NULL AND copy_status = 'active') AS copies,
      (SELECT COUNT(*) FROM loans WHERE household_id = ? AND returned_at IS NULL) AS active_loans,
      (SELECT COUNT(*) FROM loans WHERE household_id = ? AND returned_at IS NULL AND due_at < CURRENT_TIMESTAMP) AS overdue,
      (SELECT COUNT(*) FROM copies WHERE household_id = ? AND archived_at IS NOT NULL) AS previously_owned,
      (SELECT COUNT(*) FROM (
        SELECT edition.work_id
        FROM copies copy
        JOIN editions edition ON edition.id = copy.edition_id
        LEFT JOIN user_work_state state ON state.work_id = edition.work_id
        WHERE copy.household_id = ? AND copy.archived_at IS NULL
        GROUP BY edition.work_id
        HAVING MAX(CASE WHEN state.status_key IN ('read', 'reading', 'reference') THEN 1 ELSE 0 END) = 0
      )) AS unread_household_works,
      (SELECT COUNT(*) FROM (
        SELECT edition.work_id FROM copies copy
        JOIN editions edition ON edition.id = copy.edition_id
        WHERE copy.household_id = ? AND copy.archived_at IS NULL
        GROUP BY edition.work_id HAVING COUNT(*) > 1
      )) AS duplicate_work_groups
  `).get(
    context.household_id,
    context.household_id,
    context.household_id,
    context.household_id,
    context.household_id,
    context.household_id,
    context.household_id,
    context.household_id,
  );
  const completed = db.prepare(`
    SELECT work.id, work.title, work.primary_author, COUNT(*) AS readers
    FROM reading_sessions session
    JOIN works work ON work.id = session.work_id
    WHERE session.household_id = ? AND session.finished_at IS NOT NULL
    GROUP BY work.id ORDER BY readers DESC, work.title LIMIT 20
  `).all(context.household_id);
  const perOwner = db.prepare(`
    SELECT COALESCE(users.name, 'Household') AS label, COUNT(*) AS count
    FROM copies copy LEFT JOIN users ON users.id = copy.owner_user_id
    WHERE copy.household_id = ? AND copy.archived_at IS NULL AND copy.copy_status = 'active'
    GROUP BY copy.owner_user_id ORDER BY count DESC
  `).all(context.household_id);
  const perLocation = db.prepare(`
    SELECT location.name AS label, COUNT(*) AS count
    FROM copies copy JOIN locations location ON location.id = copy.location_id
    WHERE copy.household_id = ? AND copy.archived_at IS NULL AND copy.copy_status = 'active'
    GROUP BY location.id, location.name ORDER BY count DESC, label LIMIT 30
  `).all(context.household_id);
  const mostLoaned = db.prepare(`
    SELECT work.title AS label, COUNT(*) AS count
    FROM loans loan
    JOIN copies copy ON copy.id = loan.copy_id
    JOIN editions edition ON edition.id = copy.edition_id
    JOIN works work ON work.id = edition.work_id
    WHERE loan.household_id = ?
    GROUP BY work.id, work.title ORDER BY count DESC, label LIMIT 20
  `).all(context.household_id);
  const mostShared = db.prepare(`
    SELECT work.title AS label,
      COUNT(DISTINCT COALESCE(copy.owner_user_id, -copy.id)) AS count
    FROM copies copy
    JOIN editions edition ON edition.id = copy.edition_id
    JOIN works work ON work.id = edition.work_id
    WHERE copy.household_id = ? AND copy.archived_at IS NULL AND copy.copy_status = 'active'
    GROUP BY work.id, work.title HAVING COUNT(*) > 1
    ORDER BY count DESC, work.title LIMIT 20
  `).all(context.household_id);
  const recentlyAdded = db.prepare(`
    SELECT work.title AS label, MAX(copy.created_at) AS addedAt, COUNT(*) AS copies
    FROM copies copy
    JOIN editions edition ON edition.id = copy.edition_id
    JOIN works work ON work.id = edition.work_id
    WHERE copy.household_id = ? AND copy.archived_at IS NULL
    GROUP BY work.id, work.title ORDER BY addedAt DESC LIMIT 20
  `).all(context.household_id);
  const seriesRows = db.prepare(`
    SELECT series.id, link.volume_sort
    FROM series JOIN work_series link ON link.series_id = series.id
    JOIN editions edition ON edition.work_id = link.work_id
    JOIN copies copy ON copy.edition_id = edition.id
    WHERE series.household_id = ? AND copy.archived_at IS NULL
      AND link.volume_sort IS NOT NULL
    GROUP BY series.id, link.volume_sort
    ORDER BY series.id, link.volume_sort
  `).all(context.household_id);
  const volumesBySeries = new Map();
  for (const row of seriesRows) {
    const values = volumesBySeries.get(row.id) || [];
    values.push(Number(row.volume_sort));
    volumesBySeries.set(row.id, values);
  }
  let missingSeriesVolumes = 0;
  for (const values of volumesBySeries.values()) {
    const integers = new Set(values.filter(Number.isInteger));
    const maximum = Math.max(0, ...integers);
    for (let volume = 1; volume <= maximum; volume += 1) {
      if (!integers.has(volume)) missingSeriesVolumes += 1;
    }
  }
  return {
    inventory: {
      ...inventory,
      unread_household_works: inventory.unread_household_works || 0,
      missing_series_volumes: missingSeriesVolumes,
    },
    mostRead: completed,
    copiesPerOwner: perOwner,
    copiesPerLocation: perLocation,
    mostLoaned,
    mostShared,
    recentlyAdded,
  };
}
