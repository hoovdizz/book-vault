import { DatabaseSync } from "node:sqlite";
import {
  createReadStream,
  createWriteStream,
  existsSync,
} from "node:fs";
import {
  mkdir,
  open,
  readdir,
  rename,
  stat,
  statfs,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import { databasePath } from "./database.mjs";
import { DATABASE_SCHEMA_VERSION } from "./migrations.mjs";
import { assertHouseholdAdmin, isSystemAdmin } from "./households.mjs";
import { coverCacheSize } from "./covers.mjs";
import { providerSettings } from "./metadata.mjs";

const configRoot = dirname(resolve(databasePath));
const backupDirectory = join(configRoot, "backups");
const coverDirectory = join(configRoot, "covers");
const pendingRestoreDatabase = join(configRoot, ".restore-pending.sqlite");
const pendingRestoreCovers = join(configRoot, ".restore-pending-covers");
const restoreMarker = join(configRoot, ".book-vault-restore.json");

function parseJson(value, fallback) {
  try { return JSON.parse(value || JSON.stringify(fallback)); } catch { return fallback; }
}

function safeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function octal(value, length) {
  return `${Math.max(0, Number(value) || 0).toString(8).padStart(length - 1, "0")}\0`;
}

function tarHeader(name, size, modifiedAt = new Date()) {
  const normalizedName = String(name).replaceAll("\\", "/");
  if (!normalizedName || Buffer.byteLength(normalizedName) > 100 || normalizedName.includes("..")) {
    throw new Error("Backup archive path is invalid or too long");
  }
  const header = Buffer.alloc(512);
  header.write(normalizedName, 0, 100, "utf8");
  header.write(octal(0o600, 8), 100, 8, "ascii");
  header.write(octal(0, 8), 108, 8, "ascii");
  header.write(octal(0, 8), 116, 8, "ascii");
  header.write(octal(size, 12), 124, 12, "ascii");
  header.write(octal(Math.floor(modifiedAt.getTime() / 1000), 12), 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(octal(checksum, 8), 148, 8, "ascii");
  return header;
}

async function writeChunk(stream, chunk) {
  if (!stream.write(chunk)) await once(stream, "drain");
}

async function appendBuffer(stream, name, buffer) {
  await writeChunk(stream, tarHeader(name, buffer.length));
  await writeChunk(stream, buffer);
  const padding = (512 - (buffer.length % 512)) % 512;
  if (padding) await writeChunk(stream, Buffer.alloc(padding));
}

async function appendFile(stream, name, filePath) {
  const details = await stat(filePath);
  await writeChunk(stream, tarHeader(name, details.size, details.mtime));
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    while (position < details.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, details.size - position), position);
      if (!bytesRead) throw new Error(`Backup source changed while reading ${name}`);
      await writeChunk(stream, buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  const padding = (512 - (details.size % 512)) % 512;
  if (padding) await writeChunk(stream, Buffer.alloc(padding));
}

async function buildArchive(snapshotPath, archivePath, manifest) {
  const temporaryPath = `${archivePath}.tmp`;
  const stream = createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 });
  try {
    await appendFile(stream, "book-vault.sqlite", snapshotPath);
    await appendBuffer(stream, "manifest.json", Buffer.from(JSON.stringify(manifest, null, 2), "utf8"));
    if (existsSync(coverDirectory)) {
      const covers = await readdir(coverDirectory, { withFileTypes: true });
      for (const cover of covers) {
        if (!cover.isFile() || !/^edition-[1-9]\d*\.(?:jpg|jpeg|png|gif|webp)$/i.test(cover.name)) continue;
        await appendFile(stream, `covers/${cover.name}`, join(coverDirectory, cover.name));
      }
    }
    await writeChunk(stream, Buffer.alloc(1024));
    stream.end();
    await once(stream, "close");
    await rename(temporaryPath, archivePath);
  } catch (error) {
    stream.destroy();
    try { await unlink(temporaryPath); } catch {}
    throw error;
  }
}

function tarNumber(buffer, start, length) {
  const value = buffer.subarray(start, start + length).toString("ascii").replace(/\0.*$/, "").trim();
  return value ? Number.parseInt(value, 8) : 0;
}

async function archiveEntries(archivePath) {
  const details = await stat(archivePath);
  const handle = await open(archivePath, "r");
  const entries = [];
  try {
    let offset = 0;
    while (offset + 512 <= details.size) {
      const header = Buffer.alloc(512);
      const { bytesRead } = await handle.read(header, 0, 512, offset);
      if (bytesRead !== 512) throw new Error("Backup archive has a truncated header");
      if (header.every(byte => byte === 0)) break;
      const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
      const size = tarNumber(header, 124, 12);
      const type = String.fromCharCode(header[156] || 0x30);
      if (!name || name.includes("..") || name.startsWith("/") || !["0", "\0"].includes(type)) {
        throw new Error("Backup archive contains an unsafe entry");
      }
      const dataOffset = offset + 512;
      if (dataOffset + size > details.size) throw new Error("Backup archive entry is truncated");
      entries.push({ name, size, offset: dataOffset });
      offset = dataOffset + size + ((512 - (size % 512)) % 512);
    }
  } finally {
    await handle.close();
  }
  return entries;
}

async function extractEntry(archivePath, entry, destination) {
  await mkdir(dirname(destination), { recursive: true });
  const temporaryPath = `${destination}.tmp`;
  const source = createReadStream(archivePath, {
    start: entry.offset,
    end: entry.offset + entry.size - 1,
  });
  const target = createWriteStream(temporaryPath, { flags: "w", mode: 0o600 });
  await pipeline(source, target);
  await rename(temporaryPath, destination);
}

export function validateSqliteFile(path) {
  let snapshot;
  try {
    snapshot = new DatabaseSync(path, { readOnly: true });
    snapshot.exec("PRAGMA foreign_keys = ON");
    const integrity = snapshot.prepare("PRAGMA integrity_check").all().map(row => Object.values(row)[0]);
    if (integrity.length !== 1 || integrity[0] !== "ok") throw new Error(`SQLite integrity check failed: ${integrity.join("; ")}`);
    const version = snapshot.prepare(`
      SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations
    `).get().version;
    if (version > DATABASE_SCHEMA_VERSION) {
      throw new Error(`Backup database version ${version} is newer than this application supports`);
    }
    const counts = {
      users: snapshot.prepare("SELECT COUNT(*) AS count FROM users").get().count,
      households: snapshot.prepare("SELECT COUNT(*) AS count FROM households").get().count,
      works: snapshot.prepare("SELECT COUNT(*) AS count FROM works").get().count,
      editions: snapshot.prepare("SELECT COUNT(*) AS count FROM editions").get().count,
      copies: snapshot.prepare("SELECT COUNT(*) AS count FROM copies").get().count,
    };
    return { integrity: "ok", databaseVersion: version, counts };
  } finally {
    snapshot?.close();
  }
}

async function createSnapshot(db, snapshotPath) {
  db.exec("PRAGMA wal_checkpoint(FULL)");
  db.prepare("VACUUM INTO ?").run(snapshotPath);
  return validateSqliteFile(snapshotPath);
}

async function pruneBackups(db, householdId, retention) {
  const rows = db.prepare(`
    SELECT id, path FROM backup_records
    WHERE household_id = ? AND status = 'complete'
    ORDER BY completed_at DESC, id DESC
  `).all(householdId);
  for (const backup of rows.slice(retention)) {
    const path = resolve(backup.path);
    if (path.startsWith(resolve(backupDirectory))) {
      try { await unlink(path); } catch {}
    }
    db.prepare(`
      UPDATE backup_records SET status = 'pruned', path = '', error_message = NULL
      WHERE id = ?
    `).run(backup.id);
  }
}

export async function createBackup(db, context, userId, backupType = "manual") {
  if (context) assertHouseholdAdmin(context);
  await mkdir(backupDirectory, { recursive: true });
  const householdId = context?.household_id || null;
  const stamp = safeTimestamp();
  const snapshotPath = join(backupDirectory, `.snapshot-${stamp}.sqlite`);
  const archivePath = join(backupDirectory, `book-vault-${backupType}-${stamp}.tar`);
  const record = db.prepare(`
    INSERT INTO backup_records (household_id, requested_by, backup_type, path, status)
    VALUES (?, ?, ?, ?, 'running')
  `).run(householdId, userId || null, backupType, archivePath);
  const recordId = Number(record.lastInsertRowid);
  try {
    const validation = await createSnapshot(db, snapshotPath);
    await buildArchive(snapshotPath, archivePath, {
      application: "Book Vault",
      formatVersion: 1,
      createdAt: new Date().toISOString(),
      databaseVersion: validation.databaseVersion,
      householdId: householdId ? String(householdId) : null,
      includes: ["database", "covers"],
      counts: validation.counts,
    });
    const size = (await stat(archivePath)).size;
    db.prepare(`
      UPDATE backup_records SET size_bytes = ?, integrity_status = 'ok',
        status = 'complete', completed_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(size, recordId);
    if (householdId) {
      const retention = db.prepare("SELECT backup_retention FROM households WHERE id = ?").get(householdId)?.backup_retention || 14;
      await pruneBackups(db, householdId, retention);
    }
    return {
      id: String(recordId),
      filename: basename(archivePath),
      size,
      status: "complete",
      integrity: "ok",
      counts: validation.counts,
    };
  } catch (error) {
    db.prepare(`
      UPDATE backup_records SET status = 'failed', error_message = ?,
        completed_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(String(error.message || error).slice(0, 1000), recordId);
    try { await unlink(archivePath); } catch {}
    throw error;
  } finally {
    try { await unlink(snapshotPath); } catch {}
  }
}

export function listBackups(db, context) {
  assertHouseholdAdmin(context);
  const rows = db.prepare(`
    SELECT id, backup_type, path, size_bytes, integrity_status, status,
      error_message, created_at, completed_at
    FROM backup_records
    WHERE household_id = ? OR (household_id IS NULL AND ? = 1)
    ORDER BY created_at DESC, id DESC LIMIT 200
  `).all(context.household_id, isSystemAdmin(context) ? 1 : 0);
  return {
    backups: rows.map(row => ({
      id: String(row.id),
      type: row.backup_type,
      filename: row.path ? basename(row.path) : null,
      size: row.size_bytes,
      integrity: row.integrity_status,
      status: row.status,
      error: row.error_message,
      createdAt: row.created_at,
      completedAt: row.completed_at,
      downloadable: row.status === "complete" && Boolean(row.path),
    })),
  };
}

export function backupPath(db, context, backupId) {
  assertHouseholdAdmin(context);
  const row = db.prepare(`
    SELECT * FROM backup_records WHERE id = ? AND status = 'complete'
      AND (household_id = ? OR (? = 1 AND household_id IS NULL))
  `).get(Number(backupId), context.household_id, isSystemAdmin(context) ? 1 : 0);
  if (!row || !row.path || !existsSync(row.path)) throw Object.assign(new Error("Backup file not found"), { status: 404 });
  const path = resolve(row.path);
  if (!path.startsWith(resolve(backupDirectory))) throw Object.assign(new Error("Invalid backup path"), { status: 500 });
  return { path, filename: basename(path), size: row.size_bytes };
}

async function archivePreview(path) {
  const entries = await archiveEntries(path);
  const databaseEntry = entries.find(entry => entry.name === "book-vault.sqlite");
  const manifestEntry = entries.find(entry => entry.name === "manifest.json");
  if (!databaseEntry || !manifestEntry || manifestEntry.size > 1024 * 1024) {
    throw new Error("Backup archive is missing its database or manifest");
  }
  const previewDirectory = join(configRoot, "imports");
  await mkdir(previewDirectory, { recursive: true });
  const previewPath = join(previewDirectory, `.restore-preview-${safeTimestamp()}.sqlite`);
  await extractEntry(path, databaseEntry, previewPath);
  try {
    const validation = validateSqliteFile(previewPath);
    const archive = await open(path, "r");
    let manifest;
    try {
      const buffer = Buffer.alloc(manifestEntry.size);
      await archive.read(buffer, 0, buffer.length, manifestEntry.offset);
      manifest = JSON.parse(buffer.toString("utf8"));
    } finally {
      await archive.close();
    }
    return {
      validation,
      manifest,
      coverFiles: entries.filter(entry => entry.name.startsWith("covers/")).length,
      entries,
    };
  } finally {
    try { await unlink(previewPath); } catch {}
  }
}

export async function previewRestore(db, context, backupId) {
  const backup = backupPath(db, context, backupId);
  const preview = await archivePreview(backup.path);
  return {
    backupId: String(backupId),
    filename: backup.filename,
    database: preview.validation,
    manifest: preview.manifest,
    coverFiles: preview.coverFiles,
    ready: true,
  };
}

export async function stageRestore(db, context, userId, backupId, confirmation) {
  assertHouseholdAdmin(context);
  if (confirmation !== "RESTORE") {
    throw Object.assign(new Error("Type RESTORE to confirm this destructive operation"), { status: 400 });
  }
  const selected = backupPath(db, context, backupId);
  const preview = await archivePreview(selected.path);
  await createBackup(db, context, userId, "pre_restore");
  const databaseEntry = preview.entries.find(entry => entry.name === "book-vault.sqlite");
  await extractEntry(selected.path, databaseEntry, pendingRestoreDatabase);
  await mkdir(pendingRestoreCovers, { recursive: true });
  for (const entry of preview.entries.filter(candidate => candidate.name.startsWith("covers/"))) {
    const filename = basename(entry.name);
    if (!/^edition-[1-9]\d*\.(?:jpg|jpeg|png|gif|webp)$/i.test(filename)) continue;
    await extractEntry(selected.path, entry, join(pendingRestoreCovers, filename));
  }
  await writeFile(restoreMarker, JSON.stringify({
    stagedAt: new Date().toISOString(),
    backupId: String(backupId),
    pendingDatabase: basename(pendingRestoreDatabase),
    pendingCovers: basename(pendingRestoreCovers),
  }), { flag: "wx", mode: 0o600 });
  return {
    staged: true,
    restartRequired: true,
    message: "Restore validated and staged. Restart the Book Vault container to apply it.",
    preview: {
      database: preview.validation,
      coverFiles: preview.coverFiles,
    },
  };
}

export async function integrityCheck(db) {
  const rows = db.prepare("PRAGMA integrity_check").all().map(row => Object.values(row)[0]);
  return { status: rows.length === 1 && rows[0] === "ok" ? "ok" : "failed", messages: rows };
}

function applicationVersion() {
  return process.env.BOOKVAULT_VERSION || process.env.npm_package_version || "development";
}

export async function adminStatus(db, context) {
  assertHouseholdAdmin(context);
  const databaseFiles = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
  let databaseSize = 0;
  for (const path of databaseFiles) {
    try { databaseSize += (await stat(path)).size; } catch {}
  }
  let storage = null;
  try {
    const info = await statfs(configRoot);
    storage = { availableBytes: info.bavail * info.bsize, totalBytes: info.blocks * info.bsize };
  } catch {}
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users WHERE disabled = 0) AS users,
      (SELECT COUNT(*) FROM households) AS households,
      (SELECT COUNT(*) FROM works WHERE household_id = ? AND archived_at IS NULL) AS works,
      (SELECT COUNT(*) FROM editions WHERE household_id = ? AND archived_at IS NULL) AS editions,
      (SELECT COUNT(*) FROM copies WHERE household_id = ? AND archived_at IS NULL AND copy_status = 'active') AS copies
  `).get(context.household_id, context.household_id, context.household_id);
  const lastBackup = db.prepare(`
    SELECT status, completed_at, error_message FROM backup_records
    WHERE household_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(context.household_id);
  const failedJobs = db.prepare(`
    SELECT id, job_type, error_message, completed_at FROM background_jobs
    WHERE household_id = ? AND status = 'failed' ORDER BY completed_at DESC LIMIT 50
  `).all(context.household_id).map(job => ({
    id: String(job.id), type: job.job_type, error: job.error_message, completedAt: job.completed_at,
  }));
  const recentJobs = db.prepare(`
    SELECT id, job_type, status, progress, details, error_message, created_at, completed_at
    FROM background_jobs WHERE household_id = ?
    ORDER BY created_at DESC LIMIT 25
  `).all(context.household_id).map(job => ({
    id: String(job.id),
    type: job.job_type,
    status: job.status,
    progress: job.progress,
    details: parseJson(job.details, {}),
    error: job.error_message,
    createdAt: job.created_at,
    completedAt: job.completed_at,
  }));
  const failedImports = db.prepare(`
    SELECT id, preset, source_filename, report_path, completed_at
    FROM import_runs WHERE household_id = ? AND status = 'failed'
    ORDER BY completed_at DESC LIMIT 25
  `).all(context.household_id).map(run => ({
    id: String(run.id),
    preset: run.preset,
    filename: run.source_filename,
    report: parseJson(run.report_path, {}),
    completedAt: run.completed_at,
  }));
  const securityEvents = db.prepare(`
    SELECT audit.id, audit.event_type, audit.target_type, audit.target_id,
      audit.created_at, users.name AS actor_name
    FROM audit_events audit LEFT JOIN users ON users.id = audit.actor_user_id
    WHERE audit.household_id = ?
      AND audit.event_type IN (
        'household_member_disabled', 'household_member_credentials_reset',
        'household_invitation_created', 'backup_restore_staged',
        'metadata_providers_updated'
      )
    ORDER BY audit.created_at DESC LIMIT 50
  `).all(context.household_id).map(event => ({
    id: String(event.id),
    type: event.event_type,
    targetType: event.target_type,
    targetId: event.target_id,
    actor: event.actor_name || "System",
    createdAt: event.created_at,
  }));
  return {
    application: { version: applicationVersion(), health: "ok", telemetry: false },
    database: {
      version: db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get().version,
      supportedVersion: DATABASE_SCHEMA_VERSION,
      sizeBytes: databaseSize,
    },
    covers: { sizeBytes: await coverCacheSize() },
    counts,
    backup: lastBackup
      ? { status: lastBackup.status, lastSuccessAt: lastBackup.status === "complete" ? lastBackup.completed_at : null, error: lastBackup.error_message }
      : { status: "never", lastSuccessAt: null, error: null },
    providers: providerSettings(db, context.household_id),
    failedJobs,
    recentJobs,
    failedImports,
    securityEvents,
    storage,
  };
}

export async function runScheduledBackups(db) {
  const households = db.prepare(`
    SELECT id, created_by, scheduled_backup, backup_retention
    FROM households WHERE scheduled_backup IS NOT NULL AND trim(scheduled_backup) <> ''
  `).all();
  const now = new Date();
  for (const household of households) {
    const match = String(household.scheduled_backup).match(/^daily@([01]\d|2[0-3]):([0-5]\d)$/);
    if (!match) continue;
    const scheduled = new Date(now);
    scheduled.setHours(Number(match[1]), Number(match[2]), 0, 0);
    if (scheduled > now) scheduled.setDate(scheduled.getDate() - 1);
    const last = db.prepare(`
      SELECT completed_at FROM backup_records
      WHERE household_id = ? AND backup_type = 'scheduled' AND status = 'complete'
      ORDER BY completed_at DESC LIMIT 1
    `).get(household.id);
    if (last && new Date(last.completed_at) >= scheduled) continue;
    const context = { household_id: household.id, household_role: "household_admin", system_role: "user" };
    try { await createBackup(db, context, household.created_by, "scheduled"); } catch {}
  }
}
