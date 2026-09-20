import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { connectPostgresFromFile, InboxProcessor, migrate, PostgresStore, type Database } from "../../store/src/index.ts";
import { BudgetedClassifier } from "../../classifier/src/budgeted-classifier.ts";
import { defaultModel, GeminiClassifier, vertexGenerate } from "../../classifier/src/gemini-classifier.ts";
import { readPrivateFile } from "../../core/src/private-file.ts";
import { EncryptedAuthState } from "./encrypted-auth-state.ts";
import qrcodeTerminal from "qrcode-terminal";
import { terminalSafe } from "../../store/src/terminal-text.ts";
import { normalizePairingNumber } from "./pairing-number.ts";
import { resolveWaWebVersion } from "./wa-version.ts";
import type { AdminRevocation, DirectMessage } from "./normalize-message.ts";
import { OperatorChannel } from "./operator-channel.ts";
import { AuditedDeletionAdapter, GatedDeletionAdapter } from "./deletion-gate.ts";
import { AdminVerifier } from "./admin-verification.ts";
import { WarmupClock } from "./warmup-clock.ts";
import { CommunityWatcher } from "./community-watcher.ts";
import { GroupActionGate } from "./group-actions.ts";
import { GroupAllowlist } from "./group-allowlist.ts";
import { createModerationHandler, isLive } from "./moderation-handler.ts";
import { RecentMessageCache, type ObservedMessageKey } from "./recent-message-cache.ts";
import { isGroupId } from "./normalize-message.ts";
import { WhatsAppSession, type GroupSummary, type PairingHandler, type SessionEvent } from "./whatsapp-session.ts";

/*
 * Phase 0 worker: links one operator-owned number, ingests allowlisted group
 * traffic, and (when configured) classifies it. Shadow by default. Automatic
 * deletion needs --live-group and a live stored policy and every gate in
 * deletion-gate.ts; operator actions need --operator-actions. Logs are status
 * and aggregate counts only.
 */

const usage = `Usage: pnpm session --state-dir <dir> --session <id> --key-file <file> --group <jid> [--group <jid>...]
                    [--database-url-file <file>]

  --state-dir  Directory holding encrypted session state (created 0700).
  --session    Session ID: letters, digits, "_" or "-", up to 64 characters.
  --key-file   Owner-only file with exactly 32 random bytes, outside --state-dir.
               Create one with: (umask 077; head -c 32 /dev/urandom > automod.key)
  --group      Allowlisted group JID (digits and "-" followed by @g.us). Repeatable.
  --community  Community parent group ID (see --list-groups). Member groups of
               this WhatsApp Community are watched automatically, in shadow,
               once the number has been admitted; checked every 5 minutes.
  --list-groups
               Connect, print the groups this number is in (ID, name, members,
               whether it is an admin), and exit. Use an ID from here for --group.
  --pair-with-qr
               When linking, show a QR code to scan instead of asking for the
               number and printing an 8-character code.
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
  --daily-budget  Maximum classification calls per rolling day (default 20000).
  --operator   Optional: your personal number (digits, country code). Needs
               --gcp-project. The bot DMs you digests of flagged verdicts and
               you label them by replying "CODE label". It sends to no one else.
  --timezone   IANA zone for quiet hours 23:00-07:00 (default Australia/Sydney).
               Also: "rules 1234" then your rules on the next lines sets that
               group's natural-language rules; "rules 1234" alone shows them.
  --operator-actions
               Also let the operator remove a flagged sender ("CODE remove"),
               lock/unlock a group, and approve join requests ("lock 1234").
               Needs --operator. Rate-limited, logged, admin-checked.
  --live-group Group JID to allow automatic deletion in. Repeatable; each must
               also be a --group and needs --gcp-project. Deletion happens only
               if the group's policy (pnpm policy) is also live, after 7 days
               of shadow and 5 days of account warm-up.`;

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

function terminalPairing(method: "code" | "qr"): PairingHandler | undefined {
  // Pairing codes and QR data are account-linking secrets; only ever show them to a person at a terminal.
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  return {
    method,
    showQr(qr) {
      qrcodeTerminal.generate(qr, { small: true }, (rendered) => {
        process.stdout.write(`\nOn the phone, open WhatsApp Business (not WhatsApp): Settings > Linked devices >
Link a device, then scan this code. It refreshes about every 20 seconds.\n${rendered}\n`);
      });
    },
    async phoneNumber() {
      const prompt = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      try {
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const answer = await prompt.question(
            "Number registered in WhatsApp Business on the eSIM, with country code (e.g. 61412345678): ");
          const parsed = normalizePairingNumber(answer);
          if ("error" in parsed) {
            process.stdout.write(`${parsed.error}\n`);
            continue;
          }
          const confirm = await prompt.question(
            `Link ${parsed.display}? It must be exactly the number shown in WhatsApp Business > Settings. [y/N] `);
          if (/^y(es)?$/i.test(confirm.trim())) return parsed.digits;
        }
        return "";
      } finally {
        prompt.close();
      }
    },
    showCode(code) {
      process.stdout.write(`\nOn the phone, open WhatsApp Business (not WhatsApp): Settings > Linked devices >
Link a device > Link with phone number instead. You may also get a notification to tap.
Pairing code: ${code}\n\n`);
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
        "pair-with-qr": { type: "boolean" },
        "list-groups": { type: "boolean" },
        community: { type: "string" },
        "gcp-project": { type: "string" },
        "gcp-location": { type: "string" },
        model: { type: "string" },
        "daily-budget": { type: "string" },
        operator: { type: "string", multiple: true },
        timezone: { type: "string" },
        "operator-actions": { type: "boolean" },
        "live-group": { type: "string", multiple: true },
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

  const operatorPhones = (values.operator ?? []).map((value) => value.replace(/[\s()+-]/g, ""));
  if (operatorPhones.length > 0 && gcpProject === undefined) fail("--operator needs --gcp-project.");
  if (operatorPhones.length === 0 && values.timezone !== undefined) fail("--timezone needs --operator.");
  if (!operatorPhones.every((phone) => /^[1-9]\d{7,14}$/.test(phone))) fail("Invalid --operator number.");
  if (new Set(operatorPhones).size !== operatorPhones.length) fail("Repeated --operator number.");
  if (values["operator-actions"] && operatorPhones.length === 0) fail("--operator-actions needs --operator.");
  const communityId = values.community;
  if (communityId !== undefined && !isGroupId(communityId)) fail("--community must be a group JID ending in @g.us.");
  const allowlist = new GroupAllowlist(groups);
  const liveGroupIds = new Set(values["live-group"] ?? []);
  if (liveGroupIds.size > 0 && gcpProject === undefined) fail("--live-group needs --gcp-project.");
  if (![...liveGroupIds].every((groupId) => groups.includes(groupId))) fail("Every --live-group must also be a --group.");
  const timeZone = values.timezone ?? "Australia/Sydney";
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone });
  } catch {
    fail("Unknown --timezone.");
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

  const processStartedAt = new Date();
  const recentMessages = new RecentMessageCache();
  let session!: WhatsAppSession;
  const transport = {
    fetchGroupMetadata: (groupId: string) => session.fetchGroupMetadata(groupId),
    revoke: (key: ObservedMessageKey) => session.revoke(key),
    ownIds: () => session.ownIds(),
    removeParticipant: (groupId: string, jid: string) => session.removeParticipant(groupId, jid),
    setAnnouncementOnly: (groupId: string, on: boolean) => session.setAnnouncementOnly(groupId, on),
    pendingJoinRequests: (groupId: string) => session.pendingJoinRequests(groupId),
    approveJoinRequests: (groupId: string, jids: readonly string[]) => session.approveJoinRequests(groupId, jids),
  };
  const adminVerifier = new AdminVerifier({ fetchGroupMetadata: transport.fetchGroupMetadata });
  const warmupClock = storage === undefined ? undefined : new WarmupClock({
    lookup: (accountId: string) => storage.store.accountFirstConnectedAt(accountId, sessionId),
    onRecorded: (startedAt: Date) => log({ event: "warm-up", startedAt: startedAt.toISOString() }),
    onFailure: (error: unknown, attempt: number) =>
      log({ event: "warm-up-record-failed", code: errorCode(error), attempt }),
  });
  const recordWarmupStart = (): void => {
    // Undefined until linked; the next "open" calls back.
    const accountId = session.accountId();
    if (accountId !== undefined) warmupClock?.record(accountId);
  };
  const deletion = storage === undefined || liveGroupIds.size === 0 ? undefined
    : new AuditedDeletionAdapter(storage.store, new GatedDeletionAdapter({
      transport,
      recentMessages,
      policyFor: async (groupId) => {
        const policy = await storage.store.currentPolicy(groupId);
        return policy !== undefined && isLive(policy, liveGroupIds)
          ? { groupId, mode: "live", shadowStartedAt: policy.shadowStartedAt } : undefined;
      },
      accountWarmupStartedAt: () => warmupClock?.startedAt(),
      processStartedAt,
    }));

  // Without a classifier the inbox only marks stored messages observed, so
  // restarts still resume where they left off.
  const handle = storage === undefined || budgeted === undefined ? async () => {}
    : createModerationHandler({ store: storage.store, classifier: budgeted, liveGroupIds,
      ...(deletion === undefined ? {} : { deletion }) });
  const inbox = storage === undefined ? undefined : new InboxProcessor({ inbox: storage.store, handle });
  const inboxRunning = inbox?.start();

  const waVersion = await resolveWaWebVersion();
  log({ event: "wa-version", version: waVersion.version.join("."), source: waVersion.source });

  let channel: OperatorChannel | undefined;
  const pairing = terminalPairing(values["pair-with-qr"] ? "qr" : "code");
  session = new WhatsAppSession({
    auth,
    allowedGroupIds: allowlist,
    recentMessages,
    version: waVersion.version,
    // Store first; the inbox handles it from Postgres, so a crash cannot lose it.
    onMessage: async (message) => {
      if (await storage?.store.saveMessage(message)) inbox?.wake();
    },
    // Session events carry no content, identifiers, or secrets by construction.
    onEvent: ({ type, ...details }: SessionEvent) => {
      log({ event: type, ...details });
      if (type === "open") setTimeout(refreshCommunity, 5_000).unref();
      if (type === "open") recordWarmupStart();
    },
    ...(pairing === undefined ? {} : { pairing }),
    ...(operatorPhones.length === 0 ? {} : {
      onDirectMessage: (message: DirectMessage) => void channel?.handleDirectMessage(message),
    }),
    ...(storage === undefined ? {} : {
      // Admin deletions are recorded so the operator can label them from the
      // digest — which also puts the deleted message's author one word away
      // from removal. Whoever deleted it must actually be an admin, or an
      // ordinary member's revoke would choose who the operator is shown.
      onAdminDeletion: (deletion: AdminRevocation) => {
        void adminVerifier.isAdmin(deletion.groupId, deletion.deletedByAddresses).then(async (byAdmin) => {
          if (!byAdmin) {
            log({ event: "revocation-ignored", reason: "deleter-not-admin" });
            return;
          }
          await storage.store.recordAdminDeletion(deletion);
        }).catch((error: unknown) => log({ event: "admin-deletion-record-failed", code: errorCode(error) }));
      },
    }),
  });
  // Two keys, like live deletion: a number acts only when it is BOTH on record
  // in the database and passed here at startup. A row alone cannot mint an
  // operator, and a flag alone matches nobody.
  const onRecord = operatorPhones.length === 0 || storage === undefined ? [] : await storage.store.listOperators();
  const operators = onRecord.filter((operator) => operatorPhones.includes(operator.phone));
  if (operatorPhones.length > operators.length) {
    // Counted, never printed: logs carry no identifiers.
    log({ event: "operator-not-on-record", count: operatorPhones.length - operators.length });
  }
  if (operatorPhones.length > 0 && storage !== undefined && operators.length === 0) {
    log({ event: "no-operators-active", detail: "put them on record with pnpm operators --add" });
  }
  if (operators.length > 0 && storage !== undefined) {
    // Phone and zone were validated before anything was opened.
    channel = new OperatorChannel({
      operators,
      store: storage.store,
      transport: session,
      ownIds: () => session.ownIds(),
      timeZone,
      rules: {
        getRules: (groupId: string) => storage.store.getRules(groupId),
        setRules: (groupId: string, rules: string | undefined) => storage.store.setRules(groupId, rules),
        allowedGroupIds: () => allowlist.list(),
      },
      ...(values["operator-actions"] ? {
        actions: {
          gate: new GroupActionGate({
            transport,
            log: storage.store,
            allowedGroupIds: allowlist,
            operatorJids: operators.map((operator) => `${operator.phone}@s.whatsapp.net`),
            accountWarmupStartedAt: () => warmupClock?.startedAt(),
            groupShadowStartedAt: async (groupId: string) =>
              (await storage.store.currentPolicy(groupId))?.shadowStartedAt,
            onError: (error: unknown, context: string, kind: string) =>
              log({ event: "gate-error", context, kind, code: errorCode(error) }),
            processStartedAt,
          }),
          allowedGroupIds: () => allowlist.list(),
        },
      } : {}),
    });
  }
  const watcher = communityId === undefined ? undefined : new CommunityWatcher({
    communityId,
    allowlist,
    listGroups: () => session.listGroups(),
    onWatched: (group) => {
      log({ event: "group-watched", group: group.id.split("@")[0]!.slice(-4), members: group.members });
      newlyWatched.push(group);
    },
  });
  // One DM per refresh, only for groups never watched before (restarts re-discover the rest),
  // so the bot never sends in bursts or repeats itself.
  const newlyWatched: GroupSummary[] = [];
  const refreshCommunity = () => void watcher?.refresh().then(async () => {
    const found = newlyWatched.splice(0);
    if (found.length === 0 || storage === undefined) return;
    const firstTime = new Set(await storage.store.markWatched(found.map((group) => group.id)));
    const lines = found.filter((group) => firstTime.has(group.id))
      .map((group) => `• ${group.subject} (…${group.id.split("@")[0]!.slice(-4)}, ${group.members} members)`);
    if (lines.length > 0) {
      await channel?.notify(`Now watching ${lines.length} more group(s) in shadow mode:\n${lines.join("\n")}`);
    }
  }).catch(() => log({ event: "community-refresh-failed" }));
  const communityTimer = watcher === undefined ? undefined : setInterval(refreshCommunity, 5 * 60_000);
  communityTimer?.unref();
  const digestTimer = channel === undefined ? undefined : setInterval(() => void channel!.sendDigest(), 60_000);
  digestTimer?.unref();

  const logStatus = () => log({ event: "status", ...session.counters,
    ...(inbox === undefined ? {} : { inbox: inbox.counters }),
    ...(classifier === undefined ? {} : { classifier: { ...classifier.usage, overBudget: budgeted!.refused } }),
    ...(channel === undefined ? {} : { operator: channel.counters }) });
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

  if (values["list-groups"]) {
    // Connect, list, disconnect. Nothing is ingested or sent.
    const stopped = session.start();
    let listed: Awaited<ReturnType<WhatsAppSession["listGroups"]>> | undefined;
    for (let attempt = 0; attempt < 60 && listed === undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      listed = await session.listGroups().catch(() => undefined);
    }
    await session.stop();
    await stopped;
    await inbox?.stop();
    clearInterval(digestTimer);
  clearInterval(communityTimer);
    await storage?.database.close().catch(() => {});
    await auth.close().catch(() => {});
    if (listed === undefined) {
      log({ event: "list-groups-failed" });
      return 1;
    }
    process.stdout.write(`${terminalSafe(JSON.stringify(listed, null, 2))}\n`);
    return 0;
  }

  log({ event: "starting", groups: allowlist.size, community: communityId !== undefined, liveGroups: liveGroupIds.size,
    operatorActions: values["operator-actions"] === true });
  const reason = await session.start();
  clearInterval(status);
  clearInterval(purgeTimer);
  clearInterval(digestTimer);
  clearInterval(communityTimer);
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
  if (reason === "logged-out" || reason === "pairing-expired") {
    log({ event: "hint", detail: "To pair again, move the state/<session> folder aside (see docs/runbooks/ban-recovery.md)." });
  }
  if (reason === "pairing-unavailable") {
    log({ event: "hint", detail: "This session is not linked yet; run it from an interactive terminal to pair." });
  }
  return reason === "requested" ? 0 : 1;
}

process.exitCode = await main();
