import { isGroupId } from "./normalize-message.ts";

/**
 * The groups this worker reads, shared by the session, the action gate, and
 * the operator channel. It only grows at runtime (a community group the bot
 * was admitted to); removing a group needs a restart without it.
 */
export class GroupAllowlist {
  readonly #groupIds = new Set<string>();

  constructor(groupIds: Iterable<string> = []) {
    for (const groupId of groupIds) {
      if (!this.add(groupId)) throw new Error("Invalid or duplicate group ID");
    }
  }

  has(groupId: string): boolean {
    return this.#groupIds.has(groupId);
  }

  /** Returns true when the group was newly added. */
  add(groupId: string): boolean {
    if (!isGroupId(groupId) || this.#groupIds.has(groupId)) return false;
    this.#groupIds.add(groupId);
    return true;
  }

  list(): string[] {
    return [...this.#groupIds];
  }

  get size(): number {
    return this.#groupIds.size;
  }
}
