import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { connectPostgres, migrate, PostgresStore, type Database } from "../../store/src/index.ts";
import { EncryptedAuthState, readPrivateFile } from "./encrypted-auth-state.ts";
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
               observed messages are stored and purged after 30 days.`;

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
  let url: string;
  try {
    const contents = await readPrivateFile(await canonicalPath(urlFile), 4096);
    url = contents.toString("utf8").trim();
    contents.fill(0);
  } catch {
    log({ event: "database-setup-failed", detail: "Cannot read --database-url-file; it must be owner-only" });
    return undefined;
  }
  let database: Database;
  try {
    database = connectPostgres(url);
  } catch (error) {
    // These messages come from our own URL checks and never contain the URL.
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

  const pairing = terminalPairing();
  const session = new WhatsAppSession({
    auth,
    allowedGroupIds: groups,
    // Classification arrives with a later slice; for now observe, and store when configured.
    onMessage: async (message) => {
      await storage?.store.saveMessage(message);
    },
    // Session events carry no content, identifiers, or secrets by construction.
    onEvent: ({ type, ...details }: SessionEvent) => log({ event: type, ...details }),
    ...(pairing === undefined ? {} : { pairing }),
  });

  const status = setInterval(() => log({ event: "status", ...session.counters }), statusIntervalMilliseconds);
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
  log({ event: "status", ...session.counters });
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
