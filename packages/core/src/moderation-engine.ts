import type {
  Classifier,
  GroupMessage,
  GroupPolicy,
  Verdict,
  VerdictStore,
  WhatsAppAdapter,
} from "./types.ts";
import { RollingWindowLimiter } from "./rolling-window-limiter.ts";

export interface ModerationEngineDependencies {
  classifier: Classifier;
  verdictStore: VerdictStore;
  whatsApp: WhatsAppAdapter;
  clock?: () => Date;
  deletionLimiter?: RollingWindowLimiter;
}

export class ModerationEngine {
  readonly #classifier: Classifier;
  readonly #verdictStore: VerdictStore;
  readonly #whatsApp: WhatsAppAdapter;
  readonly #clock: () => Date;
  readonly #deletionLimiter: RollingWindowLimiter;

  constructor(dependencies: ModerationEngineDependencies) {
    this.#classifier = dependencies.classifier;
    this.#verdictStore = dependencies.verdictStore;
    this.#whatsApp = dependencies.whatsApp;
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#deletionLimiter =
      dependencies.deletionLimiter ?? new RollingWindowLimiter(5, 60_000);
  }

  async moderate(message: GroupMessage, policy: GroupPolicy): Promise<Verdict> {
    if (message.groupId !== policy.groupId) {
      throw new Error("Message and policy group IDs must match");
    }

    const classification = await this.#classifier.classify(message, policy);
    this.#validateConfidence(classification.confidence);
    const decidedAt = this.#clock();
    let outcome: Verdict["outcome"] = "allowed";

    const categoryIsActionable = policy.autoActionCategories.includes(
      classification.category,
    );
    const confidenceIsSufficient =
      classification.confidence >= policy.minimumAutoActionConfidence;

    if (categoryIsActionable && confidenceIsSufficient) {
      if (policy.mode === "shadow") {
        outcome = "shadowed";
      } else if (this.#deletionLimiter.tryAcquire(message.groupId, decidedAt)) {
        try {
          await this.#whatsApp.deleteMessage(message);
          outcome = "deleted";
        } catch {
          // Adapters refuse unsafe deletions by throwing; keep the verdict either way.
          outcome = "delete-failed";
        }
      } else {
        outcome = "rate-limited";
      }
    }

    const verdict: Verdict = {
      ...classification,
      messageId: message.id,
      groupId: message.groupId,
      senderId: message.senderId,
      policyVersion: policy.version,
      decidedAt,
      outcome,
    };
    await this.#verdictStore.save(verdict);
    return verdict;
  }

  #validateConfidence(confidence: number): void {
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new RangeError("Classification confidence must be between 0 and 1");
    }
  }
}

