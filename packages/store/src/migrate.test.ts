import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultMigrationsDirectory, migrate } from "./migrate.ts";
import { createTestDatabase } from "./test-database.ts";

async function withMigrations(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "automod-migrations-"));
  try {
    await copyFile(join(defaultMigrationsDirectory, "001_initial.sql"), join(directory, "001_initial.sql"));
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("applies migrations once and records them", async () => {
  const database = await createTestDatabase();
  try {
    assert.deepEqual(await migrate(database), ["001_initial.sql", "002_inbox.sql"]);
    assert.deepEqual(await migrate(database), []);
    const { rows } = await database.query<{ name: string }>("SELECT name FROM schema_migrations ORDER BY name");
    assert.deepEqual(rows, [{ name: "001_initial.sql" }, { name: "002_inbox.sql" }]);
  } finally {
    await database.close();
  }
});

test("applies new migrations in order", () => withMigrations(async (directory) => {
  const database = await createTestDatabase();
  try {
    await migrate(database, directory);
    await writeFile(join(directory, "002_add_note.sql"), "ALTER TABLE eval_examples ADD COLUMN note text;");

    assert.deepEqual(await migrate(database, directory), ["002_add_note.sql"]);
  } finally {
    await database.close();
  }
}));

test("refuses edited or missing applied migrations", () => withMigrations(async (directory) => {
  const database = await createTestDatabase();
  try {
    await migrate(database, directory);
    await writeFile(join(directory, "001_initial.sql"), "-- rewritten history\n");
    await assert.rejects(migrate(database, directory), /modified/);

    await rm(join(directory, "001_initial.sql"));
    await assert.rejects(migrate(database, directory), /missing/);
  } finally {
    await database.close();
  }
}));

test("rolls back a failing migration entirely", () => withMigrations(async (directory) => {
  const database = await createTestDatabase();
  try {
    await writeFile(join(directory, "002_broken.sql"), "CREATE TABLE half_done (id int); SELECT * FROM nope;");
    await assert.rejects(migrate(database, directory));

    const { rows } = await database.query<{ exists: boolean }>(
      "SELECT to_regclass('messages') IS NOT NULL AS exists");
    assert.deepEqual(rows, [{ exists: false }]);
  } finally {
    await database.close();
  }
}));

test("refuses badly named migration files", () => withMigrations(async (directory) => {
  const database = await createTestDatabase();
  try {
    await writeFile(join(directory, "2_Oops.sql"), "SELECT 1;");
    await assert.rejects(migrate(database, directory), /NNN_snake_case/);
  } finally {
    await database.close();
  }
}));
