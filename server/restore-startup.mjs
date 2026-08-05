import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function applyPendingRestore(databasePath) {
  const configRoot = dirname(resolve(databasePath));
  const markerPath = join(configRoot, ".book-vault-restore.json");
  if (!existsSync(markerPath)) return null;
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  const pendingDatabase = resolve(configRoot, String(marker.pendingDatabase || ""));
  const pendingCovers = resolve(configRoot, String(marker.pendingCovers || ""));
  if (!pendingDatabase.startsWith(configRoot) || !existsSync(pendingDatabase)) {
    throw new Error("A staged Book Vault restore is incomplete; the current database was not changed");
  }
  const backups = join(configRoot, "backups");
  mkdirSync(backups, { recursive: true });
  if (existsSync(databasePath)) {
    renameSync(databasePath, join(backups, `pre-restore-${timestamp()}.sqlite`));
  }
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${databasePath}${suffix}`;
    if (existsSync(sidecar)) {
      renameSync(sidecar, join(backups, `pre-restore-${timestamp()}${suffix}`));
    }
  }
  renameSync(pendingDatabase, databasePath);
  if (pendingCovers.startsWith(configRoot) && existsSync(pendingCovers)) {
    const covers = join(configRoot, "covers");
    mkdirSync(covers, { recursive: true });
    for (const filename of readdirSync(pendingCovers)) {
      if (!/^edition-[1-9]\d*\.(?:jpg|jpeg|png|gif|webp)$/i.test(basename(filename))) continue;
      copyFileSync(join(pendingCovers, filename), join(covers, basename(filename)));
    }
  }
  unlinkSync(markerPath);
  return { restored: true, backupDirectory: backups };
}
