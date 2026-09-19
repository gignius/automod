import assert from "node:assert/strict";
import test from "node:test";
import type { Classifier, GroupMessage } from "../../core/src/index.ts";
import { migrate, PostgresStore } from "../../store/src/index.ts";
import { createTestDatabase } from "../../store/src/test-database.ts";
import { shadowModeration } from "./shadow-moderation.ts";

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

    await shadowModeration(store, confidentScam)(message, new AbortController().signal);

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
      mode: "live", autoActionCategories: ["scam"], minimumAutoActionConfidence: 0.5,
      shadowStartedAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    await store.saveMessage(message);

    await shadowModeration(store, confidentScam)(message, new AbortController().signal);

    const { rows } = await database.query<{ outcome: string }>("SELECT outcome FROM verdicts");
    assert.deepEqual(rows, [{ outcome: "shadowed" }]);
  } finally {
    await database.close();
  }
});
