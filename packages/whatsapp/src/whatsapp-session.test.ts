import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { DisconnectReason, type AuthenticationCreds, type WAMessage } from "@whiskeysockets/baileys";
import type { GroupMessage } from "../../core/src/types.ts";
import { groupId, now, rawMessage } from "./test-fixtures.ts";
import {
  WhatsAppSession,
  type SessionEvent,
  type SessionSocket,
  type WhatsAppSessionOptions,
} from "./whatsapp-session.ts";

class FakeSocket {
  readonly ev = new EventEmitter();
  readonly pairingRequests: string[] = [];
  readonly sent: unknown[] = [];
  ended = false;

  asSocket(): SessionSocket {
    return {
      ev: this.ev,
      requestPairingCode: async (phoneNumber: string) => {
        this.pairingRequests.push(phoneNumber);
        return "ABCD1234";
      },
      groupMetadata: async (id: string) => ({ id, subject: "group", participants: [] }),
      sendMessage: async (jid: string, content: unknown) => void this.sent.push({ jid, content }),
      end: () => { this.ended = true; },
    } as unknown as SessionSocket;
  }

  open(): void {
    this.ev.emit("connection.update", { connection: "open" });
  }

  close(statusCode?: number): void {
    this.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: statusCode === undefined ? new Error("drop") : { output: { statusCode } }, date: now },
    });
  }

  deliver(messages: WAMessage[], type: "notify" | "append" = "notify"): void {
    this.ev.emit("messages.upsert", { messages, type });
  }
}

function harness(overrides: Partial<WhatsAppSessionOptions> & { registered?: boolean } = {}) {
  const sockets: FakeSocket[] = [];
  const events: SessionEvent[] = [];
  const handled: GroupMessage[] = [];
  const credentialUpdates: Partial<AuthenticationCreds>[] = [];
  let failAuth!: () => void;
  const creds = {
    registered: overrides.registered ?? true,
    me: { id: "61400000009:3@s.whatsapp.net", lid: "123456789012345:3@lid" },
  } as AuthenticationCreds;
  const session = new WhatsAppSession({
    auth: {
      state: { creds, keys: { get: async () => ({}), set: async () => {} } },
      failed: new Promise((resolve) => { failAuth = resolve; }),
      saveCreds: async (update = {}) => void credentialUpdates.push(update),
    },
    allowedGroupIds: [groupId],
    onMessage: async (message) => void handled.push(message),
    onEvent: (event) => events.push(event),
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket.asSocket();
    },
    clock: () => now,
    sleep: (_milliseconds, signal) => signal.aborted ? Promise.reject(signal.reason) : Promise.resolve(),
    ...overrides,
  });
  return { session, sockets, events, handled, creds, credentialUpdates, failAuth: () => failAuth() };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("hands live allowlisted group messages to the handler in order, once each", async () => {
  const context = harness();
  const finished = context.session.start();
  await settle();
  const socket = context.sockets[0]!;
  socket.open();

  socket.deliver([rawMessage({ key: { id: "A1" } }), rawMessage({ key: { id: "A2" } })]);
  socket.deliver([rawMessage({ key: { id: "A1" } })]);
  socket.deliver([rawMessage({ key: { id: "A3" } })], "append");
  socket.deliver([rawMessage({ key: { id: "A4", remoteJid: "120363000000000002@g.us" } })]);
  await settle();

  assert.deepEqual(context.handled.map((message) => message.id), ["A1", "A2"]);
  assert.deepEqual(context.session.counters, { accepted: 2, duplicates: 1, ignored: 1, handled: 2, handlerErrors: 0 });
  assert.ok(context.session.recentMessages.find({ groupId, senderId: context.handled[0]!.senderId, id: "A1" }, now));

  assert.equal(await context.session.stop(), "requested");
  assert.equal(await finished, "requested");
  assert.equal(socket.ended, true);
});

test("a failing handler does not stop later messages", async () => {
  let calls = 0;
  const context = harness({ onMessage: async () => { calls += 1; if (calls === 1) throw new Error("boom"); } });
  void context.session.start();
  await settle();
  context.sockets[0]!.deliver([rawMessage({ key: { id: "B1" } }), rawMessage({ key: { id: "B2" } })]);
  await settle();

  assert.equal(context.session.counters.handlerErrors, 1);
  assert.equal(context.session.counters.handled, 1);
  await context.session.stop();
});

test("stops instead of buffering without bound", async () => {
  const context = harness({ maximumQueuedMessages: 2 });
  const finished = context.session.start();
  await settle();

  context.sockets[0]!.deliver(["C1", "C2", "C3", "C4"].map((id) => rawMessage({ key: { id } })));

  assert.equal(await finished, "overloaded");
  assert.equal(context.handled.length, 0);
  assert.equal(context.sockets[0]!.ended, true);
});

test("stops on logout and other terminal disconnects without reconnecting", async () => {
  for (const [code, reason] of [
    [DisconnectReason.loggedOut, "logged-out"],
    [DisconnectReason.connectionReplaced, "connection-replaced"],
    [DisconnectReason.forbidden, "forbidden"],
    [DisconnectReason.multideviceMismatch, "multidevice-mismatch"],
  ] as const) {
    const context = harness();
    const finished = context.session.start();
    await settle();
    context.sockets[0]!.open();
    context.sockets[0]!.close(code);

    assert.equal(await finished, reason);
    assert.equal(context.sockets.length, 1);
  }
});

test("reconnects transient drops with bounded backoff, then gives up", async () => {
  const context = harness({ maximumReconnectAttempts: 3 });
  const finished = context.session.start();
  await settle();
  for (let index = 0; index < 4; index += 1) {
    context.sockets[index]!.close();
    await settle();
  }

  assert.equal(await finished, "reconnect-exhausted");
  assert.deepEqual(context.events.filter((event) => event.type === "reconnecting"), [
    { type: "reconnecting", attempt: 1, delayMilliseconds: 1_000 },
    { type: "reconnecting", attempt: 2, delayMilliseconds: 2_000 },
    { type: "reconnecting", attempt: 3, delayMilliseconds: 4_000 },
  ]);
});

test("an open connection resets the reconnect budget", async () => {
  const context = harness({ maximumReconnectAttempts: 1 });
  void context.session.start();
  await settle();
  context.sockets[0]!.close();
  await settle();
  context.sockets[1]!.open();
  context.sockets[1]!.close();
  await settle();

  assert.equal(context.sockets.length, 3);
  await context.session.stop();
});

test("stops when credential persistence fails", async () => {
  const context = harness();
  const finished = context.session.start();
  await settle();
  context.failAuth();

  assert.equal(await finished, "persistence-failed");
});

test("persists credential updates from the socket", async () => {
  const context = harness();
  void context.session.start();
  await settle();
  context.sockets[0]!.ev.emit("creds.update", { registered: true });

  assert.deepEqual(context.credentialUpdates, [{ registered: true }]);
  await context.session.stop();
});

test("refuses deletion transport calls until connected", async () => {
  const context = harness();
  await assert.rejects(context.session.fetchGroupMetadata(groupId), /not connected/);
  void context.session.start();
  await settle();
  context.sockets[0]!.open();

  assert.equal((await context.session.fetchGroupMetadata(groupId)).id, groupId);
  assert.deepEqual(context.session.ownIds(), ["61400000009:3@s.whatsapp.net", "123456789012345:3@lid"]);
  await context.session.stop();
  await assert.rejects(context.session.revoke({ remoteJid: groupId, id: "x", participant: "1@lid", fromMe: false }),
    /not connected/);
});

test("an unlinked session without a pairing handler stops before connecting", async () => {
  const context = harness({ registered: false });

  assert.equal(await context.session.start(), "pairing-unavailable");
  assert.equal(context.sockets.length, 0);
});

test("pairs with one code delivered only to the pairing handler", async () => {
  const codes: string[] = [];
  const context = harness({
    registered: false,
    pairing: { phoneNumber: async () => "61400000009", showCode: (code) => void codes.push(code) },
  });
  context.creds.me = { id: "61499999999@s.whatsapp.net" };
  void context.session.start();
  await settle();
  const socket = context.sockets[0]!;
  socket.ev.emit("connection.update", { qr: "ref-1" });
  socket.ev.emit("connection.update", { qr: "ref-2" });
  await settle();

  assert.equal(context.creds.me, undefined, "a stale pairing claim is cleared before connecting");
  assert.deepEqual(socket.pairingRequests, ["61400000009"]);
  assert.deepEqual(codes, ["ABCD1234"]);
  assert.equal(context.events.some((event) => JSON.stringify(event).includes("ABCD1234")), false);
  await context.session.stop();
});

test("an unconfirmed pairing ends the session when the connection closes", async () => {
  const context = harness({
    registered: false,
    pairing: { phoneNumber: async () => "61400000009", showCode: () => {} },
  });
  const finished = context.session.start();
  await settle();
  context.sockets[0]!.ev.emit("connection.update", { qr: "ref-1" });
  await settle();
  context.sockets[0]!.close();

  assert.equal(await finished, "pairing-expired");
});

test("rejects malformed pairing phone numbers", async () => {
  const context = harness({
    registered: false,
    pairing: { phoneNumber: async () => "+61 400", showCode: () => {} },
  });

  assert.equal(await context.session.start(), "pairing-failed");
  assert.equal(context.sockets.length, 0);
});

test("requires a valid, non-empty group allowlist", () => {
  assert.throws(() => harness({ allowedGroupIds: [] }));
  assert.throws(() => harness({ allowedGroupIds: ["61400000001@s.whatsapp.net"] }));
});
