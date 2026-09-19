import { ModerationEngine, type Classifier, type GroupMessage, type GroupPolicy } from "../../core/src/index.ts";
import type { PostgresStore } from "../../store/src/index.ts";

/**
 * The observer's moderation loop. It is shadow-only by construction: the
 * stored policy's mode is overridden, and the WhatsApp adapter refuses every
 * deletion, so neither a tampered policy row nor a bug can remove a message.
 */
export function shadowModeration(store: PostgresStore, classifier: Classifier) {
  const engine = new ModerationEngine({
    classifier,
    verdictStore: store,
    whatsApp: { deleteMessage: async () => { throw new Error("The observer has no deletion path"); } },
  });
  return async (message: GroupMessage, signal: AbortSignal) => {
    const stored = await store.currentPolicy(message.groupId) ?? await store.appendPolicy(message.groupId, {
      mode: "shadow",
      autoActionCategories: ["spam", "scam"],
      minimumAutoActionConfidence: 0.95,
      shadowStartedAt: new Date(),
    });
    const policy: GroupPolicy = { ...stored, mode: "shadow" };
    await engine.moderate(message, policy, signal);
  };
}
