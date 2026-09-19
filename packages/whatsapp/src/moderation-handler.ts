import {
  ModerationEngine,
  type Classifier,
  type GroupMessage,
  type GroupPolicy,
  type WhatsAppAdapter,
} from "../../core/src/index.ts";
import type { PostgresStore, StoredPolicy } from "../../store/src/index.ts";

export interface ModerationHandlerOptions {
  store: PostgresStore;
  classifier: Classifier;
  /** Groups the worker was started with `--live-group` for. Empty means shadow everywhere. */
  liveGroupIds?: ReadonlySet<string>;
  /** The gated, audited deletion path; without it nothing can be deleted. */
  deletion?: WhatsAppAdapter;
}

const refuseAll: WhatsAppAdapter = {
  deleteMessage: async () => { throw new Error("No deletion path is configured"); },
};

/** Live needs both keys: the stored policy says live, and the operator started the worker with this group live. */
export function isLive(policy: StoredPolicy | undefined, liveGroupIds: ReadonlySet<string>): boolean {
  return policy?.mode === "live" && liveGroupIds.has(policy.groupId);
}

/**
 * The worker's moderation loop. A group is live only when its stored policy
 * says live, the worker was started with that group live, and a deletion path
 * exists; everything else runs in shadow, so neither a tampered policy row nor
 * a stray flag alone can remove a message. Deletions still pass every gate.
 */
export function createModerationHandler(options: ModerationHandlerOptions) {
  const liveGroupIds = options.liveGroupIds ?? new Set<string>();
  const engine = new ModerationEngine({
    classifier: options.classifier,
    verdictStore: options.store,
    whatsApp: options.deletion ?? refuseAll,
  });
  return async (message: GroupMessage, signal: AbortSignal) => {
    const stored = await options.store.currentPolicy(message.groupId) ?? await options.store.appendPolicy(message.groupId, {
      mode: "shadow",
      autoActionCategories: ["spam", "scam"],
      minimumAutoActionConfidence: 0.95,
      shadowStartedAt: new Date(),
    });
    const live = options.deletion !== undefined && isLive(stored, liveGroupIds);
    const policy: GroupPolicy = { ...stored, mode: live ? "live" : "shadow" };
    await engine.moderate(message, policy, signal);
  };
}
