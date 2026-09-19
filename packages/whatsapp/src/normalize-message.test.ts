import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMessage } from "./normalize-message.ts";
import { groupId, now, rawMessage, senderId } from "./test-fixtures.ts";

test("normalizes live group text", () => {
  assert.deepEqual(normalizeMessage(rawMessage(), now), {
    id: "3EB0ABCDEF",
    groupId,
    senderId,
    text: "Selling a bike, $50",
    receivedAt: now,
  });
});

test("accepts extended text and disappearing-message wrappers", () => {
  assert.equal(normalizeMessage(rawMessage({ message: { extendedTextMessage: { text: "link text" } } }), now)?.text,
    "link text");
  assert.equal(normalizeMessage(rawMessage({
    message: { ephemeralMessage: { message: { conversation: "vanishing" } } },
  }), now)?.text, "vanishing");
});

test("ignores own messages, DMs, statuses, and malformed identifiers", () => {
  for (const key of [
    { fromMe: true },
    { remoteJid: senderId },
    { remoteJid: "status@broadcast" },
    { participant: "not-a-jid" },
    { participant: null },
    { id: "../../etc" },
  ]) {
    assert.equal(normalizeMessage(rawMessage({ key }), now), undefined, JSON.stringify(key));
  }
});

test("ignores media, view-once, edits, control messages, and empty or oversized text", () => {
  for (const message of [
    { imageMessage: { caption: "caption" } },
    { viewOnceMessageV2: { message: { conversation: "once" } } },
    { editedMessage: { message: { conversation: "edit" } } },
    { protocolMessage: { type: 0 } },
    { ephemeralMessage: { message: { ephemeralMessage: { message: { conversation: "nested" } } } } },
    { conversation: "   " },
    { conversation: "x".repeat(16_385) },
    null,
  ]) {
    assert.equal(normalizeMessage(rawMessage({ message }), now), undefined);
  }
});

test("ignores stale, future, and missing timestamps", () => {
  const seconds = now.getTime() / 1000;
  for (const messageTimestamp of [seconds - 301, seconds + 31, 0, null, 1.5]) {
    assert.equal(normalizeMessage(rawMessage({ messageTimestamp }), now), undefined, String(messageTimestamp));
  }
  assert.ok(normalizeMessage(rawMessage({ messageTimestamp: seconds - 299 }), now));
});
