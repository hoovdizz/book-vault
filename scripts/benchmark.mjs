import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

const workCount = Math.max(1, Number(process.env.BENCHMARK_WORKS || 25_000));
const editionCount = Math.max(workCount, Number(process.env.BENCHMARK_EDITIONS || 35_000));
const copyCount = Math.max(editionCount, Number(process.env.BENCHMARK_COPIES || 50_000));
const suppliedPath = process.env.BENCHMARK_DATABASE_PATH;
const databasePath = resolve(suppliedPath || `${tmpdir()}/book-vault-benchmark-${process.pid}.sqlite`);

if (existsSync(databasePath)) {
  throw new Error(`Refusing to overwrite existing benchmark database: ${databasePath}`);
}

process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_NAME = "Benchmark Administrator";
process.env.ADMIN_EMAIL = "benchmark@bookvault.invalid";
process.env.ADMIN_PASSWORD = "benchmark-password-not-for-production";

const { db, ensureAdmin } = await import("../server/database.mjs");
const { listCatalog, duplicateWarnings } = await import("../server/catalog.mjs");
await ensureAdmin();

const user = db.prepare("SELECT id FROM users WHERE email = ?").get(process.env.ADMIN_EMAIL);
const membership = db.prepare(`
  SELECT member.household_id, member.household_role, user.system_role
  FROM household_members member JOIN users user ON user.id = member.user_id
  WHERE member.user_id = ?
`).get(user.id);
const context = { ...membership, user_id: user.id };

function isbn13(index) {
  const base = `978${String(index).padStart(9, "0").slice(-9)}`;
  let sum = 0;
  for (let position = 0; position < 12; position += 1) {
    sum += Number(base[position]) * (position % 2 === 0 ? 1 : 3);
  }
  return `${base}${(10 - (sum % 10)) % 10}`;
}

const insertWork = db.prepare(`
  INSERT INTO works (
    household_id, title, normalized_title, primary_author, normalized_author,
    metadata_quality, created_by
  ) VALUES (?, ?, ?, ?, ?, 'reviewed', ?)
`);
const insertEdition = db.prepare(`
  INSERT INTO editions (
    household_id, work_id, isbn13, original_isbn, publisher, binding,
    media_format, language, publication_date, page_count, provider
  ) VALUES (?, ?, ?, ?, 'Benchmark Press', ?, 'physical', 'en', ?, ?, 'manual')
`);
const insertCopy = db.prepare(`
  INSERT INTO copies (
    household_id, edition_id, owner_user_id, format, condition_grade,
    copy_status, added_by, acquired_at
  ) VALUES (?, ?, ?, ?, 'good', 'active', ?, date('now'))
`);

const seedStarted = performance.now();
db.exec("BEGIN IMMEDIATE");
try {
  for (let index = 1; index <= workCount; index += 1) {
    const title = `Benchmark Book ${String(index).padStart(5, "0")}`;
    const author = `Author ${index % 1_000}`;
    insertWork.run(context.household_id, title, title.toLowerCase(), author, author.toLowerCase(), user.id);
  }
  for (let index = 1; index <= editionCount; index += 1) {
    const isbn = isbn13(index);
    insertEdition.run(
      context.household_id,
      ((index - 1) % workCount) + 1,
      isbn,
      isbn,
      index % 2 === 0 ? "hardcover" : "paperback",
      `${1980 + (index % 47)}-01-01`,
      100 + (index % 900),
    );
  }
  for (let index = 1; index <= copyCount; index += 1) {
    insertCopy.run(
      context.household_id,
      ((index - 1) % editionCount) + 1,
      index % 5 === 0 ? null : user.id,
      index % 10 === 0 ? "ebook" : "physical",
      user.id,
    );
  }
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}
db.exec("ANALYZE");

const timings = [];
for (let iteration = 0; iteration < 20; iteration += 1) {
  const started = performance.now();
  const result = listCatalog(db, context, user.id, {
    q: `Benchmark Book ${String(1 + ((iteration * 997) % workCount)).padStart(5, "0")}`,
    page: 1,
    pageSize: 50,
    sort: "title",
  });
  if (!result.pagination.total) throw new Error("Benchmark search returned no rows");
  timings.push(performance.now() - started);
}

const duplicateStarted = performance.now();
const duplicateResult = duplicateWarnings(db, context, { isbn: isbn13(1), title: "Benchmark Book 00001", author: "Author 1" }, user.id);
const duplicateMs = performance.now() - duplicateStarted;
timings.sort((left, right) => left - right);

const report = {
  databasePath,
  rows: { works: workCount, editions: editionCount, copies: copyCount },
  seedSeconds: Math.round(((performance.now() - seedStarted) / 1000) * 100) / 100,
  catalogSearchMs: {
    median: Math.round(timings[Math.floor(timings.length / 2)] * 100) / 100,
    p95: Math.round(timings[Math.floor(timings.length * 0.95)] * 100) / 100,
    maximum: Math.round(timings.at(-1) * 100) / 100,
  },
  exactDuplicateCheckMs: Math.round(duplicateMs * 100) / 100,
  duplicateWarnings: duplicateResult.warnings.length,
};
console.log(JSON.stringify(report, null, 2));

db.close();
if (!suppliedPath) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const generatedPath = `${databasePath}${suffix}`;
    if (existsSync(generatedPath)) rmSync(generatedPath);
  }
}
