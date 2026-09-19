export const moderationCategories = ["allowed", "spam", "scam", "abuse", "other"] as const;
export type ModerationCategory = (typeof moderationCategories)[number];

export type ModerationMode = "shadow" | "live";

export interface GroupMessage {
  id: string;
  groupId: string;
  senderId: string;
  text: string;
  receivedAt: Date;
}

export interface GroupPolicy {
  groupId: string;
  /** Increments with every change so verdicts can name the policy that produced them. */
  version: number;
  mode: ModerationMode;
  autoActionCategories: readonly ModerationCategory[];
  minimumAutoActionConfidence: number;
  /** Admin-written group rules, given to the classifier as context. */
  rules?: string | undefined;
}

export interface Classification {
  category: ModerationCategory;
  confidence: number;
  reason: string;
}

export const verdictOutcomes = ["allowed", "shadowed", "deleted", "delete-failed", "rate-limited"] as const;
export type VerdictOutcome = (typeof verdictOutcomes)[number];

export interface Verdict extends Classification {
  messageId: string;
  groupId: string;
  senderId: string;
  policyVersion: number;
  decidedAt: Date;
  outcome: VerdictOutcome;
}

export interface Classifier {
  /** The signal fires when the caller stops waiting (timeout or shutdown). */
  classify(message: GroupMessage, policy: GroupPolicy, signal?: AbortSignal): Promise<Classification>;
}

export interface VerdictStore {
  save(verdict: Verdict): Promise<void>;
}

export interface WhatsAppAdapter {
  deleteMessage(message: GroupMessage): Promise<void>;
}

