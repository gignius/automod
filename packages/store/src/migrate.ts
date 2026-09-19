import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Database } from "./database.ts";

export const defaultMigrationsDirectory = fileURLToPath(new URL("../migrations", import.meta.url));

// Arbitrary constant shared by every automod worker so only one migrates at a time.
const migrationLockId = 7_246_131_001;
const migrationNamePattern = /^\d{3}_[a-z0-9_]{1,64}\.sql$/;

interface Migration {
  name: string;
  script: string;
  checksum: string;
}

async function loadMigrations(directory: string): Promise<Migration[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  if (!names.every((name) => migrationNamePattern.test(name))) {
    throw new Error("Migration files must be named NNN_snake_case.sql");
  }
  return Promise.all(names.map(async (name) => {
    const script = await readFile(join(directory, name), "utf8");
    return { name, script, checksum: createHash("sha256").update(script).digest("hex") };
  }));
}

/**
 * Applies pending migrations in one transaction under an advisory lock. Refuses
 * to start if an applied migration was edited or removed, so the schema cannot
 * silently drift from the code. Returns the names it applied.
 */
export async function migrate(database: Database, directory = defaultMigrationsDirectory): Promise<string[]> {
  const migrations = await loadMigrations(directory);
  return database.transaction(async (transaction) => {
    await transaction.query("SELECT pg_advisory_xact_lock($1)", [migrationLockId]);
    await transaction.execute(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows: applied } = await transaction.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM schema_migrations ORDER BY name");
    const known = new Map(migrations.map((migration) => [migration.name, migration.checksum]));
    for (const row of applied) {
      if (known.get(row.name) !== row.checksum) {
        throw new Error(`Applied migration ${row.name} is missing or was modified`);
      }
    }
    const appliedNames = new Set(applied.map((row) => row.name));
    const pending = migrations.filter((migration) => !appliedNames.has(migration.name));
    const newest = applied.at(-1)?.name;
    if (newest !== undefined && pending.some((migration) => migration.name < newest)) {
      throw new Error("A pending migration sorts before one already applied");
    }
    for (const migration of pending) {
      await transaction.execute(migration.script);
      await transaction.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
        [migration.name, migration.checksum]);
    }
    return pending.map((migration) => migration.name);
  });
}
