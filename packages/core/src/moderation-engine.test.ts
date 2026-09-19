import assert from "node:assert/strict";
import test from "node:test";
import { ModerationEngine } from "./moderation-engine.ts";
import type {
  Classification,
  GroupMessage,
  GroupPolicy,
  Verdict,
} from "./types.ts";

const message: GroupMessage = {
  id: "message-1",
  groupId: "group-1",
  senderId: "member-1",
  text: "Guaranteed returns. Message me now.",
  receivedAt: new Date("2026-09-15T00:00:00.000Z"),
};

const livePolicy: GroupPolicy = {
  groupId: "group-1",
  version: 1,
  mode: "live",
  autoActionCategories: ["spam", "scam"],
  minimumAutoActionConfidence: 0.95,
};

function harness(classification: Classification, refuseDeletion = false) {
  const deletedMessages: GroupMessage[] = [];
  const verdicts: Verdict[] = [];
  const engine = new ModerationEngine({
    classifier: { classify: async () => classification },
    verdictStore: { save: async (verdict) => void verdicts.push(verdict) },
    whatsApp: {
      deleteMessage: async (deletedMessage) => {
        if (refuseDeletion) throw new Error("refused");
        deletedMessages.push(deletedMessage);
      },
    },
    clock: () => new Date("2026-09-15T00:01:00.000Z"),
  });

  return { deletedMessages, engine, verdicts };
}

test("shadow mode records an actionable verdict without deleting", async () => {
  const context = harness({ category: "scam", confidence: 0.99, reason: "scam copy" });

  const verdict = await context.engine.moderate(message, {
    ...livePolicy,
    mode: "shadow",
  });

  assert.equal(verdict.outcome, "shadowed");
  assert.equal(context.deletedMessages.length, 0);
  assert.deepEqual(context.verdicts, [verdict]);
});

test("live mode deletes configured high-confidence categories", async () => {
  const context = harness({ category: "spam", confidence: 0.97, reason: "bulk ad" });

  const verdict = await context.engine.moderate(message, livePolicy);

  assert.equal(verdict.outcome, "deleted");
  assert.deepEqual(context.deletedMessages, [message]);
});

test("low-confidence classifications remain allowed", async () => {
  const context = harness({ category: "scam", confidence: 0.7, reason: "uncertain" });

  const verdict = await context.engine.moderate(message, livePolicy);

  assert.equal(verdict.outcome, "allowed");
  assert.equal(context.deletedMessages.length, 0);
});

test("live mode limits deletions to five per group per minute", async () => {
  const context = harness({ category: "spam", confidence: 1, reason: "spam" });

  const verdicts = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      context.engine.moderate({ ...message, id: `message-${index}` }, livePolicy),
    ),
  );

  assert.equal(context.deletedMessages.length, 5);
  assert.equal(verdicts.at(-1)?.outcome, "rate-limited");
});

test("rejects invalid classifier confidence", async () => {
  const context = harness({ category: "spam", confidence: 1.1, reason: "invalid" });

  await assert.rejects(() => context.engine.moderate(message, livePolicy), RangeError);
  assert.equal(context.deletedMessages.length, 0);
  assert.equal(context.verdicts.length, 0);
});

test("records a verdict when the adapter refuses a deletion", async () => {
  const context = harness({ category: "scam", confidence: 0.99, reason: "scam copy" }, true);

  const verdict = await context.engine.moderate(message, livePolicy);

  assert.equal(verdict.outcome, "delete-failed");
  assert.equal(context.deletedMessages.length, 0);
  assert.deepEqual(context.verdicts, [verdict]);
});
