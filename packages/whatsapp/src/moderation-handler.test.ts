import assert from "node:assert/strict";
import test from "node:test";
import type { Classifier, GroupMessage } from "../../core/src/index.ts";
import { migrate, PostgresStore } from "../../store/src/index.ts";
import { createTestDatabase } from "../../store/src/test-database.ts";
import type { GroupMetadata } from "@whiskeysockets/baileys";
import { accountWarmupMilliseconds, AuditedDeletionAdapter, GatedDeletionAdapter } from "./deletion-gate.ts";
import { createModerationHandler, isLive } from "./moderation-handler.ts";
import { RecentMessageCache, type ObservedMessageKey } from "./recent-message-cache.ts";

const groupId = "120363000000000001@g.us";
const message: GroupMessage = {
  id: "M1", groupId, senderId: "61400000001@s.whatsapp.net", text: "Earn 30% weekly", receivedAt: new Date(),
};
const confidentScam: Classifier = { classify: async () => ({ category: "scam", confidence: 0.99, reason: "bait" }) };

test("creates a shadow policy on first sight and records a shadowed verdict", async () => {
  const database = await createTestDatabase();
  try {
    await migrate(database);
    const store = new PostgresStore(database);
    await store.saveMessage(message);

    await createModerationHandler({ store, classifier: confidentScam })(message, new AbortController().signal);

    const policy = await store.currentPolicy(groupId);
    assert.equal(policy?.mode, "shadow");
    assert.deepEqual(policy?.autoActionCategories, ["spam", "scam"]);
    const { rows } = await database.query<{ outcome: string; policy_version: number }>(
      "SELECT outcome, policy_version FROM verdicts");
    assert.deepEqual(rows, [{ outcome: "shadowed", policy_version: 1 }]);
  } finally {
    await database.close();
  }
});

test("a tampered live policy row still only produces shadow verdicts", async () => {
  const database = await createTestDatabase();
  try {
    await migrate(database);
    const store = new PostgresStore(database);
    await store.appendPolicy(groupId, {
      mode: "live", autoActionCategories: ["scam"], minimumAutoActionConfidence: 0.95,
      shadowStartedAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    await store.saveMessage(message);

    await createModerationHandler({ store, classifier: confidentScam })(message, new AbortController().signal);

    const { rows } = await database.query<{ outcome: string }>("SELECT outcome FROM verdicts");
    assert.deepEqual(rows, [{ outcome: "shadowed" }]);
  } finally {
    await database.close();
  }
});

async function withLiveStore(run: (store: PostgresStore, deleted: string[], database: Awaited<ReturnType<typeof createTestDatabase>>) => Promise<void>) {
  const database = await createTestDatabase();
  try {
    await migrate(database);
    const store = new PostgresStore(database);
    await store.appendPolicy(groupId, {
      mode: "live", autoActionCategories: ["scam"], minimumAutoActionConfidence: 0.95,
      shadowStartedAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    await store.saveMessage(message);
    await run(store, [], database);
  } finally {
    await database.close();
  }
}

test("deletes only when the stored policy is live, the group was started live, and a deletion path exists", () =>
  withLiveStore(async (store, deleted, database) => {
    const deletion = { deleteMessage: async (target: GroupMessage) => void deleted.push(target.id) };

    await createModerationHandler({ store, classifier: confidentScam, deletion, liveGroupIds: new Set() })(
      message, new AbortController().signal);
    await createModerationHandler({ store, classifier: confidentScam, liveGroupIds: new Set([groupId]) })(
      message, new AbortController().signal);
    assert.deepEqual(deleted, [], "one key alone is not enough");

    await database.query("DELETE FROM verdicts");
    await createModerationHandler({ store, classifier: confidentScam, deletion, liveGroupIds: new Set([groupId]) })(
      message, new AbortController().signal);
    assert.deepEqual(deleted, ["M1"]);
    const { rows } = await database.query<{ outcome: string }>("SELECT outcome FROM verdicts");
    assert.deepEqual(rows, [{ outcome: "deleted" }]);
  }));

test("the database refuses live policies that are broad or low-confidence", () => withLiveStore(async (store) => {
  const base = { mode: "live" as const, shadowStartedAt: new Date() };
  await assert.rejects(store.appendPolicy(groupId, { ...base, autoActionCategories: ["abuse"], minimumAutoActionConfidence: 0.99 }));
  await assert.rejects(store.appendPolicy(groupId, { ...base, autoActionCategories: ["spam"], minimumAutoActionConfidence: 0.8 }));
  await assert.rejects(store.appendPolicy(groupId, { ...base, autoActionCategories: [], minimumAutoActionConfidence: 0.99 }));
}));

test("end to end: a live deletion is logged, gated, and never repeated on replay", () =>
  withLiveStore(async (store, _deleted, database) => {
    const revoked: ObservedMessageKey[] = [];
    const recentMessages = new RecentMessageCache();
    const now = new Date();
    recentMessages.remember(message, now);
    const liveGroupIds = new Set([groupId]);
    const deletion = new AuditedDeletionAdapter(store, new GatedDeletionAdapter({
      transport: {
        fetchGroupMetadata: async (id) => ({ id, subject: "g", participants: [
          { id: "61499999999@s.whatsapp.net", admin: "admin" }, { id: message.senderId, admin: null },
        ] }) as GroupMetadata,
        revoke: async (key) => void revoked.push(key),
        ownIds: () => ["61499999999:1@s.whatsapp.net"],
      },
      recentMessages,
      policyFor: async (id) => {
        const policy = await store.currentPolicy(id);
        return policy !== undefined && isLive(policy, liveGroupIds)
          ? { groupId: id, mode: "live" as const, shadowStartedAt: policy.shadowStartedAt } : undefined;
      },
      accountWarmupStartedAt: () => new Date(now.getTime() - accountWarmupMilliseconds - 1),
      processStartedAt: new Date(now.getTime() - 120_000),
    }));
    const handle = createModerationHandler({ store, classifier: confidentScam, liveGroupIds, deletion });

    await handle(message, new AbortController().signal);
    await database.query("DELETE FROM verdicts");
    await handle(message, new AbortController().signal);

    assert.equal(revoked.length, 1);
    const { rows: actions } = await database.query<{ kind: string; status: string; refusal: string | null }>(
      "SELECT kind, status, refusal FROM actions ORDER BY id");
    assert.deepEqual(actions, [{ kind: "delete", status: "succeeded", refusal: null }]);
    const { rows: verdicts } = await database.query<{ outcome: string }>("SELECT outcome FROM verdicts");
    assert.deepEqual(verdicts, [{ outcome: "delete-failed" }], "the replay is refused as already attempted");
  }));
