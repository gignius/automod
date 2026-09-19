import assert from "node:assert/strict";
import test from "node:test";
import type { GroupMessage } from "../../core/src/index.ts";
import { InboxProcessor } from "./inbox-processor.ts";
import { migrate } from "./migrate.ts";
import { PostgresStore } from "./postgres-store.ts";
import { createTestDatabase } from "./test-database.ts";

const groupA = "120363000000000001@g.us";
const groupB = "120363000000000002@g.us";
const senderId = "61400000001@s.whatsapp.net";
const base = Date.now() - 60_000;

type TestDatabase = Awaited<ReturnType<typeof createTestDatabase>>;

function message(id: string, groupId: string, offset: number): GroupMessage {
  return { id, groupId, senderId, text: `text ${id}`, receivedAt: new Date(base + offset) };
}

async function withInbox(run: (store: PostgresStore, database: TestDatabase) => Promise<void>): Promise<void> {
  const database = await createTestDatabase();
  try {
    await migrate(database);
    await run(new PostgresStore(database), database);
  } finally {
    await database.close();
  }
}

/** Stands in for the idle wait: expires timers, then yields so the test's own timers still run. */
function fastForward(database: TestDatabase): () => Promise<void> {
  return async () => {
    await expireTimers(database);
    await new Promise((resolve) => setImmediate(resolve));
  };
}

/** Makes every pending lease and backoff due, standing in for elapsed time. */
async function expireTimers(database: TestDatabase): Promise<void> {
  await database.query("UPDATE messages SET lease_until = now() - interval '1 second' WHERE lease_until IS NOT NULL");
  await database.query(
    "UPDATE messages SET next_attempt_at = now() - interval '1 second' WHERE next_attempt_at IS NOT NULL");
}

test("claims one head per group, oldest first, and holds a group while its head is leased", () =>
  withInbox(async (store) => {
    await store.saveMessage(message("A1", groupA, 0));
    await store.saveMessage(message("B1", groupB, 1));
    await store.saveMessage(message("A2", groupA, 2));

    const first = await store.claim(10, 60);
    assert.deepEqual(first.map((entry) => entry.message.id), ["A1", "B1"]);
    assert.deepEqual(first.map((entry) => entry.attempts), [1, 1]);
    assert.deepEqual(await store.claim(10, 60), []);

    await store.complete(first[0]!.rowId);
    assert.deepEqual((await store.claim(10, 60)).map((entry) => entry.message.id), ["A2"]);
  }));

test("respects the claim limit", () => withInbox(async (store) => {
  await store.saveMessage(message("A1", groupA, 0));
  await store.saveMessage(message("B1", groupB, 1));

  assert.deepEqual((await store.claim(1, 60)).map((entry) => entry.message.id), ["A1"]);
  await assert.rejects(store.claim(0, 60), RangeError);
}));

test("an expired lease is reclaimed, as after a crash", () => withInbox(async (store, database) => {
  await store.saveMessage(message("A1", groupA, 0));
  await store.claim(10, 60);
  await expireTimers(database);

  const [reclaimed] = await store.claim(10, 60);
  assert.equal(reclaimed?.message.id, "A1");
  assert.equal(reclaimed?.attempts, 2);
}));

test("failures back off, then dead-letter and release the group", () => withInbox(async (store, database) => {
  await store.saveMessage(message("A1", groupA, 0));
  await store.saveMessage(message("A2", groupA, 1));

  let [head] = await store.claim(10, 60);
  assert.equal(await store.fail(head!.rowId, 2), "retrying");
  assert.deepEqual(await store.claim(10, 60), [], "backing off holds the group");

  await expireTimers(database);
  [head] = await store.claim(10, 60);
  assert.equal(head?.message.id, "A1");
  assert.equal(await store.fail(head!.rowId, 2), "dead");

  await expireTimers(database);
  assert.deepEqual((await store.claim(10, 60)).map((entry) => entry.message.id), ["A2"]);
}));

test("messages stored before the inbox migration are not replayed", async () => {
  const database = await createTestDatabase();
  try {
    const { copyFile, mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { defaultMigrationsDirectory } = await import("./migrate.ts");
    const directory = await mkdtemp(join(tmpdir(), "automod-migrations-"));
    try {
      await copyFile(join(defaultMigrationsDirectory, "001_initial.sql"), join(directory, "001_initial.sql"));
      await migrate(database, directory);
      await database.query(`INSERT INTO messages (group_jid, sender_jid, message_id, text, received_at)
        VALUES ($1, $2, 'old', 'history', now())`, [groupA, senderId]);
      await copyFile(join(defaultMigrationsDirectory, "002_inbox.sql"), join(directory, "002_inbox.sql"));
      await migrate(database, directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    assert.deepEqual(await new PostgresStore(database).claim(10, 60), []);
  } finally {
    await database.close();
  }
});

test("the processor handles each group in order and completes messages", () => withInbox(async (store) => {
  for (const [id, groupId, offset] of [["A1", groupA, 0], ["B1", groupB, 1], ["A2", groupA, 2], ["A3", groupA, 3]] as const) {
    await store.saveMessage(message(id, groupId, offset));
  }
  const seen: string[] = [];
  let processor!: InboxProcessor;
  processor = new InboxProcessor({
    inbox: store,
    handle: async (handled) => {
      seen.push(handled.id);
      if (seen.length === 4) void processor.stop();
    },
    idleMilliseconds: 10,
  });

  await processor.start();

  assert.deepEqual(seen.filter((id) => id.startsWith("A")), ["A1", "A2", "A3"]);
  assert.equal(processor.counters.handled, 4);
  assert.deepEqual(await store.claim(10, 60), []);
}));

test("the processor retries a failing handler without stalling other groups", () => withInbox(async (store, database) => {
  await store.saveMessage(message("A1", groupA, 0));
  await store.saveMessage(message("B1", groupB, 1));
  const seen: string[] = [];
  const processor = new InboxProcessor({
    inbox: store,
    handle: async (handled) => {
      seen.push(handled.id);
      if (handled.id === "A1") throw new Error("classifier down");
    },
    idleMilliseconds: 10,
    maximumAttempts: 2,
    sleep: fastForward(database),
  });
  const running = processor.start();
  while (processor.counters.deadLettered === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  await processor.stop();
  await running;

  assert.deepEqual(seen, ["A1", "B1", "A1"]);
  assert.deepEqual({ ...processor.counters }, { handled: 1, retried: 1, deadLettered: 1, storeErrors: 0 });
}));

test("the processor times out a hung handler and retries it", () => withInbox(async (store, database) => {
  await store.saveMessage(message("A1", groupA, 0));
  let calls = 0;
  let aborted = false;
  const processor = new InboxProcessor({
    inbox: store,
    handle: (_handled, signal) => {
      calls += 1;
      if (calls > 1) return Promise.resolve();
      signal.addEventListener("abort", () => { aborted = true; });
      return new Promise(() => {});
    },
    handlerTimeoutMilliseconds: 20,
    idleMilliseconds: 10,
    sleep: fastForward(database),
  });
  const running = processor.start();
  while (processor.counters.handled === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  await processor.stop();
  await running;

  assert.equal(aborted, true);
  assert.deepEqual({ ...processor.counters }, { handled: 1, retried: 1, deadLettered: 0, storeErrors: 0 });
}));

test("a wake claims new work without waiting out the idle period", () => withInbox(async (store) => {
  const seen: string[] = [];
  const processor = new InboxProcessor({
    inbox: store,
    handle: async (handled) => void seen.push(handled.id),
    idleMilliseconds: 60_000,
  });
  const running = processor.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await store.saveMessage(message("A1", groupA, 0));
  processor.wake();
  while (seen.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  await processor.stop();
  await running;

  assert.deepEqual(seen, ["A1"]);
}));

test("the processor survives store outages", async () => {
  let claims = 0;
  const processor = new InboxProcessor({
    inbox: {
      claim: async () => { claims += 1; throw new Error("connection refused"); },
      complete: async () => {},
      fail: async () => "retrying",
    },
    handle: async () => {},
    idleMilliseconds: 1,
  });
  const running = processor.start();
  while (claims < 3) await new Promise((resolve) => setTimeout(resolve, 1));
  await processor.stop();
  await running;

  assert.ok(processor.counters.storeErrors >= 3);
});
