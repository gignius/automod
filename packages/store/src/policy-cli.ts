import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ModerationCategory } from "../../core/src/index.ts";
import { connectPostgresFromFile } from "./connect.ts";
import type { Database } from "./database.ts";
import { migrate } from "./migrate.ts";
import { PostgresStore } from "./postgres-store.ts";

/*
 * Views or changes one group's moderation policy. Each change appends a new
 * version; the original shadow start is carried forward and cannot be set, so
 * the 7-day shadow period cannot be skipped from here. Live mode also needs the
 * worker to be started with --live-group for the group.
 */

const usage = `Usage: pnpm policy --database-url-file <file> --group <jid> [--mode shadow|live]
                   [--categories spam,scam] [--threshold 0.95]

With only --group, prints the current policy. Live mode is limited to spam and
scam at a threshold of at least 0.9, and acts only after 7 days of shadow and
when the worker runs with --live-group for this group.`;

const shadowDays = 7;

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
        group: { type: "string" },
        mode: { type: "string" },
        categories: { type: "string" },
        threshold: { type: "string" },
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
  const groupId = values.group;
  if (urlFile === undefined || groupId === undefined) fail("--database-url-file and --group are required.");
  if (!/^[0-9-]{1,40}@g\.us$/.test(groupId)) fail("--group must be a group JID ending in @g.us.");
  const mode = values.mode;
  if (mode !== undefined && mode !== "shadow" && mode !== "live") fail("--mode must be shadow or live.");
  const categories = values.categories?.split(",").map((category) => category.trim());
  if (categories !== undefined && !categories.every((category) => ["spam", "scam", "abuse", "other"].includes(category))) {
    fail("--categories must be from spam, scam, abuse, other.");
  }
  const threshold = values.threshold === undefined ? undefined : Number(values.threshold);
  if (threshold !== undefined && !(threshold >= 0 && threshold <= 1)) fail("--threshold must be within 0..1.");

  let database: Database | undefined;
  try {
    database = await connectPostgresFromFile(resolve(urlFile));
    await migrate(database);
    const store = new PostgresStore(database);
    let policy = await store.currentPolicy(groupId);
    if (mode !== undefined || categories !== undefined || threshold !== undefined) {
      const next = {
        mode: mode ?? policy?.mode ?? "shadow",
        autoActionCategories: (categories ?? policy?.autoActionCategories ?? ["spam", "scam"]) as ModerationCategory[],
        minimumAutoActionConfidence: threshold ?? policy?.minimumAutoActionConfidence ?? 0.95,
        // Carried forward, never set here: the shadow period starts with the group's first policy.
        shadowStartedAt: policy?.shadowStartedAt ?? new Date(),
      };
      if (next.mode === "live" && (next.minimumAutoActionConfidence < 0.9 ||
        next.autoActionCategories.some((category) => category !== "spam" && category !== "scam"))) {
        fail("Live mode is limited to spam and scam at a threshold of at least 0.9.");
      }
      policy = await store.appendPolicy(groupId, next);
    }
    if (policy === undefined) {
      process.stdout.write("No policy yet; the worker creates a shadow policy when it first classifies this group.\n");
      return 0;
    }
    const shadowRemainingDays = Math.max(0,
      Math.ceil(shadowDays - (Date.now() - policy.shadowStartedAt.getTime()) / (24 * 60 * 60_000)));
    process.stdout.write(`${JSON.stringify({
      ...policy,
      shadowRemainingDays,
      note: policy.mode === "live"
        ? "Acts only with --live-group for this group, after the shadow period and account warm-up."
        : "Shadow: verdicts are recorded, nothing is removed.",
    }, null, 2)}\n`);
    return 0;
  } catch (error) {
    const own = error instanceof Error && !("code" in error) && /database URL/.test(error.message);
    process.stderr.write(`${own ? error.message : "Policy update failed"}\n`);
    return 1;
  } finally {
    await database?.close().catch(() => {});
  }
}

process.exitCode = await main();
