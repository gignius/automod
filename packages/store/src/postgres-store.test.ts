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

test("records one verdict per stored message; the first wins", () => withStore(async (store, database) => {
  const stored = message("B1");
  await store.saveMessage(stored);

  await store.save(verdictFor(stored));
  await store.save(verdictFor(stored, { category: "allowed", outcome: "allowed" }));
  const { rows } = await database.query<{ category: string }>("SELECT category FROM verdicts");
  assert.deepEqual(rows, [{ category: "scam" }]);
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

test("label candidates put flagged messages first and skip labelled ones", () => withStore(async (store) => {
  const flagged = message("G1", { receivedAt: new Date(Date.now() - 60_000) });
  const plain = message("G2");
  const done = message("G3");
  for (const stored of [flagged, plain, done]) await store.saveMessage(stored);
  await store.save(verdictFor(flagged, { category: "scam", confidence: 0.91 }));
  await store.save(verdictFor(plain, { category: "allowed", confidence: 0.99 }));
  await store.labelMessage(done, "allowed", new Date(), { keepForEval: false });

  const candidates = await store.labelCandidates(10);

  assert.deepEqual(candidates.map((candidate) => candidate.message.id), ["G1", "G2"]);
  assert.deepEqual(candidates[0]!.verdict, { category: "scam", confidence: 0.91 });
  assert.equal(candidates[0]!.message.senderId, senderId);
  await assert.rejects(store.labelCandidates(0), RangeError);
}));

test("lists eval examples for the harness", () => withStore(async (store) => {
  const stored = message("H1");
  await store.saveMessage(stored);
  await store.labelMessage(stored, "spam", new Date(), { keepForEval: true });

  const examples = await store.listEvalExamples();
  assert.equal(examples.length, 1);
  assert.deepEqual({ ...examples[0], id: "x" }, { id: "x", groupId, text: "text of H1", expectedCategory: "spam" });
}));

test("digests offer flagged, unlabelled, recent messages with fresh codes", () => withStore(async (store, database) => {
  const flagged = message("J1");
  const allowed = message("J2");
  const labelled = message("J3");
  const stale = message("J4", { receivedAt: new Date(Date.now() - 2 * dayMilliseconds) });
  for (const stored of [flagged, allowed, labelled, stale]) {
    await store.saveMessage(stored);
    await store.save(verdictFor(stored, stored === allowed ? { category: "allowed", outcome: "allowed" } : {}));
  }
  await store.labelMessage(labelled, "scam", new Date(), { keepForEval: false });

  const digest = await store.prepareDigest(10);

  assert.equal(digest.items.length, 1);
  assert.match(digest.items[0]!.code, /^[2-9A-HJ-NP-Z]{3}$/);
  assert.deepEqual({ ...digest.items[0], code: "x" },
    { code: "x", groupId, text: "text of J1", category: "scam", confidence: 0.98 });
  assert.equal(digest.more, 0);
  assert.equal(JSON.stringify(digest).includes(senderId), false);

  const again = await store.prepareDigest(10);
  assert.deepEqual(again.items.map((item) => item.code), [digest.items[0]!.code], "unsent items are offered again");
  await store.markDigestSent([digest.items[0]!.code]);
  assert.deepEqual((await store.prepareDigest(10)).items, []);
  assert.equal(await count(database, "review_items"), 1);
}));

test("digest limits report how many more are waiting", () => withStore(async (store) => {
  for (const id of ["K1", "K2", "K3"]) {
    const stored = message(id);
    await store.saveMessage(stored);
    await store.save(verdictFor(stored));
  }

  const digest = await store.prepareDigest(2);
  assert.equal(digest.items.length, 2);
  assert.equal(digest.more, 1);
}));

test("codes label only after being sent, and feed the eval set", () => withStore(async (store, database) => {
  const stored = message("L1");
  await store.saveMessage(stored);
  await store.save(verdictFor(stored));
  const [item] = (await store.prepareDigest(10)).items;

  assert.equal(await store.labelByCode(item!.code, "allowed", new Date()), false, "not yet sent");
  await store.markDigestSent([item!.code]);
  assert.equal(await store.labelByCode(item!.code, "allowed", new Date()), true);
  assert.equal(await store.labelByCode("ZZZ", "allowed", new Date()), false);
  assert.equal(await store.labelByCode("x'; DROP", "allowed", new Date()), false);

  const { rows } = await database.query<{ expected_category: string }>("SELECT expected_category FROM eval_examples");
  assert.deepEqual(rows, [{ expected_category: "allowed" }]);

  await database.query("UPDATE review_items SET sent_at = now() - interval '8 days'");
  assert.equal(await store.labelByCode(item!.code, "scam", new Date()), false, "expired after 7 days");
  await store.purgeExpired();
  assert.equal(await count(database, "review_items"), 0);
}));

test("the action log records attempts, allows one deletion per message, and counts recent attempts",
  () => withStore(async (store, database) => {
    const stored = message("N1");
    await store.saveMessage(stored);
    const deletion = { kind: "delete" as const, groupId, requestedBy: "policy" as const,
      message: { groupId, senderId, id: "N1" }, targetJid: senderId };

    const id = await store.beginAction(deletion);
    assert.ok(id);
    assert.equal(await store.beginAction(deletion), undefined, "a second deletion attempt is refused");
    await store.finishAction(id!, "succeeded");
    await store.finishAction(id!, "failed");
    const { rows } = await database.query<{ status: string; linked: boolean }>(
      "SELECT status, message_row_id IS NOT NULL AS linked FROM actions");
    assert.deepEqual(rows, [{ status: "succeeded", linked: true }], "completed rows are never rewritten");

    const lock = await store.beginAction({ kind: "lock", groupId, requestedBy: "operator" });
    const refused = await store.beginAction({ kind: "remove", groupId, requestedBy: "operator", targetJid: senderId });
    await store.finishAction(lock!, "succeeded");
    await store.finishAction(refused!, "refused", "not-admin");
    assert.equal(await store.countRecentActions(groupId, ["lock", "unlock"], 60), 1);
    assert.equal(await store.countRecentActions(groupId, ["remove"], 60), 0, "refusals don't use up the limit");
    await assert.rejects(store.finishAction(lock!, "refused", "Not A Code"), RangeError);
  }));

test("action targets are forgotten after 30 days but the log remains", () => withStore(async (store, database) => {
  await store.beginAction({ kind: "remove", groupId, requestedBy: "operator", targetJid: senderId });
  await database.query("UPDATE actions SET created_at = now() - interval '31 days'");

  await store.purgeExpired();

  const { rows } = await database.query<{ target_jid: string | null }>("SELECT target_jid FROM actions");
  assert.deepEqual(rows, [{ target_jid: null }]);
}));

test("records the first connection time once, as the warm-up start", () => withStore(async (store) => {
  const first = await store.accountFirstConnectedAt("main");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(await store.accountFirstConnectedAt("main"), first);
  await assert.rejects(store.accountFirstConnectedAt("../x"));
}));

test("review targets resolve only for sent codes", () => withStore(async (store) => {
  const stored = message("P1");
  await store.saveMessage(stored);
  await store.save(verdictFor(stored));
  const [item] = (await store.prepareDigest(10)).items;

  assert.equal(await store.reviewTarget(item!.code), undefined);
  await store.markDigestSent([item!.code]);
  assert.deepEqual(await store.reviewTarget(item!.code), { groupId, senderId, messageId: "P1" });
}));
