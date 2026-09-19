import assert from "node:assert/strict";
import test from "node:test";
import type { GroupMessage } from "../../core/src/types.ts";
import { RecentMessageCache } from "./recent-message-cache.ts";
import { groupId, now, senderId } from "./test-fixtures.ts";

const message: GroupMessage = { id: "m1", groupId, senderId, text: "hello", receivedAt: now };
const later = (milliseconds: number) => new Date(now.getTime() + milliseconds);

test("suppresses duplicate deliveries and returns the exact revocation key", () => {
  const cache = new RecentMessageCache();

  assert.equal(cache.remember(message, now), true);
  assert.equal(cache.remember({ ...message, text: "changed" }, later(1)), false);
  assert.deepEqual(cache.find(message, later(2)), { remoteJid: groupId, id: "m1", participant: senderId, fromMe: false });
});

test("does not match the same ID from another sender or group", () => {
  const cache = new RecentMessageCache();
  cache.remember(message, now);

  assert.equal(cache.find({ ...message, senderId: "61400000002@s.whatsapp.net" }, now), undefined);
  assert.equal(cache.find({ ...message, groupId: "120363000000000002@g.us" }, now), undefined);
});

test("forgets entries after the maximum age", () => {
  const cache = new RecentMessageCache(10, 1_000);
  cache.remember(message, now);

  assert.equal(cache.find(message, later(1_000)), undefined);
  assert.equal(cache.size, 0);
  assert.equal(cache.remember(message, later(1_001)), true);
});

test("evicts the oldest entry at capacity", () => {
  const cache = new RecentMessageCache(2, 60_000);
  for (const id of ["m1", "m2", "m3"]) cache.remember({ ...message, id }, now);

  assert.equal(cache.size, 2);
  assert.equal(cache.find(message, now), undefined);
  assert.ok(cache.find({ ...message, id: "m3" }, now));
});

test("treats entries observed in the future as unknown", () => {
  const cache = new RecentMessageCache();
  cache.remember(message, later(5_000));

  assert.equal(cache.find(message, now), undefined);
});
