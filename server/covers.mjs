import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { databasePath } from "./database.mjs";
import { normalizeCoverUrl } from "./book-search.mjs";
import { canEditInventory } from "./households.mjs";

export const MAX_COVER_BYTES = 5 * 1024 * 1024;
const coverDirectory = join(dirname(databasePath), "covers");

function imageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { extension: ".jpg", mime: "image/jpeg" };
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension: ".png", mime: "image/png" };
  }
  if (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a") {
    return { extension: ".gif", mime: "image/gif" };
  }
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return { extension: ".webp", mime: "image/webp" };
  }
  return null;
}

function editionForHousehold(db, householdId, editionId) {
  const id = Number(editionId);
  const edition = Number.isSafeInteger(id) && db.prepare(`
    SELECT edition.id, edition.cover_path, edition.work_id
    FROM editions edition
    WHERE edition.id = ? AND edition.household_id = ? AND edition.archived_at IS NULL
  `).get(id, householdId);
  if (!edition) throw Object.assign(new Error("Edition cover not found"), { status: 404 });
  return edition;
}

async function saveCover(db, edition, buffer, source) {
  if (buffer.length > MAX_COVER_BYTES) throw Object.assign(new Error("Cover image is larger than 5 MB"), { status: 413 });
  const type = imageType(buffer);
  if (!type) throw Object.assign(new Error("Cover must be an actual JPEG, PNG, GIF, or WebP image"), { status: 400 });
  await mkdir(coverDirectory, { recursive: true });
  const filename = `edition-${edition.id}${type.extension}`;
  const finalPath = resolve(coverDirectory, filename);
  if (!finalPath.startsWith(`${resolve(coverDirectory)}\\`) && !finalPath.startsWith(`${resolve(coverDirectory)}/`)) {
    throw Object.assign(new Error("Invalid cover path"), { status: 400 });
  }
  const temporaryPath = join(coverDirectory, `.cover-${randomBytes(8).toString("hex")}.tmp`);
  await writeFile(temporaryPath, buffer, { flag: "wx" });
  try {
    await rename(temporaryPath, finalPath);
  } catch (error) {
    if (!["EEXIST", "EPERM"].includes(error?.code)) throw error;
    await unlink(finalPath);
    await rename(temporaryPath, finalPath);
  }
  const previousPath = edition.cover_path;
  db.prepare(`
    UPDATE editions SET cover_path = ?, updated_at = CURRENT_TIMESTAMP,
      field_provenance = json_set(COALESCE(field_provenance, '{}'), '$.cover', ?),
      manual_overrides = CASE
        WHEN ? = 'manual_upload' AND NOT EXISTS (
          SELECT 1 FROM json_each(COALESCE(manual_overrides, '[]')) WHERE value = 'coverUrl'
        )
        THEN json_insert(COALESCE(manual_overrides, '[]'), '$[#]', 'coverUrl')
        ELSE manual_overrides
      END
    WHERE id = ?
  `).run(`covers/${filename}`, source, source, edition.id);
  if (previousPath && previousPath !== `covers/${filename}`) {
    const oldPath = resolve(dirname(databasePath), previousPath);
    if (oldPath.startsWith(resolve(coverDirectory))) {
      try { await unlink(oldPath); } catch {}
    }
  }
  return { url: `/api/covers/${edition.id}`, size: buffer.length, mime: type.mime };
}

export async function cacheExternalCover(db, householdId, editionId, value) {
  const url = normalizeCoverUrl(value);
  if (!url) throw Object.assign(new Error("Unsupported cover URL"), { status: 400 });
  const edition = editionForHousehold(db, householdId, editionId);
  const response = await fetch(url, {
    headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif", "User-Agent": "BookVault/1.0" },
    redirect: "follow",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw Object.assign(new Error(`Cover provider returned HTTP ${response.status}`), { status: 502 });
  const finalUrl = normalizeCoverUrl(response.url);
  if (!finalUrl) throw Object.assign(new Error("Cover provider redirected to an unsupported host"), { status: 502 });
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_COVER_BYTES) throw Object.assign(new Error("Cover image is larger than 5 MB"), { status: 413 });
  const arrayBuffer = await response.arrayBuffer();
  return saveCover(db, edition, Buffer.from(arrayBuffer), "provider_cache");
}

export async function uploadCover(db, context, editionId, buffer) {
  if (!canEditInventory(context)) throw Object.assign(new Error("This role cannot change edition covers"), { status: 403 });
  const edition = editionForHousehold(db, context.household_id, editionId);
  return saveCover(db, edition, buffer, "manual_upload");
}

export async function readCover(db, context, editionId) {
  const edition = editionForHousehold(db, context.household_id, editionId);
  if (!edition.cover_path) throw Object.assign(new Error("Cached cover not found"), { status: 404 });
  const path = resolve(dirname(databasePath), edition.cover_path);
  const root = resolve(coverDirectory);
  if (!path.startsWith(`${root}\\`) && !path.startsWith(`${root}/`)) {
    throw Object.assign(new Error("Invalid cached cover path"), { status: 500 });
  }
  let buffer;
  try { buffer = await readFile(path); } catch {
    throw Object.assign(new Error("Cached cover file is missing"), { status: 404 });
  }
  const type = imageType(buffer);
  if (!type) throw Object.assign(new Error("Cached cover is invalid"), { status: 500 });
  return { buffer, mime: type.mime, etag: `"${edition.id}-${buffer.length}"` };
}

export async function coverCacheSize() {
  await mkdir(coverDirectory, { recursive: true });
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(coverDirectory, { withFileTypes: true });
  let size = 0;
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    try { size += (await stat(join(coverDirectory, entry.name))).size; } catch {}
  }
  return size;
}
