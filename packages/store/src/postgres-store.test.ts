import assert from "node:assert/strict";
import test from "node:test";
import type { GroupMessage, Verdict } from "../../core/src/index.ts";
import { migrate } from "./migrate.ts";
import { PostgresStore } from "./postgres-store.ts";
import { createTestDatabase } from "./test-database.ts";

const groupId = "120363000000000001@g.us";
const senderId = "61400000001@s.whatsapp.net";
const otherSenderId = "61400000002@s.whatsapp.net";
const dayMilliseconds = 24 * 60 * 60_000;

function message(id: string, overrides: Partial<GroupMessage> = {}): GroupMessage {
  return { id, groupId, senderId, text: `text of ${id}`, receivedAt: new Date(), ...overrides };
}

function verdictFor(stored: GroupMessage, overrides: Partial<Verdict> = {}): Verdict {
  return {
    messageId: stored.id,
    groupId: stored.groupId,
    senderId: stored.senderId,
    policyVersion: 1,
    category: "scam",
    confidence: 0.98,
    reason: `quotes "${stored.text}"`,
    outcome: "shadowed",
    decidedAt: new Date(),
    ...overrides,
  };
}

async function withStore(run: (store: PostgresStore, database: Awaited<ReturnType<typeof createTestDatabase>>) =>
  Promise<void>): Promise<void> {
  const database = await createTestDatabase();
  try {
    await migrate(database);
    await run(new PostgresStore(database), database);
  } finally {
    await database.close();
  }
}

async function count(database: Awaited<ReturnType<typeof createTestDatabase>>, table: string): Promise<number> {
  const { rows } = await database.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}`);
  return rows[0]!.count;
}

test("stores a message once and never overwrites it on redelivery", () => withStore(async (store, database) => {
  assert.equal(await store.saveMessage(message("A1")), true);
  assert.equal(await store.saveMessage(message("A1", { text: "tampered" })), false);
  assert.equal(await store.saveMessage(message("A1", { senderId: otherSenderId })), true);

  const { rows } = await database.query<{ text: string }>(
    "SELECT text FROM messages WHERE sender_jid = $1", [senderId]);
  assert.deepEqual(rows, [{ text: "text of A1" }]);
}));

test("the schema rejects malformed identifiers and oversized text", () => withStore(async (store) => {
  await assert.rejects(store.saveMessage(message("A1", { groupId: "not-a-group" })));
  await assert.rejects(store.saveMessage(message("A1", { senderId: "robert'); DROP TABLE messages;--" })));
  await assert.rejects(store.saveMessage(message("A1", { text: "x".repeat(16_385) })));
  await assert.rejects(store.saveMessage(message("A1", { receivedAt: new Date(Number.NaN) })), RangeError);
}));

test("records one verdict per stored message", () => withStore(async (store, database) => {
  const stored = message("B1");
  await store.saveMessage(stored);

  await store.save(verdictFor(stored));
  await assert.rejects(store.save(verdictFor(stored)));
  await assert.rejects(store.save(verdictFor(message("unknown"))), /not stored/);
  await assert.rejects(store.save(verdictFor(stored, { senderId: otherSenderId })), /not stored/);
  assert.equal(await count(database, "verdicts"), 1);
}));

test("appends dense policy versions and never edits old ones", () => withStore(async (store) => {
  const shadowStartedAt = new Date("2026-09-01T00:00:00.000Z");
  const first = await store.appendPolicy(groupId, {
    mode: "shadow", autoActionCategories: ["spam"], minimumAutoActionConfidence: 0.95, shadowStartedAt,
  });
  const [second, third] = await Promise.all([
    store.appendPolicy(groupId, { ...first, autoActionCategories: ["spam", "scam"] }),
    store.appendPolicy(groupId, { ...first, minimumAutoActionConfidence: 0.99 }),
  ]);

  assert.equal(first.version, 1);
  assert.deepEqual([second.version, third.version].sort(), [2, 3]);
  assert.deepEqual(first, {
    groupId, version: 1, mode: "shadow", autoActionCategories: ["spam"], minimumAutoActionConfidence: 0.95,
    shadowStartedAt,
  });
  assert.equal((await store.currentPolicy(groupId))?.version, 3);
  assert.equal(await store.currentPolicy("120363000000000009@g.us"), undefined);
}));

test("the schema rejects invalid policies", () => withStore(async (store) => {
  const valid = { mode: "shadow" as const, autoActionCategories: ["spam" as const], minimumAutoActionConfidence: 0.9,
    shadowStartedAt: new Date() };
  await assert.rejects(store.appendPolicy(groupId, { ...valid, minimumAutoActionConfidence: 1.5 }));
  await assert.rejects(store.appendPolicy(groupId, { ...valid, autoActionCategories: ["allowed"] }));
  await assert.rejects(store.appendPolicy("x@s.whatsapp.net", valid));
}));

test("labels copy text without the sender into the eval set only when asked", () =>
  withStore(async (store, database) => {
    const kept = message("C1");
    const notKept = message("C2");
    await store.saveMessage(kept);
    await store.saveMessage(notKept);

    await store.labelMessage(kept, "spam", new Date(), { keepForEval: true });
    await store.labelMessage(kept, "scam", new Date(), { keepForEval: true });
    await store.labelMessage(notKept, "allowed", new Date(), { keepForEval: false });

    const { rows } = await database.query<Record<string, unknown>>(
      "SELECT group_jid, text, expected_category FROM eval_examples");
    assert.deepEqual(rows, [{ group_jid: groupId, text: "text of C1", expected_category: "scam" }]);
    assert.equal(await count(database, "feedback_labels"), 2);

    await store.labelMessage(kept, "scam", new Date(), { keepForEval: false });
    assert.equal(await count(database, "eval_examples"), 0);
    await assert.rejects(store.labelMessage(message("missing"), "spam", new Date(), { keepForEval: true }),
      /not stored/);
  }));

test("purges only expired messages, scrubbing verdict reasons but keeping eval examples", () =>
  withStore(async (store, database) => {
    const old = message("D1", { receivedAt: new Date(Date.now() - 31 * dayMilliseconds) });
    const fresh = message("D2", { receivedAt: new Date(Date.now() - 29 * dayMilliseconds) });
    for (const stored of [old, fresh]) {
      await store.saveMessage(stored);
      await store.save(verdictFor(stored));
      await store.labelMessage(stored, "scam", new Date(), { keepForEval: true });
    }

    assert.deepEqual(await store.purgeExpired(), { messages: 1 });
    assert.deepEqual(await store.purgeExpired(), { messages: 0 });

    const { rows: remaining } = await database.query<{ message_id: string }>("SELECT message_id FROM messages");
    assert.deepEqual(remaining, [{ message_id: "D2" }]);
    const { rows: verdicts } = await database.query<{ reason: string | null; linked: boolean }>(
      "SELECT reason, message_row_id IS NOT NULL AS linked FROM verdicts ORDER BY id");
    assert.deepEqual(verdicts, [{ reason: null, linked: false }, { reason: 'quotes "text of D2"', linked: true }]);
    assert.equal(await count(database, "feedback_labels"), 1);
    assert.equal(await count(database, "eval_examples"), 2);
  }));

test("purges in batches beyond the batch size", () => withStore(async (store, database) => {
  await database.execute(`INSERT INTO messages (group_jid, sender_jid, message_id, text, received_at)
    SELECT '${groupId}', '${senderId}', 'bulk' || n, 'old', now() - interval '40 days'
    FROM generate_series(1, 2500) AS n`);

  assert.deepEqual(await store.purgeExpired(), { messages: 2500 });
}));

test("erases one member's messages, labels, and linked eval examples", () => withStore(async (store, database) => {
  const mine = message("E1");
  const theirs = message("E2", { senderId: otherSenderId });
  for (const stored of [mine, theirs]) {
    await store.saveMessage(stored);
    await store.save(verdictFor(stored));
    await store.labelMessage(stored, "spam", new Date(), { keepForEval: true });
  }

  assert.deepEqual(await store.eraseSender(senderId), { messages: 1, evalExamples: 1 });

  const { rows } = await database.query<{ text: string }>("SELECT text FROM eval_examples");
  assert.deepEqual(rows, [{ text: "text of E2" }]);
  const { rows: reasons } = await database.query<{ reason: string | null }>(
    "SELECT reason FROM verdicts ORDER BY id");
  assert.deepEqual(reasons, [{ reason: null }, { reason: 'quotes "text of E2"' }]);
  assert.deepEqual(await store.eraseSender(senderId), { messages: 0, evalExamples: 0 });
}));

test("deletes an eval example by ID", () => withStore(async (store, database) => {
  const stored = message("F1");
  await store.saveMessage(stored);
  await store.labelMessage(stored, "spam", new Date(), { keepForEval: true });
  const { rows } = await database.query<{ id: string }>("SELECT id::text AS id FROM eval_examples");

  assert.equal(await store.deleteEvalExample(rows[0]!.id), true);
  assert.equal(await store.deleteEvalExample(rows[0]!.id), false);
  await assert.rejects(store.deleteEvalExample("1 OR 1=1"), RangeError);
}));
