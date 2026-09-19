import type { WAMessage } from "@whiskeysockets/baileys";
import type { GroupMessage } from "../../core/src/types.ts";

export function isGroupId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9-]{1,40}@g\.us$/.test(value);
}

export function normalizeMessage(message: WAMessage, now: Date): GroupMessage | undefined {
  const key = message.key;
  if (!key || key.fromMe !== false || !isGroupId(key.remoteJid) ||
    typeof key.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(key.id) ||
    typeof key.participant !== "string" ||
    !/^\d{1,20}(?::\d{1,5})?@(s\.whatsapp\.net|lid)$/.test(key.participant)) return;

  // Disappearing-message groups may wrap ordinary text once; unwrap only that container.
  const content = message.message?.ephemeralMessage?.message ?? message.message;
  if (!content || content.protocolMessage || content.ephemeralMessage ||
    content.viewOnceMessage || content.viewOnceMessageV2 || content.editedMessage) return;
  const text = content.conversation ?? content.extendedTextMessage?.text;
  if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text, "utf8") > 16_384) return;
  const rawTimestamp: unknown = message.messageTimestamp;
  const timestamp = typeof rawTimestamp === "number" ? rawTimestamp
    : typeof rawTimestamp === "object" && rawTimestamp !== null && "toNumber" in rawTimestamp &&
      typeof rawTimestamp.toNumber === "function" ? rawTimestamp.toNumber() : undefined;
  if (timestamp === undefined || !Number.isSafeInteger(timestamp) || timestamp <= 0) return;
  const milliseconds = timestamp * 1000;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < now.getTime() - 300_000 ||
    milliseconds > now.getTime() + 30_000 || !Number.isFinite(now.getTime())) return;

  return {
    id: key.id,
    groupId: key.remoteJid,
    senderId: key.participant,
    text,
    receivedAt: new Date(milliseconds),
  };
}
