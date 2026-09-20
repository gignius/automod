import type { GroupMetadata } from "@whiskeysockets/baileys";
import { RollingWindowLimiter } from "../../core/src/rolling-window-limiter.ts";
import type { GroupMessage, ModerationMode, WhatsAppAdapter } from "../../core/src/types.ts";
import type { ObservedMessageKey, RecentMessageCache } from "./recent-message-cache.ts";

const dayMilliseconds = 24 * 60 * 60_000;
export const startupQuarantineMilliseconds = 60_000;
export const accountWarmupMilliseconds = 5 * dayMilliseconds;
export const groupShadowMilliseconds = 7 * dayMilliseconds;

export interface GroupActionPolicy {
  groupId: string;
  mode: ModerationMode;
  shadowStartedAt: Date;
}

/** What the gate needs from a connected session. */
export interface DeletionTransport {
  /** Must query WhatsApp rather than a cache, so admin rights are current. */
  fetchGroupMetadata(groupId: string): Promise<GroupMetadata>;
  revoke(key: ObservedMessageKey): Promise<void>;
  ownIds(): readonly string[];
}

export type DeletionRefusal =
  | "not-live"
  | "invalid-clock"
  | "startup-quarantine"
  | "account-warming-up"
  | "group-shadow-period"
  | "unknown-message"
  | "rate-limited"
  | "not-admin"
  | "already-attempted";

export class DeletionRefusedError extends Error {
  readonly refusal: DeletionRefusal;

  constructor(refusal: DeletionRefusal) {
    super(`Deletion refused: ${refusal}`);
    this.name = "DeletionRefusedError";
    this.refusal = refusal;
  }
}

export interface GatedDeletionOptions {
  transport: DeletionTransport;
  recentMessages: RecentMessageCache;
  /** The group's current action policy, read at the moment of each deletion. */
  policyFor(groupId: string): Promise<GroupActionPolicy | undefined>;
  /** When this account first connected; undefined until then, which refuses everything. */
  accountWarmupStartedAt: () => Date | undefined;
  processStartedAt: Date;
  clock?: () => Date;
  limiter?: RollingWindowLimiter;
}

function elapsed(since: Date, now: number): number {
  return now - since.getTime();
}

const accountJidPattern = /^(\d{1,20})(?::\d{1,5})?@(s\.whatsapp\.net|c\.us|lid)$/;

/**
 * Same account, ignoring device suffixes. Unlike Baileys' areJidsSameUser this
 * compares the address namespace too and never matches two malformed IDs.
 */
export function isSameAccount(left: string | undefined, right: string | undefined): boolean {
  const leftMatch = left === undefined ? null : accountJidPattern.exec(left);
  const rightMatch = right === undefined ? null : accountJidPattern.exec(right);
  if (leftMatch === null || rightMatch === null) return false;
  const namespace = (server: string | undefined) => server === "c.us" ? "s.whatsapp.net" : server;
  return leftMatch[1] === rightMatch[1] && namespace(leftMatch[2]) === namespace(rightMatch[2]);
}

/**
 * One stable key for an account: the device suffix dropped and c.us folded
 * into s.whatsapp.net, so re-linking the same number yields the same key.
 * Undefined for anything malformed, which callers must treat as no identity.
 */
export function normalizeAccountId(jid: string | undefined): string | undefined {
  const match = jid === undefined ? null : accountJidPattern.exec(jid);
  if (match === null) return undefined;
  return `${match[1]}@${match[2] === "c.us" ? "s.whatsapp.net" : match[2]}`;
}

/** Whether a group participant is this account, under any address WhatsApp gave for it. */
export function participantMatches(
  participant: Pick<GroupMetadata["participants"][number], "id" | "lid" | "phoneNumber">, jid: string,
): boolean {
  return [participant.id, participant.lid, participant.phoneNumber].some((id) => isSameAccount(id, jid));
}

/** Group ranks that may moderate. A plain member holds neither. */
export function isGroupAdmin(
  participant: Pick<GroupMetadata["participants"][number], "admin"> | undefined,
): boolean {
  return participant?.admin === "admin" || participant?.admin === "superadmin";
}

/**
 * Independent envelope around every deletion. The moderation engine decides
 * *whether* a message deserves removal; this gate decides whether this account
 * may remove it right now, and fails closed on any doubt.
 */
export class GatedDeletionAdapter implements WhatsAppAdapter {
  readonly #transport: DeletionTransport;
  readonly #recentMessages: RecentMessageCache;
  readonly #policyFor: (groupId: string) => Promise<GroupActionPolicy | undefined>;
  readonly #accountWarmupStartedAt: () => Date | undefined;
  readonly #processStartedAt: Date;
  readonly #clock: () => Date;
  readonly #limiter: RollingWindowLimiter;

  constructor(options: GatedDeletionOptions) {
    if (!Number.isFinite(options.processStartedAt.getTime())) throw new Error("Process start date must be valid");
    this.#transport = options.transport;
    this.#recentMessages = options.recentMessages;
    this.#policyFor = options.policyFor;
    this.#accountWarmupStartedAt = options.accountWarmupStartedAt;
    this.#processStartedAt = new Date(options.processStartedAt);
    this.#clock = options.clock ?? (() => new Date());
    this.#limiter = options.limiter ?? new RollingWindowLimiter(5, 60_000);
  }

  async deleteMessage(message: GroupMessage): Promise<void> {
    const policy = await this.#policyFor(message.groupId);
    if (policy?.mode !== "live" || policy.groupId !== message.groupId ||
      !Number.isFinite(policy.shadowStartedAt.getTime())) {
      throw new DeletionRefusedError("not-live");
    }

    const now = this.#clock();
    const nowMilliseconds = now.getTime();
    if (!Number.isFinite(nowMilliseconds) || nowMilliseconds < this.#processStartedAt.getTime()) {
      throw new DeletionRefusedError("invalid-clock");
    }
    if (elapsed(this.#processStartedAt, nowMilliseconds) < startupQuarantineMilliseconds) {
      throw new DeletionRefusedError("startup-quarantine");
    }
    const warmupStartedAt = this.#accountWarmupStartedAt();
    if (warmupStartedAt === undefined || !Number.isFinite(warmupStartedAt.getTime()) ||
      elapsed(warmupStartedAt, nowMilliseconds) < accountWarmupMilliseconds) {
      throw new DeletionRefusedError("account-warming-up");
    }
    if (elapsed(policy.shadowStartedAt, nowMilliseconds) < groupShadowMilliseconds) {
      throw new DeletionRefusedError("group-shadow-period");
    }

    const key = this.#recentMessages.find(message, now);
    if (key === undefined) throw new DeletionRefusedError("unknown-message");
    // Count attempts, not successes, so failures cannot be retried in a burst.
    if (!this.#limiter.tryAcquire(message.groupId, now)) {
      throw new DeletionRefusedError("rate-limited");
    }

    const metadata = await this.#transport.fetchGroupMetadata(message.groupId);
    const ownIds = this.#transport.ownIds();
    const self = metadata.id === message.groupId
      ? metadata.participants.find((participant) => ownIds.some((ownId) => participantMatches(participant, ownId)))
      : undefined;
    if (!isGroupAdmin(self)) {
      throw new DeletionRefusedError("not-admin");
    }

    await this.#transport.revoke(key);
  }
}

/** The slice of the action log the audited adapters need. */
export interface ActionLog {
  beginAction(request: {
    kind: "delete" | "remove" | "lock" | "unlock" | "approve";
    groupId: string;
    requestedBy: "policy" | "operator";
    /** Which operator asked, as their short label. More than one person can act. */
    actor?: string;
    message?: { groupId: string; senderId: string; id: string };
    targetJid?: string;
  }): Promise<string | undefined>;
  finishAction(id: string, status: "succeeded" | "failed" | "refused", refusal?: string): Promise<void>;
}

/**
 * Writes every automatic deletion attempt to the durable action log before the
 * gate runs, and refuses a message that was already attempted, so a retry or
 * replay after a crash can never delete twice.
 */
export class AuditedDeletionAdapter implements WhatsAppAdapter {
  readonly #log: ActionLog;
  readonly #inner: WhatsAppAdapter;

  constructor(log: ActionLog, inner: WhatsAppAdapter) {
    this.#log = log;
    this.#inner = inner;
  }

  async deleteMessage(message: GroupMessage): Promise<void> {
    const id = await this.#log.beginAction({
      kind: "delete",
      groupId: message.groupId,
      requestedBy: "policy",
      message: { groupId: message.groupId, senderId: message.senderId, id: message.id },
      targetJid: message.senderId,
    });
    if (id === undefined) throw new DeletionRefusedError("already-attempted");
    try {
      await this.#inner.deleteMessage(message);
    } catch (error) {
      await this.#log.finishAction(id, error instanceof DeletionRefusedError ? "refused" : "failed",
        error instanceof DeletionRefusedError ? error.refusal : undefined).catch(() => {});
      throw error;
    }
    await this.#log.finishAction(id, "succeeded");
  }
}
