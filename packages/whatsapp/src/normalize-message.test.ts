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

test("normalizes live one-to-one text with every server-supplied sender address", async () => {
  const { normalizeDirectMessage } = await import("./normalize-message.ts");
  const direct = normalizeDirectMessage(rawMessage({
    key: { remoteJid: "123456789012345@lid", remoteJidAlt: "61400000009@s.whatsapp.net", participant: null },
    message: { conversation: "K7P scam" },
  }), now);

  assert.deepEqual(direct, {
    id: "3EB0ABCDEF",
    chatJid: "123456789012345@lid",
    senderAddresses: ["123456789012345@lid", "61400000009@s.whatsapp.net"],
    text: "K7P scam",
    receivedAt: now,
  });
  for (const key of [{ fromMe: true }, { remoteJid: groupId }, { remoteJid: "status@broadcast" }]) {
    assert.equal(normalizeDirectMessage(rawMessage({ key: { remoteJid: "61400000009@s.whatsapp.net", ...key } }), now),
      undefined, JSON.stringify(key));
  }
  assert.equal(normalizeDirectMessage(rawMessage({
    key: { remoteJid: "61400000009@s.whatsapp.net" }, message: { conversation: "x".repeat(2_049) },
  }), now), undefined);
  assert.deepEqual(normalizeDirectMessage(rawMessage({
    key: { remoteJid: "61400000009@s.whatsapp.net", remoteJidAlt: "not a jid" },
  }), now)?.senderAddresses, ["61400000009@s.whatsapp.net"]);
});

test("recognises a group admin deleting someone else's message, and nothing else", async () => {
  const { normalizeAdminRevocation } = await import("./normalize-message.ts");
  const admin = "61400000077@s.whatsapp.net";
  const revoke = (deleter: string, author: string, extra: Record<string, unknown> = {}) => rawMessage({
    key: { participant: deleter, ...extra },
    message: { protocolMessage: { type: 0, key: { remoteJid: groupId, id: "TARGET1", participant: author, fromMe: false } } },
  });

  assert.deepEqual(normalizeAdminRevocation(revoke(admin, senderId), now), {
    groupId, messageId: "TARGET1", senderId, deletedBy: admin, deletedAt: now,
  });
  assert.equal(normalizeAdminRevocation(revoke(senderId, senderId), now), undefined, "self-deletion");
  assert.equal(normalizeAdminRevocation(revoke("61400000001:4@s.whatsapp.net", senderId), now), undefined,
    "self-deletion from another device");
  assert.equal(normalizeAdminRevocation(revoke(admin, senderId, { fromMe: true }), now), undefined, "our own deletion");
  assert.equal(normalizeAdminRevocation(revoke(admin, senderId, { remoteJid: senderId }), now), undefined, "not a group");
  assert.equal(normalizeAdminRevocation(rawMessage({ key: { participant: admin },
    message: { protocolMessage: { type: 14, key: { id: "TARGET1", participant: senderId } } } }), now), undefined,
  "other protocol messages");
  assert.equal(normalizeAdminRevocation(rawMessage(), now), undefined, "ordinary text");
});
