import type { GroupMetadata } from "@whiskeysockets/baileys";
import {
  accountWarmupMilliseconds,
  isSameAccount,
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
  allowedGroupIds: Iterable<string>;
  /** The operator's own account is never removed. */
  operatorJid: string;
  /** When this account first connected; undefined until then, which refuses everything. */
  accountWarmupStartedAt: () => Date | undefined;
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

function participantMatches(participant: GroupMetadata["participants"][number], jid: string): boolean {
  return [participant.id, participant.lid, participant.phoneNumber].some((id) => isSameAccount(id, jid));
}

export class GroupActionGate {
  readonly #transport: GroupAdminTransport;
  readonly #log: GroupActionLog;
  readonly #allowedGroupIds: ReadonlySet<string>;
  readonly #operatorJid: string;
  readonly #accountWarmupStartedAt: () => Date | undefined;
  readonly #processStartedAt: number;
  readonly #clock: () => Date;

  constructor(options: GroupActionGateOptions) {
    this.#accountWarmupStartedAt = options.accountWarmupStartedAt;
    this.#processStartedAt = options.processStartedAt.getTime();
    if (!Number.isFinite(this.#processStartedAt)) throw new Error("Process start date must be valid");
    this.#transport = options.transport;
    this.#log = options.log;
    this.#allowedGroupIds = new Set(options.allowedGroupIds);
    this.#operatorJid = options.operatorJid;
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
      if (member.admin === "admin" || member.admin === "superadmin" || participantMatches(member, this.#operatorJid) ||
        ownIds.some((ownId) => participantMatches(member, ownId))) {
        throw new Refused("protected-member");
      }
      await this.#transport.removeParticipant(groupId, member.id);
      return undefined;
    });
  }

  /** Lock: only admins can post. Unlock: everyone can. */
  setLocked(groupId: string, locked: boolean): Promise<GroupActionOutcome> {
    return this.#run({ kind: locked ? "lock" : "unlock", groupId, requestedBy: "operator" }, hourlyLimits.lock,
      async () => {
        await this.#transport.setAnnouncementOnly(groupId, locked);
        return undefined;
      }, ["lock", "unlock"]);
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

  async #run(request: Parameters<ActionLog["beginAction"]>[0], hourlyLimit: number,
    perform: (metadata: GroupMetadata) => Promise<number | undefined>,
    limitKinds: ("remove" | "lock" | "unlock" | "approve")[] =
    [request.kind as "remove" | "lock" | "unlock" | "approve"]): Promise<GroupActionOutcome> {
    const refuse = (refusal: GroupActionRefusal): GroupActionOutcome => ({ status: "refused", refusal });
    if (!this.#allowedGroupIds.has(request.groupId)) return refuse("unknown-group");
    const now = this.#clock().getTime();
    if (!Number.isFinite(now) || now < this.#processStartedAt) return refuse("invalid-clock");
    if (now - this.#processStartedAt < startupQuarantineMilliseconds) return refuse("startup-quarantine");
    const warmupStartedAt = this.#accountWarmupStartedAt()?.getTime();
    if (warmupStartedAt === undefined || !Number.isFinite(warmupStartedAt) ||
      now - warmupStartedAt < accountWarmupMilliseconds) return refuse("account-warming-up");
    if (await this.#log.countRecentActions(request.groupId, limitKinds, 60) >= hourlyLimit) {
      return refuse("rate-limited");
    }

    const id = await this.#log.beginAction(request);
    if (id === undefined) return refuse("failed");
    try {
      const metadata = await this.#transport.fetchGroupMetadata(request.groupId);
      const ownIds = this.#transport.ownIds();
      const self = metadata.id === request.groupId
        ? metadata.participants.find((participant) => ownIds.some((ownId) => participantMatches(participant, ownId)))
        : undefined;
      if (self?.admin !== "admin" && self?.admin !== "superadmin") throw new Refused("not-admin");
      const count = await perform(metadata);
      await this.#log.finishAction(id, "succeeded");
      return count === undefined ? { status: "succeeded" } : { status: "succeeded", count };
    } catch (error) {
      const refusal = error instanceof Refused ? error.refusal : "failed";
      await (refusal === "failed" ? this.#log.finishAction(id, "failed")
        : this.#log.finishAction(id, "refused", refusal)).catch(() => {});
      return refuse(refusal);
    }
  }
}
