import type { WAMessage } from "@whiskeysockets/baileys";
import type { GroupMessage } from "../../core/src/types.ts";
import { isSameAccount } from "./deletion-gate.ts";

export function isGroupId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9-]{1,40}@g\.us$/.test(value);
}

/** The send time in milliseconds, if it is recent enough to count as live traffic. */
function liveTimestamp(message: WAMessage, now: Date): number | undefined {
  const rawTimestamp: unknown = message.messageTimestamp;
  const timestamp = typeof rawTimestamp === "number" ? rawTimestamp
    : typeof rawTimestamp === "object" && rawTimestamp !== null && "toNumber" in rawTimestamp &&
      typeof rawTimestamp.toNumber === "function" ? rawTimestamp.toNumber() : undefined;
  if (timestamp === undefined || !Number.isSafeInteger(timestamp) || timestamp <= 0) return;
  const milliseconds = timestamp * 1000;
  if (!Number.isSafeInteger(milliseconds) || !Number.isFinite(now.getTime()) ||
    milliseconds < now.getTime() - 300_000 || milliseconds > now.getTime() + 30_000) return;
  return milliseconds;
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
  const milliseconds = liveTimestamp(message, now);
  if (milliseconds === undefined) return;

  return {
    id: key.id,
    groupId: key.remoteJid,
    senderId: key.participant,
    text,
    receivedAt: new Date(milliseconds),
  };
}

/** A live one-to-one text message. Only the operator channel consumes these. */
export interface DirectMessage {
  id: string;
  /** The chat address to reply or react in. */
  chatJid: string;
  /** Every address WhatsApp gave for the sender: the chat JID and, when present, its server-supplied alternate. */
  senderAddresses: string[];
  text: string;
  receivedAt: Date;
}

const userJidPattern = /^\d{1,20}(?::\d{1,5})?@(s\.whatsapp\.net|lid)$/;

export function normalizeDirectMessage(message: WAMessage, now: Date): DirectMessage | undefined {
  const key = message.key;
  if (!key || key.fromMe !== false || typeof key.remoteJid !== "string" || !userJidPattern.test(key.remoteJid) ||
    typeof key.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(key.id)) return;
  const content = message.message?.ephemeralMessage?.message ?? message.message;
  if (!content || content.protocolMessage || content.ephemeralMessage ||
    content.viewOnceMessage || content.viewOnceMessageV2 || content.editedMessage) return;
  const text = content.conversation ?? content.extendedTextMessage?.text;
  if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text, "utf8") > 2_048) return;
  const milliseconds = liveTimestamp(message, now);
  if (milliseconds === undefined) return;
  const alternate = typeof key.remoteJidAlt === "string" && userJidPattern.test(key.remoteJidAlt)
    ? [key.remoteJidAlt] : [];
  return {
    id: key.id,
    chatJid: key.remoteJid,
    senderAddresses: [key.remoteJid, ...alternate],
    text,
    receivedAt: new Date(milliseconds),
  };
}

/**
 * A group message deleted by someone other than its author. Whether the
 * deleter was really an admin is not knowable from the stanza; AdminVerifier
 * decides that against current group metadata before anything is recorded.
 */
export interface AdminRevocation {
  groupId: string;
  messageId: string;
  /** The deleted message's author. */
  senderId: string;
  /** The account that deleted it. */
  deletedBy: string;
  /** Every address WhatsApp gave for the deleter, for matching against group metadata. */
  deletedByAddresses: string[];
  deletedAt: Date;
}

/** REVOKE in WhatsApp's ProtocolMessage.Type. */
const revokeType = 0;

export function normalizeAdminRevocation(message: WAMessage, now: Date): AdminRevocation | undefined {
  const key = message.key;
  if (!key || key.fromMe !== false || !isGroupId(key.remoteJid) || typeof key.participant !== "string" ||
    !userJidPattern.test(key.participant)) return;
  const protocol = (message.message?.ephemeralMessage?.message ?? message.message)?.protocolMessage;
  if (!protocol || protocol.type !== revokeType) return;
  const target = protocol.key;
  if (!target || typeof target.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(target.id) ||
    typeof target.participant !== "string" || !userJidPattern.test(target.participant) ||
    target.fromMe === true) return;
  // Deleting your own message is not moderation. Compare every address form WhatsApp gave.
  const deleterAddresses = [key.participant, key.participantAlt];
  if (deleterAddresses.some((deleter) => isSameAccount(deleter ?? undefined, target.participant ?? undefined))) return;
  const milliseconds = liveTimestamp(message, now);
  if (milliseconds === undefined) return;
  const alternate = typeof key.participantAlt === "string" && userJidPattern.test(key.participantAlt)
    ? [key.participantAlt] : [];
  return {
    groupId: key.remoteJid,
    messageId: target.id,
    senderId: target.participant,
    deletedBy: key.participant,
    deletedByAddresses: [key.participant, ...alternate],
    deletedAt: new Date(milliseconds),
  };
}
