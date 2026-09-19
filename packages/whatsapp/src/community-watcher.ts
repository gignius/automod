import type { GroupAllowlist } from "./group-allowlist.ts";
import type { GroupSummary } from "./whatsapp-session.ts";

/*
 * Grows the allowlist with the member groups of one WhatsApp Community once
 * this number has been admitted to them. Keyed on the community's parent ID,
 * never on group names: only community admins can put a group in the
 * community, and group admins decide whether the number gets in. The
 * announcements group and the parent itself are not watched.
 */

export interface CommunityWatcherOptions {
  communityId: string;
  allowlist: GroupAllowlist;
  listGroups(): Promise<GroupSummary[]>;
  /** Called once per newly watched group. */
  onWatched(group: GroupSummary): void;
}

export class CommunityWatcher {
  readonly #options: CommunityWatcherOptions;
  #refreshing: Promise<number> | undefined;

  constructor(options: CommunityWatcherOptions) {
    this.#options = options;
  }

  /** Checks the number's groups once; returns how many were newly watched. Overlapping calls share one check. */
  refresh(): Promise<number> {
    this.#refreshing ??= this.#refresh().finally(() => { this.#refreshing = undefined; });
    return this.#refreshing;
  }

  async #refresh(): Promise<number> {
    const { communityId, allowlist, onWatched } = this.#options;
    let added = 0;
    for (const group of await this.#options.listGroups()) {
      if (group.community !== "member" || group.communityId !== communityId) continue;
      if (!allowlist.add(group.id)) continue;
      added += 1;
      try {
        onWatched(group);
      } catch {
        // Notification failures do not undo watching.
      }
    }
    return added;
  }
}
