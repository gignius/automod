import type { WAMessage } from "@whiskeysockets/baileys";

export const groupId = "120363000000000001@g.us";
export const senderId = "61400000001@s.whatsapp.net";
export const now = new Date("2026-09-19T00:00:00.000Z");

export function rawMessage(overrides: {
  key?: Partial<NonNullable<WAMessage["key"]>>;
  message?: WAMessage["message"];
  messageTimestamp?: WAMessage["messageTimestamp"];
} = {}): WAMessage {
  return {
    key: { remoteJid: groupId, id: "3EB0ABCDEF", participant: senderId, fromMe: false, ...overrides.key },
    message: "message" in overrides ? overrides.message : { conversation: "Selling a bike, $50" },
    messageTimestamp: "messageTimestamp" in overrides ? overrides.messageTimestamp : now.getTime() / 1000,
  } as WAMessage;
}
