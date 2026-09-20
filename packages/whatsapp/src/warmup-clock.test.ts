import assert from "node:assert/strict";
import test from "node:test";
import { WarmupClock } from "./warmup-clock.ts";

const accountId = "61400000000@s.whatsapp.net";
const startedAt = new Date("2026-09-01T00:00:00.000Z");

/** Runs scheduled retries immediately, recording the delays that were asked for. */
function harness(lookup: (attempt: number) => Promise<Date>) {
  const delays: number[] = [];
  const failures: number[] = [];
  let attempts = 0;
  const pending: (() => void)[] = [];
  const clock = new WarmupClock({
    lookup: async () => {
      attempts += 1;
      return lookup(attempts);
    },
    onFailure: (_error, attempt) => void failures.push(attempt),
    schedule: (run, delay) => {
      delays.push(delay);
      pending.push(run);
    },
  });
  const drain = async () => {
    for (let index = 0; index < 20; index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      while (pending.length > 0) pending.shift()?.();
      if (clock.startedAt() !== undefined) return;
    }
  };
  return { clock, delays, failures, drain, attemptCount: () => attempts };
}

test("a transient failure is retried with backoff instead of latching the gates shut", async () => {
  const context = harness(async (attempt) => {
    if (attempt < 3) throw new Error("the database is unreachable");
    return startedAt;
  });

  context.clock.record(accountId);
  await Promise.resolve();
  // Until it lands the clock is undefined, which refuses every gated action.
  assert.equal(context.clock.startedAt(), undefined);

  await context.drain();
  assert.deepEqual(context.clock.startedAt(), startedAt);
  assert.deepEqual(context.failures, [1, 2]);
  assert.deepEqual(context.delays, [1_000, 2_000], "retries back off");
});

test("an unreadable date counts as a failure rather than a warm-up start", async () => {
  const context = harness(async (attempt) => attempt < 2 ? new Date(Number.NaN) : startedAt);

  context.clock.record(accountId);
  await context.drain();

  assert.deepEqual(context.clock.startedAt(), startedAt);
  assert.deepEqual(context.failures, [1]);
});

test("the clock is looked up once and never re-fetched after it lands", async () => {
  const context = harness(async () => startedAt);

  // Every reconnect calls this; only the first does any work.
  context.clock.record(accountId);
  context.clock.record(accountId);
  await Promise.resolve();
  context.clock.record(accountId);

  assert.equal(context.attemptCount(), 1);
  assert.deepEqual(context.delays, []);
});

test("a reconnect during a retry gap does not fork a second chain", async () => {
  // A flapping connection calls record() on every open. Without a guard each
  // call in a gap starts its own lookup and its own successor chain, turning
  // the backoff into a burst against a database already in trouble.
  const context = harness(async (attempt) => {
    if (attempt < 3) throw new Error("the database is unreachable");
    return startedAt;
  });

  context.clock.record(accountId);
  await Promise.resolve();
  // Reconnects arriving while a retry is pending are absorbed.
  context.clock.record(accountId);
  context.clock.record(accountId);

  await context.drain();
  assert.deepEqual(context.clock.startedAt(), startedAt);
  assert.equal(context.attemptCount(), 3, "extra chains issued extra lookups");
  assert.deepEqual(context.delays, [1_000, 2_000]);
});
