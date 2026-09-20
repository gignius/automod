import type { GroupMetadata } from "@whiskeysockets/baileys";
import { isGroupAdmin, participantMatches } from "./deletion-gate.ts";

/*
 * A revocation only counts as moderation when whoever deleted the message
 * actually held admin rank. The digest turns an admin deletion into a review
 * code, and `CODE remove` then targets the deleted message's *author*, so
 * without this check anyone whose revoke reaches this worker chooses who the
 * operator is shown a removal button for. WhatsApp enforces admin-only revokes
 * on its own servers, but that is its rule to change, not a property this
 * worker can prove, and the digest is the one place a human's attention is
 * directed. Design: docs/actions-design.md.
 *
 * Ranks are cached briefly so a burst of revocations cannot amplify into a
 * burst of metadata queries, and any doubt — a failed lookup, a reply for the
 * wrong group, an unknown deleter — answers no.
 */

const defaultTtlMilliseconds = 60_000;
/*
 * A failed lookup is cached too, briefly. Caching only successes would let the
 * throttle collapse exactly when it matters: WhatsApp throttling groupMetadata
 * makes every revocation miss the cache and issue another live query, which is
 * a feedback loop against the one account the whole warm-up design exists to
 * keep un-banned. Short enough that a real admin deletion is delayed, not lost.
 */
const failureTtlMilliseconds = 10_000;
const maximumCachedGroups = 200;

type Participants = GroupMetadata["participants"];

export interface AdminVerifierOptions {
  /** Must query WhatsApp rather than a cache, so ranks are current. */
  fetchGroupMetadata(groupId: string): Promise<GroupMetadata>;
  clock?: () => Date;
  ttlMilliseconds?: number;
}

export class AdminVerifier {
  readonly #fetchGroupMetadata: (groupId: string) => Promise<GroupMetadata>;
  readonly #clock: () => Date;
  readonly #ttlMilliseconds: number;
  readonly #cache = new Map<string, { expiresAt: number; participants: Participants | undefined }>();
  readonly #inFlight = new Map<string, Promise<Participants | undefined>>();

  constructor(options: AdminVerifierOptions) {
    this.#fetchGroupMetadata = options.fetchGroupMetadata;
    this.#clock = options.clock ?? (() => new Date());
    this.#ttlMilliseconds = options.ttlMilliseconds ?? defaultTtlMilliseconds;
  }

  /** Whether any of these addresses is a current admin of the group. */
  async isAdmin(groupId: string, addresses: readonly (string | undefined)[]): Promise<boolean> {
    const known = addresses.filter((address): address is string => typeof address === "string");
    if (known.length === 0) return false;
    const participants = await this.#participants(groupId);
    if (participants === undefined) return false;
    return participants.some((participant) =>
      isGroupAdmin(participant) && known.some((address) => participantMatches(participant, address)));
  }

  #remember(groupId: string, now: number, participants: Participants | undefined): void {
    if (!Number.isFinite(now)) return;
    if (this.#cache.size >= maximumCachedGroups) this.#cache.clear();
    const ttl = participants === undefined ? failureTtlMilliseconds : this.#ttlMilliseconds;
    this.#cache.set(groupId, { expiresAt: now + ttl, participants });
  }

  async #participants(groupId: string): Promise<Participants | undefined> {
    const now = this.#clock().getTime();
    const cached = this.#cache.get(groupId);
    if (cached !== undefined && Number.isFinite(now) && cached.expiresAt > now) return cached.participants;
    const existing = this.#inFlight.get(groupId);
    if (existing !== undefined) return existing;
    const loading = this.#fetchGroupMetadata(groupId).then((metadata) => {
      // A reply about another group proves nothing about this one.
      const participants = metadata.id === groupId ? metadata.participants : undefined;
      this.#remember(groupId, now, participants);
      return participants;
    }, () => {
      this.#remember(groupId, now, undefined);
      return undefined;
    });
    this.#inFlight.set(groupId, loading);
    try {
      return await loading;
    } finally {
      this.#inFlight.delete(groupId);
    }
  }
}
