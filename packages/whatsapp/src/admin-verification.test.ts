import assert from "node:assert/strict";
import test from "node:test";
import type { GroupMetadata } from "@whiskeysockets/baileys";
import { AdminVerifier } from "./admin-verification.ts";

const groupId = "120363000000001234@g.us";
const admin = "61400000002@s.whatsapp.net";
const superAdmin = "61400000003@s.whatsapp.net";
const member = "61400000001@s.whatsapp.net";
const adminByLid = "123456789012345@lid";

function harness(options: { fail?: boolean; wrongGroup?: boolean; now?: () => Date } = {}) {
  let fetches = 0;
  const verifier = new AdminVerifier({
    fetchGroupMetadata: async (id) => {
      fetches += 1;
      if (options.fail) throw new Error("no answer");
      return {
        id: options.wrongGroup ? "120363000000009999@g.us" : id,
        subject: "group",
        participants: [
          { id: admin, admin: "admin" },
          { id: superAdmin, admin: "superadmin" },
          { id: member, admin: null },
          { id: adminByLid, phoneNumber: "61400000004@s.whatsapp.net", admin: "admin" },
        ],
      } as GroupMetadata;
    },
    ...(options.now === undefined ? {} : { clock: options.now }),
  });
  return { verifier, fetchCount: () => fetches };
}

test("only a current admin counts as having deleted a message", async () => {
  const { verifier } = harness();

  assert.equal(await verifier.isAdmin(groupId, [admin]), true);
  assert.equal(await verifier.isAdmin(groupId, [superAdmin]), true);
  // The hole this closes: an ordinary member's revoke used to mint a review
  // code, choosing who the operator is shown a removal button for.
  assert.equal(await verifier.isAdmin(groupId, [member]), false);
  assert.equal(await verifier.isAdmin(groupId, ["61400000077@s.whatsapp.net"]), false);
});

test("an admin is recognised under any address WhatsApp gave for them", async () => {
  const { verifier } = harness();

  assert.equal(await verifier.isAdmin(groupId, [adminByLid]), true);
  assert.equal(await verifier.isAdmin(groupId, ["61400000004@s.whatsapp.net"]), true);
  // Device suffixes and the legacy namespace still match the same account.
  assert.equal(await verifier.isAdmin(groupId, [`${admin.split("@")[0]}:7@s.whatsapp.net`]), true);
  assert.equal(await verifier.isAdmin(groupId, [`${admin.split("@")[0]}@c.us`]), true);
});

test("any doubt answers no", async () => {
  assert.equal(await harness({ fail: true }).verifier.isAdmin(groupId, [admin]), false);
  // A reply about another group proves nothing about this one.
  assert.equal(await harness({ wrongGroup: true }).verifier.isAdmin(groupId, [admin]), false);
  assert.equal(await harness().verifier.isAdmin(groupId, []), false);
  assert.equal(await harness().verifier.isAdmin(groupId, [undefined]), false);
  assert.equal(await harness().verifier.isAdmin(groupId, ["not-a-jid"]), false);
});

test("a burst of revocations shares one metadata query", async () => {
  const now = new Date("2026-09-19T02:00:00.000Z");
  const context = harness({ now: () => now });

  const answers = await Promise.all([
    context.verifier.isAdmin(groupId, [admin]),
    context.verifier.isAdmin(groupId, [member]),
    context.verifier.isAdmin(groupId, [superAdmin]),
  ]);
  assert.deepEqual(answers, [true, false, true]);
  assert.equal(context.fetchCount(), 1, "concurrent lookups amplified into extra queries");

  // Still cached a moment later, and re-queried once the entry expires.
  assert.equal(await context.verifier.isAdmin(groupId, [admin]), true);
  assert.equal(context.fetchCount(), 1);
});

test("ranks are re-read after the cache expires, so a demotion is noticed", async () => {
  let now = new Date("2026-09-19T02:00:00.000Z");
  const context = harness({ now: () => now });

  assert.equal(await context.verifier.isAdmin(groupId, [admin]), true);
  now = new Date(now.getTime() + 61_000);
  assert.equal(await context.verifier.isAdmin(groupId, [admin]), true);
  assert.equal(context.fetchCount(), 2);
});

test("a failing lookup is cached too, so the throttle holds when it matters most", async () => {
  // Caching only successes would collapse the throttle exactly when WhatsApp is
  // rejecting groupMetadata: every revocation would miss and issue another live
  // query against the one account the warm-up design exists to keep un-banned.
  let now = new Date("2026-09-19T02:00:00.000Z");
  const context = harness({ fail: true, now: () => now });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(await context.verifier.isAdmin(groupId, [admin]), false);
  }
  assert.equal(context.fetchCount(), 1, "a burst of failures amplified into a burst of queries");

  // Held for a shorter window than a success, so a real admin deletion is
  // delayed by seconds rather than dropped for a minute.
  now = new Date(now.getTime() + 11_000);
  assert.equal(await context.verifier.isAdmin(groupId, [admin]), false);
  assert.equal(context.fetchCount(), 2);
});

test("a reply about the wrong group is cached as a failure, not retried in a loop", async () => {
  const now = new Date("2026-09-19T02:00:00.000Z");
  const context = harness({ wrongGroup: true, now: () => now });

  assert.equal(await context.verifier.isAdmin(groupId, [admin]), false);
  assert.equal(await context.verifier.isAdmin(groupId, [admin]), false);
  assert.equal(context.fetchCount(), 1);
});
