import assert from "node:assert/strict";
import test from "node:test";
import type { GroupMetadata } from "@whiskeysockets/baileys";
import type { GroupMessage } from "../../core/src/types.ts";
import {
  accountWarmupMilliseconds,
  AuditedDeletionAdapter,
  DeletionRefusedError,
  GatedDeletionAdapter,
  groupShadowMilliseconds,
  isSameAccount,
  type ActionLog,
  type DeletionRefusal,
  type GroupActionPolicy,
} from "./deletion-gate.ts";
import { RecentMessageCache, type ObservedMessageKey } from "./recent-message-cache.ts";
import { groupId, now, senderId } from "./test-fixtures.ts";

const ownId = "61400000009:3@s.whatsapp.net";
const ownLid = "123456789012345:3@lid";
const message: GroupMessage = { id: "m1", groupId, senderId, text: "scam", receivedAt: now };
const livePolicy: GroupActionPolicy = {
  groupId,
  mode: "live",
  shadowStartedAt: new Date(now.getTime() - groupShadowMilliseconds),
};

function harness(options: {
  policy?: GroupActionPolicy;
  admin?: "admin" | "superadmin" | null;
  selfParticipant?: { id: string; lid?: string };
  metadataId?: string;
  processStartedAt?: Date;
  accountWarmupStartedAt?: Date | undefined;
  clock?: () => Date;
  remember?: boolean;
} = {}) {
  const revoked: ObservedMessageKey[] = [];
  let metadataFetches = 0;
  const recentMessages = new RecentMessageCache();
  if (options.remember !== false) recentMessages.remember(message, now);
  const adapter = new GatedDeletionAdapter({
    transport: {
      fetchGroupMetadata: async () => {
        metadataFetches += 1;
        return {
          id: options.metadataId ?? groupId,
          subject: "group",
          participants: [
            { id: senderId, admin: null },
            { ...(options.selfParticipant ?? { id: "61400000009@s.whatsapp.net" }), admin: options.admin === undefined ? "admin" : options.admin },
          ],
        } as GroupMetadata;
      },
      revoke: async (key) => void revoked.push(key),
      ownIds: () => [ownId, ownLid],
    },
    recentMessages,
    policyFor: async (id) => {
      const policy = options.policy ?? livePolicy;
      return id === policy.groupId ? policy : undefined;
    },
    accountWarmupStartedAt: () => "accountWarmupStartedAt" in options ? options.accountWarmupStartedAt
      : new Date(now.getTime() - accountWarmupMilliseconds),
    processStartedAt: options.processStartedAt ?? new Date(now.getTime() - 60_000),
    clock: options.clock ?? (() => now),
  });
  return { adapter, revoked, metadataFetches: () => metadataFetches };
}

async function assertRefused(promise: Promise<void>, refusal: DeletionRefusal): Promise<void> {
  await assert.rejects(promise, (error) => error instanceof DeletionRefusedError && error.refusal === refusal);
}

test("revokes an observed message once every gate passes", async () => {
  const context = harness();

  await context.adapter.deleteMessage(message);

  assert.deepEqual(context.revoked, [{ remoteJid: groupId, id: "m1", participant: senderId, fromMe: false }]);
});

test("recognises admin rights through the linked-identity address", async () => {
  const context = harness({ selfParticipant: { id: "999@lid", lid: "123456789012345@lid" }, admin: "superadmin" });

  await context.adapter.deleteMessage(message);

  assert.equal(context.revoked.length, 1);
});

test("refuses unknown groups and shadow policies", async () => {
  await assertRefused(harness({ policy: { ...livePolicy, mode: "shadow" } }).adapter.deleteMessage(message), "not-live");
  await assertRefused(harness().adapter.deleteMessage({ ...message, groupId: "120363000000000002@g.us" }), "not-live");
});

test("enforces startup quarantine, account warm-up, and group shadow periods", async () => {
  await assertRefused(harness({ processStartedAt: new Date(now.getTime() - 59_999) }).adapter.deleteMessage(message),
    "startup-quarantine");
  await assertRefused(harness({ accountWarmupStartedAt: new Date(now.getTime() - accountWarmupMilliseconds + 1) })
    .adapter.deleteMessage(message), "account-warming-up");
  await assertRefused(harness({ policy: { ...livePolicy, shadowStartedAt: new Date(now.getTime() - groupShadowMilliseconds + 1) } })
    .adapter.deleteMessage(message), "group-shadow-period");
});

test("refuses when the clock is invalid or earlier than process start", async () => {
  await assertRefused(harness({ clock: () => new Date(Number.NaN) }).adapter.deleteMessage(message), "invalid-clock");
  await assertRefused(harness({ processStartedAt: new Date(now.getTime() + 1) }).adapter.deleteMessage(message),
    "invalid-clock");
});

test("refuses messages this process did not observe, including forged senders", async () => {
  await assertRefused(harness({ remember: false }).adapter.deleteMessage(message), "unknown-message");
  await assertRefused(harness().adapter.deleteMessage({ ...message, senderId: "61400000002@s.whatsapp.net" }),
    "unknown-message");
});

test("refuses without current admin rights or with mismatched metadata", async () => {
  for (const options of [
    { admin: null },
    { selfParticipant: { id: "61400000008@s.whatsapp.net" } },
    { selfParticipant: { id: "61400000009@lid" } },
    { metadataId: "120363000000000002@g.us" },
  ] as const) {
    const context = harness(options);
    await assertRefused(context.adapter.deleteMessage(message), "not-admin");
    assert.equal(context.revoked.length, 0);
  }
});

test("counts attempts against five per group per minute before contacting WhatsApp", async () => {
  const context = harness({ admin: null });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assertRefused(context.adapter.deleteMessage(message), "not-admin");
  }

  await assertRefused(context.adapter.deleteMessage(message), "rate-limited");
  assert.equal(context.metadataFetches(), 5);
});

test("refuses policies with an invalid shadow start date", async () => {
  await assertRefused(harness({ policy: { ...livePolicy, shadowStartedAt: new Date(Number.NaN) } })
    .adapter.deleteMessage(message), "not-live");
});

test("refuses until the account's first connection is known, and rejects a bad process start", async () => {
  await assertRefused(harness({ accountWarmupStartedAt: undefined }).adapter.deleteMessage(message), "account-warming-up");
  assert.throws(() => new GatedDeletionAdapter({
    transport: { fetchGroupMetadata: async () => { throw new Error(); }, revoke: async () => {}, ownIds: () => [] },
    recentMessages: new RecentMessageCache(),
    policyFor: async () => livePolicy,
    accountWarmupStartedAt: () => now,
    processStartedAt: new Date(Number.NaN),
  }));
});

test("audited deletion logs before acting and never attempts one message twice", async () => {
  const log: string[] = [];
  const begun = new Set<string>();
  const actionLog: ActionLog = {
    beginAction: async (request) => {
      const key = `${request.groupId}/${request.message?.senderId}/${request.message?.id}`;
      if (begun.has(key)) return undefined;
      begun.add(key);
      log.push(`begin ${request.kind} ${request.requestedBy}`);
      return String(begun.size);
    },
    finishAction: async (id, status, refusal) => void log.push(`finish ${id} ${status}${refusal ? ` ${refusal}` : ""}`),
  };
  const context = harness();
  const audited = new AuditedDeletionAdapter(actionLog, context.adapter);

  await audited.deleteMessage(message);
  await assertRefused(audited.deleteMessage(message), "already-attempted");
  await assertRefused(audited.deleteMessage({ ...message, id: "m2" }), "unknown-message");

  assert.equal(context.revoked.length, 1);
  assert.deepEqual(log, [
    "begin delete policy", "finish 1 succeeded",
    "begin delete policy", "finish 2 refused unknown-message",
  ]);
});

test("isSameAccount ignores device suffixes but not namespaces", () => {
  assert.equal(isSameAccount("61400000009:3@s.whatsapp.net", "61400000009@s.whatsapp.net"), true);
  assert.equal(isSameAccount("61400000009@c.us", "61400000009@s.whatsapp.net"), true);
  assert.equal(isSameAccount("61400000009@lid", "61400000009@s.whatsapp.net"), false);
  assert.equal(isSameAccount("junk", "junk"), false);
  assert.equal(isSameAccount(undefined, undefined), false);
});
