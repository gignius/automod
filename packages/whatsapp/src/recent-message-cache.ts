import type { GroupMessage } from "../../core/src/types.ts";

/** The exact key WhatsApp needs to revoke another participant's group message. */
export interface ObservedMessageKey {
  remoteJid: string;
  id: string;
  participant: string;
  fromMe: false;
}

interface Entry {
  key: ObservedMessageKey;
  observedAt: number;
}

function cacheKey(groupId: string, senderId: string, messageId: string): string {
  // Validated JIDs and IDs never contain a newline, so the join is unambiguous.
  return `${groupId}\n${senderId}\n${messageId}`;
}

/**
 * Bounded memory of recently accepted messages. It suppresses duplicate
 * deliveries and is the only source of delete targets, so a deletion can only
 * name a message this process actually observed a short time ago.
 */
export class RecentMessageCache {
  readonly #entries = new Map<string, Entry>();
  readonly #maximumEntries: number;
  readonly #maximumAgeMilliseconds: number;

  constructor(maximumEntries = 10_000, maximumAgeMilliseconds = 15 * 60_000) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1 ||
      !Number.isSafeInteger(maximumAgeMilliseconds) || maximumAgeMilliseconds < 1) {
      throw new RangeError("Cache limits must be positive integers");
    }
    this.#maximumEntries = maximumEntries;
    this.#maximumAgeMilliseconds = maximumAgeMilliseconds;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Records a message; returns false when it was already observed. */
  remember(message: GroupMessage, now: Date): boolean {
    this.#prune(now.getTime());
    const key = cacheKey(message.groupId, message.senderId, message.id);
    const existing = this.#entries.get(key);
    if (existing !== undefined && this.#isFresh(existing, now.getTime())) return false;
    this.#entries.delete(key);
    if (this.#entries.size >= this.#maximumEntries) {
      const oldest = this.#entries.keys().next();
      if (!oldest.done) this.#entries.delete(oldest.value);
    }
    this.#entries.set(key, {
      key: { remoteJid: message.groupId, id: message.id, participant: message.senderId, fromMe: false },
      observedAt: now.getTime(),
    });
    return true;
  }

  find(message: Pick<GroupMessage, "groupId" | "senderId" | "id">, now: Date): ObservedMessageKey | undefined {
    this.#prune(now.getTime());
    const entry = this.#entries.get(cacheKey(message.groupId, message.senderId, message.id));
    return entry !== undefined && this.#isFresh(entry, now.getTime()) ? { ...entry.key } : undefined;
  }

  #isFresh(entry: Entry, now: number): boolean {
    return entry.observedAt > now - this.#maximumAgeMilliseconds && entry.observedAt <= now;
  }

  #prune(now: number): void {
    for (const [key, entry] of this.#entries) {
      // Insertion order is observation order unless the clock moved backwards;
      // lookups re-check freshness, so stopping early only delays reclamation.
      if (this.#isFresh(entry, now)) break;
      this.#entries.delete(key);
    }
  }
}
