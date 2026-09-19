import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { connectPostgresFromFile, InboxProcessor, migrate, PostgresStore, type Database } from "../../store/src/index.ts";
import { BudgetedClassifier } from "../../classifier/src/budgeted-classifier.ts";
import { defaultModel, GeminiClassifier, vertexGenerate } from "../../classifier/src/gemini-classifier.ts";
import { readPrivateFile } from "../../core/src/private-file.ts";
import { EncryptedAuthState } from "./encrypted-auth-state.ts";
import { shadowModeration } from "./shadow-moderation.ts";
import { isGroupId } from "./normalize-message.ts";
import { WhatsAppSession, type PairingHandler, type SessionEvent } from "./whatsapp-session.ts";

/*
 * Phase 0 observer: links one operator-owned number and ingests allowlisted
 * group traffic. It has no deletion path at all, so it can only ever run in
 * shadow. Logs are status and aggregate counts only.
 */

const usage = `Usage: pnpm session --state-dir <dir> --session <id> --key-file <file> --group <jid> [--group <jid>...]
                    [--database-url-file <file>]

  --state-dir  Directory holding encrypted session state (created 0700).
  --session    Session ID: letters, digits, "_" or "-", up to 64 characters.
  --key-file   Owner-only file with exactly 32 random bytes, outside --state-dir.
               Create one with: (umask 077; head -c 32 /dev/urandom > automod.key)
  --group      Allowlisted group JID (digits and "-" followed by @g.us). Repeatable.
  --database-url-file
               Optional owner-only file holding a postgres:// URL. When given,
               observed messages are stored and purged after 30 days.
  --gcp-project
               Optional Google Cloud project with Vertex AI enabled. Requires
               --database-url-file. Classifies stored messages in shadow mode
               and records verdicts; nothing is ever deleted. Uses Application
               Default Credentials (gcloud auth application-default login).
  --gcp-location  Vertex AI endpoint: global (default), us, or eu.
  --model         Default ${defaultModel}.
  --daily-budget  Maximum classification calls per rolling day (default 20000).`;

const statusIntervalMilliseconds = 60_000;
const purgeIntervalMilliseconds = 60 * 60_000;

function log(entry: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

function fail(message: string): never {
  process.stderr.write(`${message}\n\n${usage}\n`);
  process.exit(2);
}

/** SQLSTATE or errno codes identify a failure without echoing values the way messages can. */
function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" &&
    /^([0-9A-Z]{5}|E[A-Z]{2,20})$/.test(error.code) ? error.code : undefined;
}

async function openStore(urlFile: string): Promise<{ database: Database; store: PostgresStore } | undefined> {
  let database: Database;
  try {
    database = await connectPostgresFromFile(await canonicalPath(urlFile));
  } catch (error) {
    // These messages come from our own checks and never contain the URL.
    log({ event: "database-setup-failed", detail: error instanceof Error ? error.message : "unknown" });
    return undefined;
  }
  try {
    const applied = await migrate(database);
    log({ event: "database-ready", migrationsApplied: applied.length });
    return { database, store: new PostgresStore(database) };
  } catch (error) {
    log({ event: "database-setup-failed", code: errorCode(error) });
    await database.close().catch(() => {});
    return undefined;
  }
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

/** Canonical path, resolving symlinks through the nearest existing ancestor. */
async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(await canonicalPath(parent), basename(absolute));
  }
}

function terminalPairing(): PairingHandler | undefined {
  // A pairing code is an account-linking secret; only ever show it to a person at a terminal.
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  return {
    async phoneNumber() {
      const prompt = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      try {
        const answer = await prompt.question("Dedicated WhatsApp number to link (digits, with country code): ");
        return answer.replace(/[\s()+-]/g, "");
      } finally {
        prompt.close();
      }
    },
    showCode(code) {
      process.stdout.write(`\nOn the phone: WhatsApp > Linked devices > Link a device > Link with phone number instead\nPairing code: ${code}\n\n`);
    },
  };
}

async function main(): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        "state-dir": { type: "string" },
        session: { type: "string" },
        "key-file": { type: "string" },
        group: { type: "string", multiple: true },
        "database-url-file": { type: "string" },
        "gcp-project": { type: "string" },
        "gcp-location": { type: "string" },
        model: { type: "string" },
        "daily-budget": { type: "string" },
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
  const stateDirectory = values["state-dir"];
  const sessionId = values.session;
  const keyFile = values["key-file"];
  const groups = values.group ?? [];
  if (stateDirectory === undefined || sessionId === undefined || keyFile === undefined || groups.length === 0) {
    fail("--state-dir, --session, --key-file and at least one --group are required.");
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) fail("Invalid --session.");
  if (!groups.every(isGroupId)) fail("Every --group must be a group JID ending in @g.us.");

  const keyPath = await canonicalPath(keyFile);
  if (isInside(await canonicalPath(stateDirectory), keyPath)) {
    fail("--key-file must not live inside --state-dir; the key must never be backed up with the ciphertext.");
  }

  const gcpProject = values["gcp-project"];
  if (gcpProject === undefined && (values["gcp-location"] ?? values.model ?? values["daily-budget"]) !== undefined) {
    fail("--gcp-location, --model and --daily-budget need --gcp-project.");
  }
  let classifier: GeminiClassifier | undefined;
  let budgeted: BudgetedClassifier | undefined;
  if (gcpProject !== undefined) {
    if (values["database-url-file"] === undefined) fail("--gcp-project needs --database-url-file to store verdicts.");
    const dailyBudget = Number(values["daily-budget"] ?? "20000");
    if (!Number.isSafeInteger(dailyBudget) || dailyBudget < 1) fail("--daily-budget must be a positive integer.");
    const model = values.model ?? defaultModel;
    if (!/^[a-z0-9][a-z0-9.-]{1,63}$/.test(model)) fail("Invalid --model.");
    try {
      classifier = new GeminiClassifier(vertexGenerate({
        project: gcpProject, location: values["gcp-location"] ?? "global", model,
      }));
    } catch (error) {
      fail(error instanceof Error ? error.message : "Invalid Vertex AI settings.");
    }
    budgeted = new BudgetedClassifier(classifier, dailyBudget);
  }

  const databaseUrlFile = values["database-url-file"];
  const storage = databaseUrlFile === undefined ? undefined : await openStore(databaseUrlFile);
  if (databaseUrlFile !== undefined && storage === undefined) return 1;

  let key: Buffer;
  try {
    // Read one byte past the limit so an oversized key is reported as such.
    key = await readPrivateFile(keyPath, 33);
  } catch {
    fail("Cannot read --key-file; it must be a regular file owned by you with mode 0600 or stricter.");
  }
  if (key.length !== 32) {
    key.fill(0);
    fail("--key-file must contain exactly 32 bytes.");
  }

  let auth: EncryptedAuthState;
  try {
    auth = await EncryptedAuthState.open(stateDirectory, sessionId, key);
  } catch (error) {
    log({ event: "auth-open-failed", detail: error instanceof Error ? error.message : "unknown" });
    await storage?.database.close().catch(() => {});
    return 1;
  } finally {
    key.fill(0);
  }

  // Without a classifier the inbox only marks stored messages observed, so
  // restarts still resume where they left off.
  const handle = storage === undefined || budgeted === undefined ? async () => {}
    : shadowModeration(storage.store, budgeted);
  const inbox = storage === undefined ? undefined : new InboxProcessor({ inbox: storage.store, handle });
  const inboxRunning = inbox?.start();

  const pairing = terminalPairing();
  const session = new WhatsAppSession({
    auth,
    allowedGroupIds: groups,
    // Store first; the inbox handles it from Postgres, so a crash cannot lose it.
    onMessage: async (message) => {
      if (await storage?.store.saveMessage(message)) inbox?.wake();
    },
    // Session events carry no content, identifiers, or secrets by construction.
    onEvent: ({ type, ...details }: SessionEvent) => log({ event: type, ...details }),
    ...(pairing === undefined ? {} : { pairing }),
  });

  const logStatus = () => log({ event: "status", ...session.counters,
    ...(inbox === undefined ? {} : { inbox: inbox.counters }),
    ...(classifier === undefined ? {} : { classifier: { ...classifier.usage, overBudget: budgeted!.refused } }) });
  const status = setInterval(logStatus, statusIntervalMilliseconds);
  status.unref();
  const purge = async () => {
    try {
      log({ event: "purged", ...await storage!.store.purgeExpired() });
    } catch (error) {
      log({ event: "purge-failed", code: errorCode(error) });
    }
  };
  let purging: Promise<void> | undefined;
  const purgeTimer = storage === undefined ? undefined : setInterval(() => {
    purging ??= purge().finally(() => { purging = undefined; });
  }, purgeIntervalMilliseconds);
  purgeTimer?.unref();
  if (storage !== undefined) purging = purge().finally(() => { purging = undefined; });
  const requestStop = () => void session.stop();
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);

  log({ event: "starting", groups: groups.length, mode: "shadow" });
  const reason = await session.start();
  clearInterval(status);
  clearInterval(purgeTimer);
  await inbox?.stop();
  await inboxRunning;
  logStatus();
  await purging;
  await storage?.database.close().catch(() => log({ event: "database-close-failed" }));
  try {
    await auth.close();
  } catch {
    log({ event: "auth-close-failed" });
    return 1;
  }
  if (reason === "pairing-unavailable") {
    log({ event: "hint", detail: "This session is not linked yet; run it from an interactive terminal to pair." });
  }
  return reason === "requested" ? 0 : 1;
}

process.exitCode = await main();
