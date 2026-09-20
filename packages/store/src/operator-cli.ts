import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { connectPostgresFromFile } from "./connect.ts";
import type { Database } from "./database.ts";
import { migrate } from "./migrate.ts";
import { PostgresStore } from "./postgres-store.ts";
import { terminalSafe } from "./terminal-text.ts";

/*
 * Views or changes who is on record as an operator.
 *
 * This is one of two keys. A row here is a record, not a grant: the worker only
 * treats someone as an operator when their number is ALSO passed as --operator
 * at startup. So adding a row cannot hand anyone the power to remove members,
 * and removing a row takes it away without waiting for a redeploy. Design:
 * docs/operator-channel-design.md.
 */

const usage = `Usage: pnpm operators --database-url-file <file> [--add <digits> --label <name>]
                      [--remove <digits>]

With no change flags, lists the operators on record.

  --add     Phone number, digits with country code and no +, e.g. 61412345678.
  --label   Short name for --add: lowercase letters, digits or "-", up to 32.
            The action log records this label rather than the number, so
            attribution never copies a phone number into another table.
  --remove  Phone number to take off the record.

A number on record still does nothing until the worker is started with
--operator <digits> for it, and a number passed to --operator that is not on
record is ignored. Both keys are required.`;

function fail(message: string): never {
  process.stderr.write(`${message}\n\n${usage}\n`);
  process.exit(2);
}

async function main(): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        "database-url-file": { type: "string" },
        add: { type: "string" },
        label: { type: "string" },
        remove: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    fail("Unrecognised arguments.");
  }
  if (values.help) {
    process.stdout.write(`${usage}\n`);
    return 0;
  }
  const urlFile = values["database-url-file"];
  if (urlFile === undefined) fail("--database-url-file is required.");
  const add = values.add?.replace(/[\s()+-]/g, "");
  const remove = values.remove?.replace(/[\s()+-]/g, "");
  if (add !== undefined && !/^[1-9]\d{7,14}$/.test(add)) fail("--add must be digits with a country code, e.g. 61412345678.");
  if (remove !== undefined && !/^[1-9]\d{7,14}$/.test(remove)) fail("--remove must be digits with a country code.");
  if (add !== undefined && values.label === undefined) fail("--add needs --label.");
  if (values.label !== undefined && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(values.label)) {
    fail("--label must be lowercase letters, digits or \"-\", up to 32 characters.");
  }
  if (add === undefined && remove === undefined && values.label !== undefined) fail("--label needs --add.");

  let database: Database | undefined;
  try {
    database = await connectPostgresFromFile(resolve(urlFile));
    await migrate(database);
    const store = new PostgresStore(database);
    if (add !== undefined) {
      await store.addOperator(add, values.label!);
      process.stdout.write(`Recorded ${add} as "${values.label!}".\n`);
    }
    if (remove !== undefined) {
      const removed = await store.removeOperator(remove);
      process.stdout.write(removed ? `Removed ${remove}.\n` : `${remove} was not on record.\n`);
    }
    const operators = await store.listOperators();
    if (operators.length === 0) {
      process.stdout.write("No operators on record. The worker will refuse to start with --operator.\n");
      return 0;
    }
    process.stdout.write("On record (each still needs --operator at startup):\n");
    for (const operator of operators) {
      process.stdout.write(`  ${operator.phone}  ${terminalSafe(operator.label)}\n`);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Failed"}\n`);
    return 1;
  } finally {
    await database?.close().catch(() => {});
  }
}

process.exitCode = await main();
