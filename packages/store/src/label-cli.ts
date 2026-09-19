import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import type { ModerationCategory } from "../../core/src/index.ts";
import { connectPostgresFromFile } from "./connect.ts";
import type { Database } from "./database.ts";
import { migrate } from "./migrate.ts";
import { PostgresStore } from "./postgres-store.ts";
import { terminalSafe } from "./terminal-text.ts";

/*
 * Interactive labelling for the eval set. This is the one tool that shows
 * member text on purpose, to the operator who owns the groups, in a terminal.
 */

const usage = `Usage: pnpm label --database-url-file <file> [--limit <n>]

Keys: a allowed · s spam · c scam · b abuse · o other · k skip · q quit
Add "!" (e.g. "s!") to record the label without keeping the text in the eval set.`;

const keys: Record<string, ModerationCategory> = { a: "allowed", s: "spam", c: "scam", b: "abuse", o: "other" };

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
        limit: { type: "string" },
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
  const limit = Number(values.limit ?? "50");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) fail("--limit must be 1..500.");
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail("Labelling shows member messages; run it in an interactive terminal.");
  }

  let database: Database | undefined;
  try {
    database = await connectPostgresFromFile(resolve(urlFile));
    await migrate(database);
  } catch (error) {
    // Our own setup errors are safe to show; driver errors can echo values.
    const own = error instanceof Error && !("code" in error);
    process.stderr.write(`${own ? error.message : "Database setup failed"}\n`);
    await database?.close().catch(() => {});
    return 1;
  }
  const store = new PostgresStore(database);
  const prompt = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let labelled = 0;
  try {
    const candidates = await store.labelCandidates(limit);
    if (candidates.length === 0) process.stdout.write("Nothing to label.\n");
    for (const [index, { message, verdict }] of candidates.entries()) {
      const suggestion = verdict === undefined ? "no verdict"
        : `model: ${verdict.category} (${verdict.confidence.toFixed(2)})`;
      process.stdout.write(`\n[${index + 1}/${candidates.length}] ${message.receivedAt.toISOString()} · ${suggestion}\n`);
      process.stdout.write(`${terminalSafe(message.text)}\n`);
      for (;;) {
        const answer = (await prompt.question("label> ")).trim().toLowerCase();
        if (answer === "q") return 0;
        if (answer === "k") break;
        const category = keys[answer.replace(/!$/, "")];
        if (category === undefined) {
          process.stdout.write("a s c b o, k to skip, q to quit (append ! to keep it out of the eval set)\n");
          continue;
        }
        await store.labelMessage(message, category, new Date(), { keepForEval: !answer.endsWith("!") });
        labelled += 1;
        break;
      }
    }
    return 0;
  } finally {
    prompt.close();
    process.stdout.write(`\nLabelled ${labelled} message(s).\n`);
    await database.close();
  }
}

process.exitCode = await main();
