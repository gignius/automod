import assert from "node:assert/strict";
import test from "node:test";
import type { GroupMetadata } from "@whiskeysockets/baileys";
import { accountWarmupMilliseconds, groupShadowMilliseconds } from "./deletion-gate.ts";
import { GroupActionGate, type GroupActionLog, type GroupActionOutcome } from "./group-actions.ts";

const groupId = "120363000000001234@g.us";
const now = new Date("2026-09-19T02:00:00.000Z");
const botId = "61499999999@s.whatsapp.net";
const operatorJid = "61400000009@s.whatsapp.net";
const member = "61400000001@s.whatsapp.net";
const because = { senderId: member, id: "M1" };

function harness(options: {
  botAdmin?: "admin" | "superadmin" | null;
  participants?: GroupMetadata["participants"];
  pending?: string[];
  warmupStartedAt?: Date | undefined;
  groupShadowStartedAt?: Date | undefined;
  processStartedAt?: Date;
  recentActions?: number;
  failRemoval?: boolean;
  failFinish?: boolean;
  failShadowLookup?: boolean;
  failCount?: boolean;
} = {}) {
  const calls: string[] = [];
  const log: string[] = [];
  const errors: string[] = [];
  let nextId = 0;
  const actionLog: GroupActionLog = {
    beginAction: async (request) => {
      nextId += 1;
      log.push(`begin ${request.kind} ${request.requestedBy} ${request.targetJid ?? "-"}`);
      return String(nextId);
    },
    finishAction: async (id, status, refusal) => {
      if (options.failFinish) throw new Error("the log is unreachable");
      log.push(`finish ${id} ${status}${refusal ? ` ${refusal}` : ""}`);
    },
    countRecentActions: async () => {
      if (options.failCount) throw new Error("the log is unreachable");
      return options.recentActions ?? 0;
    },
  };
  const gate = new GroupActionGate({
    transport: {
      fetchGroupMetadata: async (id) => ({
        id,
        subject: "group",
        participants: options.participants ?? [
          { id: botId, admin: options.botAdmin === undefined ? "admin" : options.botAdmin },
          { id: member, admin: null },
          { id: "61400000002@s.whatsapp.net", admin: "admin" },
          { id: "123456789012345@lid", phoneNumber: operatorJid, admin: null },
        ],
      }) as GroupMetadata,
      ownIds: () => [`${botId.split("@")[0]}:3@s.whatsapp.net`],
      removeParticipant: async (group, jid) => {
        if (options.failRemoval) throw new Error("server said no");
        calls.push(`remove ${group} ${jid}`);
      },
      setAnnouncementOnly: async (group, on) => void calls.push(`${on ? "lock" : "unlock"} ${group}`),
      pendingJoinRequests: async () => options.pending ?? [],
      approveJoinRequests: async (group, jids) => void calls.push(`approve ${group} ${jids.length}`),
    },
    log: actionLog,
    allowedGroupIds: new Set([groupId]),
    operatorJid,
    accountWarmupStartedAt: () => "warmupStartedAt" in options ? options.warmupStartedAt
      : new Date(now.getTime() - accountWarmupMilliseconds),
    groupShadowStartedAt: async () => {
      if (options.failShadowLookup) throw new Error("the database is unreachable");
      return "groupShadowStartedAt" in options ? options.groupShadowStartedAt
        : new Date(now.getTime() - groupShadowMilliseconds);
    },
    onError: (_error: unknown, context: string, kind: string) => void errors.push(`${context} ${kind}`),
    processStartedAt: options.processStartedAt ?? new Date(now.getTime() - 120_000),
    clock: () => now,
  });
  return { gate, calls, log, errors };
}

function refused(outcome: GroupActionOutcome): string | undefined {
  return outcome.status === "refused" ? outcome.refusal : undefined;
}

test("removes an ordinary member and logs the attempt before acting", async () => {
  const context = harness();

  assert.deepEqual(await context.gate.remove(groupId, member, because), { status: "succeeded" });
  assert.deepEqual(context.calls, [`remove ${groupId} ${member}`]);
  assert.deepEqual(context.log, [`begin remove operator ${member}`, "finish 1 succeeded"]);
});

test("never removes admins, the operator, this account, or non-members", async () => {
  const context = harness();

  assert.equal(refused(await context.gate.remove(groupId, "61400000002@s.whatsapp.net", because)), "protected-member");
  assert.equal(refused(await context.gate.remove(groupId, operatorJid, because)), "protected-member");
  assert.equal(refused(await context.gate.remove(groupId, botId, because)), "protected-member");
  assert.equal(refused(await context.gate.remove(groupId, "61400000077@s.whatsapp.net", because)), "not-member");
  assert.deepEqual(context.calls, []);
  assert.ok(context.log.every((line) => !line.includes("succeeded")));
});

test("locks, unlocks, and approves up to 20 pending requests", async () => {
  const context = harness({ pending: Array.from({ length: 25 }, (_, index) => `614000001${String(index).padStart(2, "0")}@s.whatsapp.net`) });

  assert.deepEqual(await context.gate.setLocked(groupId, true), { status: "succeeded" });
  assert.deepEqual(await context.gate.setLocked(groupId, false), { status: "succeeded" });
  assert.deepEqual(await context.gate.approveJoinRequests(groupId), { status: "succeeded", count: 20 });
  assert.deepEqual(context.calls, [`lock ${groupId}`, `unlock ${groupId}`, `approve ${groupId} 20`]);
  assert.equal(refused(await harness().gate.approveJoinRequests(groupId)), "nothing-pending");
});

test("refuses unknown groups, warm-up, quarantine, bad clocks, and missing admin rights", async () => {
  assert.equal(refused(await harness().gate.setLocked("120363000000009999@g.us", true)), "unknown-group");
  assert.equal(refused(await harness({ warmupStartedAt: new Date(now.getTime() - 1_000) }).gate.setLocked(groupId, true)),
    "account-warming-up");
  assert.equal(refused(await harness({ warmupStartedAt: undefined }).gate.setLocked(groupId, true)), "account-warming-up");
  assert.equal(refused(await harness({ processStartedAt: new Date(now.getTime() - 1_000) }).gate.setLocked(groupId, true)),
    "startup-quarantine");
  assert.equal(refused(await harness({ processStartedAt: new Date(now.getTime() + 1_000) }).gate.setLocked(groupId, true)),
    "invalid-clock");
  const notAdmin = harness({ botAdmin: null });
  assert.equal(refused(await notAdmin.gate.setLocked(groupId, true)), "not-admin");
  assert.deepEqual(notAdmin.calls, []);
  assert.deepEqual(notAdmin.log, ["begin lock operator -", "finish 1 refused not-admin"]);
});

test("enforces hourly limits from the durable log", async () => {
  assert.equal(refused(await harness({ recentActions: 10 }).gate.remove(groupId, member, because)), "rate-limited");
  assert.equal(refused(await harness({ recentActions: 6 }).gate.setLocked(groupId, true)), "rate-limited");
  assert.equal(refused(await harness({ recentActions: 1, pending: ["61400000100@s.whatsapp.net"] })
    .gate.approveJoinRequests(groupId)), "rate-limited");
  assert.deepEqual(await harness({ recentActions: 9 }).gate.remove(groupId, member, because), { status: "succeeded" });
});

test("WhatsApp failures are logged as failed, not succeeded", async () => {
  const context = harness({ failRemoval: true });

  assert.equal(refused(await context.gate.remove(groupId, member, because)), "failed");
  assert.deepEqual(context.log, [`begin remove operator ${member}`, "finish 1 failed"]);
});

test("locking waits out the group shadow period; unlocking never does", async () => {
  // A group this worker has only just started watching — one auto-added from
  // the community minutes ago — cannot be silenced wholesale.
  const fresh = harness({ groupShadowStartedAt: new Date(now.getTime() - groupShadowMilliseconds + 1) });
  assert.equal(refused(await fresh.gate.setLocked(groupId, true)), "group-shadow-period");
  // Refused before the durable log or WhatsApp is touched at all.
  assert.deepEqual(fresh.calls, []);
  assert.deepEqual(fresh.log, []);

  // No policy row yet fails closed as the genuine wait.
  assert.equal(refused(await harness({ groupShadowStartedAt: undefined }).gate.setLocked(groupId, true)),
    "group-shadow-period");

  // Undoing a silence is always available, and removals are unaffected: they
  // reach the operator one reviewed person at a time.
  const unlock = harness({ groupShadowStartedAt: undefined });
  assert.deepEqual(await unlock.gate.setLocked(groupId, false), { status: "succeeded" });
  assert.deepEqual(await harness({ groupShadowStartedAt: undefined }).gate.remove(groupId, member, because),
    { status: "succeeded" });
  assert.deepEqual(unlock.calls, [`unlock ${groupId}`]);
});

test("an action WhatsApp applied is never reported as refused because the log failed", async () => {
  const context = harness({ failFinish: true });

  // The member is already gone; saying "refused" here would contradict the group.
  assert.deepEqual(await context.gate.remove(groupId, member, because), { status: "succeeded" });
  assert.deepEqual(context.calls, [`remove ${groupId} ${member}`]);
  // The row stays pending — outcome unknown — and the failure is surfaced.
  assert.deepEqual(context.errors, ["action-log remove"]);
});

test("a failed dependency is never dressed up as the seven-day wait", async () => {
  // "group-shadow-period" reads as "come back in days", so an operator told
  // that during an outage stops trying. A failed lookup says so instead, and
  // is the only one of the two that reaches the logs.
  const broken = harness({ failShadowLookup: true });
  assert.equal(refused(await broken.gate.setLocked(groupId, true)), "shadow-check-failed");
  assert.deepEqual(broken.errors, ["shadow-check lock"]);
  assert.deepEqual(broken.calls, []);

  // Unlock never consults the clock, so an outage cannot block undoing a lock.
  assert.deepEqual(await harness({ failShadowLookup: true }).gate.setLocked(groupId, false), { status: "succeeded" });

  // The same dead dependency one step later refuses too, rather than throwing
  // out of the gate and leaving the operator with no reply at all.
  const counting = harness({ failCount: true });
  assert.equal(refused(await counting.gate.remove(groupId, member, because)), "failed");
  assert.deepEqual(counting.errors, ["rate-limit-check remove"]);
  assert.deepEqual(counting.log, []);
});
