import type { GroupMetadata } from "@whiskeysockets/baileys";
import {
  accountWarmupMilliseconds,
  groupShadowMilliseconds,
  isGroupAdmin,
  participantMatches,
  startupQuarantineMilliseconds,
  type ActionLog,
} from "./deletion-gate.ts";

/*
 * Operator-requested group changes: remove a member, lock or unlock the group,
 * approve pending join requests. A human chose each one, so live mode is not
 * required, but the account and admin checks, per-group rate limits, and the
 * durable action log all are. Design: docs/actions-design.md.
 */

export interface GroupAdminTransport {
  /** Must query WhatsApp rather than a cache, so admin rights are current. */
  fetchGroupMetadata(groupId: string): Promise<GroupMetadata>;
  ownIds(): readonly string[];
  removeParticipant(groupId: string, participantJid: string): Promise<void>;
  setAnnouncementOnly(groupId: string, announcementOnly: boolean): Promise<void>;
  pendingJoinRequests(groupId: string): Promise<string[]>;
  approveJoinRequests(groupId: string, participantJids: readonly string[]): Promise<void>;
}

export interface GroupActionLog extends ActionLog {
  countRecentActions(groupId: string, kinds: readonly ("remove" | "lock" | "unlock" | "approve")[],
    withinMinutes: number): Promise<number>;
}

export type GroupActionRefusal =
  | "unknown-group"
  | "invalid-clock"
  | "startup-quarantine"
  | "account-warming-up"
  | "group-shadow-period"
  /** The shadow clock could not be read. Distinct from the real wait, which reads as "come back in days". */
  | "shadow-check-failed"
  | "rate-limited"
  | "not-admin"
  | "not-member"
  | "protected-member"
  | "nothing-pending"
  | "failed";

export type GroupActionOutcome = { status: "succeeded"; count?: number } | { status: "refused"; refusal: GroupActionRefusal };

export interface GroupActionGateOptions {
  transport: GroupAdminTransport;
  log: GroupActionLog;
  /** Groups the worker reads; anything else is refused. A Set or the shared GroupAllowlist. */
  allowedGroupIds: { has(groupId: string): boolean };
  /** The operator's own account is never removed. */
  operatorJid: string;
  /** When this account first connected; undefined until then, which refuses everything. */
  accountWarmupStartedAt: () => Date | undefined;
  /**
   * When this worker started observing a group, for the one action that
   * silences people who have not been reviewed one by one. Undefined — a group
   * with no policy row yet, such as one auto-added from the community minutes
   * ago — refuses the lock.
   */
  groupShadowStartedAt?: (groupId: string) => Promise<Date | undefined>;
  /**
   * Reports a dependency that failed rather than answered: `action-log` (the
   * action already happened, only the record of it is missing), `shadow-check`,
   * or `rate-limit-check`. Every one of these is otherwise invisible, because
   * the operator only ever sees a refusal word.
   */
  onError?: (error: unknown, context: string, kind: string) => void;
  processStartedAt: Date;
  clock?: () => Date;
}

/** Per group, per rolling hour. Counted from the durable log, so restarts don't reset them. */
export const hourlyLimits = { remove: 10, lock: 6, approve: 1 } as const;
export const maximumApprovalsPerBatch = 20;

class Refused extends Error {
  readonly refusal: GroupActionRefusal;

  constructor(refusal: GroupActionRefusal) {
    super(refusal);
    this.refusal = refusal;
  }
}

export class GroupActionGate {
  readonly #transport: GroupAdminTransport;
  readonly #log: GroupActionLog;
  readonly #allowedGroupIds: { has(groupId: string): boolean };
  readonly #operatorJid: string;
  readonly #accountWarmupStartedAt: () => Date | undefined;
  readonly #groupShadowStartedAt: ((groupId: string) => Promise<Date | undefined>) | undefined;
  readonly #onError: (error: unknown, context: string, kind: string) => void;
  readonly #processStartedAt: number;
  readonly #clock: () => Date;

  constructor(options: GroupActionGateOptions) {
    this.#accountWarmupStartedAt = options.accountWarmupStartedAt;
    this.#processStartedAt = options.processStartedAt.getTime();
    if (!Number.isFinite(this.#processStartedAt)) throw new Error("Process start date must be valid");
    this.#transport = options.transport;
    this.#log = options.log;
    this.#allowedGroupIds = options.allowedGroupIds;
    this.#operatorJid = options.operatorJid;
    this.#groupShadowStartedAt = options.groupShadowStartedAt;
    this.#onError = options.onError ?? (() => {});
    this.#clock = options.clock ?? (() => new Date());
  }

  /** Removes a member. Admins, this account, and the operator are never removed. */
  remove(groupId: string, memberJid: string, becauseOf: { senderId: string; id: string }): Promise<GroupActionOutcome> {
    return this.#run({ kind: "remove", groupId, requestedBy: "operator", targetJid: memberJid,
      message: { groupId, senderId: becauseOf.senderId, id: becauseOf.id } },
    hourlyLimits.remove, async (metadata) => {
      const member = metadata.participants.find((participant) => participantMatches(participant, memberJid));
      if (member === undefined) throw new Refused("not-member");
      const ownIds = this.#transport.ownIds();
      if (isGroupAdmin(member) || participantMatches(member, this.#operatorJid) ||
        ownIds.some((ownId) => participantMatches(member, ownId))) {
        throw new Refused("protected-member");
      }
      await this.#transport.removeParticipant(groupId, member.id);
      return undefined;
    });
  }

  /**
   * Lock: only admins can post. Unlock: everyone can.
   *
   * Locking silences every member at once without anyone having reviewed them,
   * so unlike a removal — which the operator reaches only through a digest item
   * about one person — it waits out the same group shadow period a deletion
   * does. Unlocking is never gated: undoing a silence must always be available.
   */
  setLocked(groupId: string, locked: boolean): Promise<GroupActionOutcome> {
    return this.#run({ kind: locked ? "lock" : "unlock", groupId, requestedBy: "operator" }, hourlyLimits.lock,
      async () => {
        await this.#transport.setAnnouncementOnly(groupId, locked);
        return undefined;
      }, ["lock", "unlock"], locked);
  }

  /** Approves up to 20 pending join requests, once per group per hour. */
  approveJoinRequests(groupId: string): Promise<GroupActionOutcome> {
    return this.#run({ kind: "approve", groupId, requestedBy: "operator" }, hourlyLimits.approve, async () => {
      const pending = (await this.#transport.pendingJoinRequests(groupId)).slice(0, maximumApprovalsPerBatch);
      if (pending.length === 0) throw new Refused("nothing-pending");
      await this.#transport.approveJoinRequests(groupId, pending);
      return pending.length;
    });
  }

  /**
   * Whether this worker has watched the group long enough to silence it all.
   * "unknown" is a failed lookup, kept separate from the genuine wait so the
   * operator is never told to come back in days because Postgres blinked.
   */
  async #shadowPeriod(groupId: string, now: number, kind: string): Promise<"elapsed" | "waiting" | "unknown"> {
    if (this.#groupShadowStartedAt === undefined) return "waiting";
    let startedAt: number | undefined;
    try {
      startedAt = (await this.#groupShadowStartedAt(groupId))?.getTime();
    } catch (error) {
      this.#onError(error, "shadow-check", kind);
      return "unknown";
    }
    if (startedAt === undefined) return "waiting";
    if (!Number.isFinite(startedAt)) return "unknown";
    return now - startedAt >= groupShadowMilliseconds ? "elapsed" : "waiting";
  }

  async #run(request: Parameters<ActionLog["beginAction"]>[0], hourlyLimit: number,
    perform: (metadata: GroupMetadata) => Promise<number | undefined>,
    limitKinds: ("remove" | "lock" | "unlock" | "approve")[] =
    [request.kind as "remove" | "lock" | "unlock" | "approve"],
    requireShadowPeriod = false): Promise<GroupActionOutcome> {
    const refuse = (refusal: GroupActionRefusal): GroupActionOutcome => ({ status: "refused", refusal });
    if (!this.#allowedGroupIds.has(request.groupId)) return refuse("unknown-group");
    const now = this.#clock().getTime();
    if (!Number.isFinite(now) || now < this.#processStartedAt) return refuse("invalid-clock");
    if (now - this.#processStartedAt < startupQuarantineMilliseconds) return refuse("startup-quarantine");
    const warmupStartedAt = this.#accountWarmupStartedAt()?.getTime();
    if (warmupStartedAt === undefined || !Number.isFinite(warmupStartedAt) ||
      now - warmupStartedAt < accountWarmupMilliseconds) return refuse("account-warming-up");
    if (requireShadowPeriod) {
      const shadow = await this.#shadowPeriod(request.groupId, now, request.kind);
      if (shadow !== "elapsed") return refuse(shadow === "unknown" ? "shadow-check-failed" : "group-shadow-period");
    }
    // The same dead dependency one statement later must not escape as a thrown
    // error, or two adjacent failures give the operator two different answers.
    let recent: number;
    try {
      recent = await this.#log.countRecentActions(request.groupId, limitKinds, 60);
    } catch (error) {
      this.#onError(error, "rate-limit-check", request.kind);
      return refuse("failed");
    }
    if (recent >= hourlyLimit) return refuse("rate-limited");

    const id = await this.#log.beginAction(request);
    if (id === undefined) return refuse("failed");
    let count: number | undefined;
    try {
      const metadata = await this.#transport.fetchGroupMetadata(request.groupId);
      const ownIds = this.#transport.ownIds();
      const self = metadata.id === request.groupId
        ? metadata.participants.find((participant) => ownIds.some((ownId) => participantMatches(participant, ownId)))
        : undefined;
      if (!isGroupAdmin(self)) throw new Refused("not-admin");
      count = await perform(metadata);
    } catch (error) {
      const refusal = error instanceof Refused ? error.refusal : "failed";
      await (refusal === "failed" ? this.#log.finishAction(id, "failed")
        : this.#log.finishAction(id, "refused", refusal)).catch(() => {});
      return refuse(refusal);
    }
    // WhatsApp has already applied this. Recording it is a separate step that
    // must not be able to report a completed action as a refusal: the row stays
    // `pending` — outcome unknown — rather than becoming a `failed` row that
    // contradicts what the group saw.
    await this.#log.finishAction(id, "succeeded")
      .catch((error: unknown) => { this.#onError(error, "action-log", request.kind); });
    return count === undefined ? { status: "succeeded" } : { status: "succeeded", count };
  }
}
