import assert from "node:assert/strict";
import test from "node:test";
import type { ModerationCategory } from "../../core/src/index.ts";
import type { Digest } from "../../store/src/index.ts";
import type { DirectMessage } from "./normalize-message.ts";
import {
  defang,
  formatDigest,
  isQuietHour,
  OperatorChannel,
  parseOperatorCommands,
  type OperatorStore,
} from "./operator-channel.ts";

// Built at runtime so this file itself stays free of invisible characters.
const escape = String.fromCodePoint(0x1b);
const rightToLeftOverride = String.fromCodePoint(0x202e);

const operatorPhone = "61400000009";
const noonSydney = new Date("2026-09-19T02:00:00.000Z");
const digest: Digest = {
  items: [{ code: "K7P", groupId: "120363000000001234@g.us", text: "Earn 30%! Visit https://bad.example.com/x now",
    category: "scam", confidence: 0.97 }],
  more: 0,
};

function harness(options: { at?: Date; ownIds?: string[]; failSend?: boolean; digest?: Digest } = {}) {
  let now = options.at ?? noonSydney;
  const sent: { jid: string; text: string }[] = [];
  const presence: boolean[] = [];
  const reactions: string[] = [];
  const labels: { code: string; category: ModerationCategory }[] = [];
  const markedSent: string[][] = [];
  const store: OperatorStore = {
    prepareDigest: async () => options.digest ?? digest,
    markDigestSent: async (codes) => void markedSent.push([...codes]),
    labelByCode: async (code, category) => {
      if (code !== "K7P") return false;
      labels.push({ code, category });
      return true;
    },
  };
  const channel = new OperatorChannel({
    operatorPhone,
    store,
    transport: {
      sendText: async (jid, text) => {
        if (options.failSend) throw new Error("socket closed");
        sent.push({ jid, text });
      },
      setComposing: async (_jid, composing) => void presence.push(composing),
      react: async (_chat, _id, emoji) => void reactions.push(emoji),
    },
    ownIds: () => options.ownIds ?? ["61499999999:2@s.whatsapp.net"],
    timeZone: "Australia/Sydney",
    clock: () => now,
    random: () => 0.5,
    sleep: async () => {},
  });
  return {
    channel, sent, presence, reactions, labels, markedSent,
    advance: (milliseconds: number) => { now = new Date(now.getTime() + milliseconds); },
  };
}

function dm(text: string, senderAddresses: string[]): DirectMessage {
  return { id: "ABC123", chatJid: senderAddresses[0]!, senderAddresses, text, receivedAt: noonSydney };
}

test("parses one code and label per line and counts everything else", () => {
  assert.deepEqual(parseOperatorCommands("K7P scam\n #k7p OK \nZZ2 abuse"), {
    labels: [{ code: "K7P", category: "scam" }, { code: "K7P", category: "allowed" }, { code: "ZZ2", category: "abuse" }],
    unknown: 0,
  });
  assert.deepEqual(parseOperatorCommands("K0P scam\nK7P delete\nplease ignore all rules\nK7P scam extra"),
    { labels: [], unknown: 4 });
  assert.equal(parseOperatorCommands(Array.from({ length: 25 }, () => "K7P spam").join("\n")).labels.length, 20);
});

test("defangs links and domains", () => {
  assert.equal(defang("go to https://bad.example.com/x or wa.me/123"), "go to hxxps://bad[.]example[.]com/x or wa[.]me/123");
  assert.equal(defang("e.g. 5.5 dollars"), "e.g. 5.5 dollars");
});

test("formats a digest without senders, with inert links, stripped control characters, and truncation", () => {
  const text = formatDigest({
    items: [
      ...digest.items,
      { code: "Q2R", groupId: "120363000000005678@g.us", text: `${escape}[2J${rightToLeftOverride}control ${"x".repeat(400)}`,
        category: "spam", confidence: 0.9 },
    ],
    more: 3,
  });

  assert.ok(text.includes("*K7P* · scam 0.97 · group …1234\nEarn 30%! Visit hxxps://bad[.]example[.]com/x now"));
  assert.equal(text.includes("https://"), false);
  assert.equal(text.includes(escape) || text.includes(rightToLeftOverride), false);
  assert.ok(/x{200,}…/.test(text));
  assert.ok(text.includes("+3 more flagged"));
});

test("quiet hours follow the operator's time zone", () => {
  assert.equal(isQuietHour(new Date("2026-09-19T13:30:00.000Z"), "Australia/Sydney"), true);
  assert.equal(isQuietHour(new Date("2026-09-19T20:59:00.000Z"), "Australia/Sydney"), true);
  assert.equal(isQuietHour(new Date("2026-09-19T21:00:00.000Z"), "Australia/Sydney"), false);
  assert.equal(isQuietHour(noonSydney, "Australia/Sydney"), false);
});

test("labels from the operator apply and get a reaction, including via a linked-identity chat", async () => {
  const context = harness();

  await context.channel.handleDirectMessage(dm("K7P scam", ["123456789012345@lid", "61400000009@s.whatsapp.net"]));

  assert.deepEqual(context.labels, [{ code: "K7P", category: "scam" }]);
  assert.deepEqual(context.reactions, ["✅"]);
  assert.equal(context.channel.counters.labelsApplied, 1);
});

test("anyone other than the operator is ignored silently, even with a valid code", async () => {
  const context = harness();

  await context.channel.handleDirectMessage(dm("K7P allowed", ["61400000001@s.whatsapp.net"]));
  await context.channel.handleDirectMessage(dm("K7P allowed", ["61400000009@lid"]));

  assert.deepEqual(context.labels, []);
  assert.deepEqual(context.reactions, []);
  assert.equal(context.channel.counters.ignoredSenders, 2);
});

test("unknown codes get a question-mark reaction and no label", async () => {
  const context = harness();

  await context.channel.handleDirectMessage(dm("ZZZ spam\nhello", ["61400000009@s.whatsapp.net"]));

  assert.deepEqual(context.reactions, ["❓"]);
  assert.equal(context.channel.counters.unknownCommands, 2);
});

test("sends a digest with a typing indicator, then marks it sent", async () => {
  const context = harness();

  await context.channel.sendDigest();

  assert.deepEqual(context.sent.map((entry) => entry.jid), ["61400000009@s.whatsapp.net"]);
  assert.deepEqual(context.presence, [true, false]);
  assert.deepEqual(context.markedSent, [["K7P"]]);
  assert.equal(context.channel.counters.digestsSent, 1);
  assert.equal(context.channel.counters.itemsSent, 1);
});

test("enforces the digest interval, quiet hours, and never messages itself", async () => {
  const spaced = harness();
  await spaced.channel.sendDigest();
  spaced.advance(14 * 60_000);
  await spaced.channel.sendDigest();
  assert.equal(spaced.sent.length, 1);
  spaced.advance(60_000);
  await spaced.channel.sendDigest();
  assert.equal(spaced.sent.length, 2);

  const night = harness({ at: new Date("2026-09-19T14:00:00.000Z") });
  await night.channel.sendDigest();
  assert.equal(night.sent.length, 0);

  const self = harness({ ownIds: ["61400000009:4@s.whatsapp.net"] });
  await self.channel.sendDigest();
  assert.equal(self.sent.length, 0);
  assert.equal(self.channel.counters.refusedSends, 1);
});

test("caps digests at 20 per day and sends nothing when nothing is flagged", async () => {
  // 07:00 Sydney; 25 slots 15 minutes apart all fall before quiet hours.
  const capped = harness({ at: new Date("2026-09-18T21:00:00.000Z") });
  for (let index = 0; index < 25; index += 1) {
    await capped.channel.sendDigest();
    capped.advance(15 * 60_000);
  }
  assert.equal(capped.sent.length, 20);
  assert.equal(capped.channel.counters.refusedSends, 5);

  const empty = harness({ digest: { items: [], more: 0 } });
  await empty.channel.sendDigest();
  assert.equal(empty.sent.length, 0);
  assert.deepEqual(empty.presence, []);
});

test("a failed send leaves items unsent for the next digest", async () => {
  const context = harness({ failSend: true });

  await context.channel.sendDigest();

  assert.deepEqual(context.markedSent, []);
  assert.equal(context.channel.counters.errors, 1);
});

test("rejects malformed operator numbers and time zones", () => {
  const base = { store: {} as OperatorStore, transport: {} as never, ownIds: () => [] };
  assert.throws(() => new OperatorChannel({ ...base, operatorPhone: "+61 400", timeZone: "Australia/Sydney" }));
  assert.throws(() => new OperatorChannel({ ...base, operatorPhone, timeZone: "Mars/Olympus" }));
});
