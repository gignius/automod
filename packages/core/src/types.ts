export type ModerationCategory = "allowed" | "spam" | "scam" | "abuse" | "other";

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
  mode: ModerationMode;
  autoActionCategories: readonly ModerationCategory[];
  minimumAutoActionConfidence: number;
}

export interface Classification {
  category: ModerationCategory;
  confidence: number;
  reason: string;
}

export interface Verdict extends Classification {
  messageId: string;
  groupId: string;
  decidedAt: Date;
  outcome: "allowed" | "shadowed" | "deleted" | "delete-failed" | "rate-limited";
}

export interface Classifier {
  classify(message: GroupMessage, policy: GroupPolicy): Promise<Classification>;
}

export interface VerdictStore {
  save(verdict: Verdict): Promise<void>;
}

export interface WhatsAppAdapter {
  deleteMessage(message: GroupMessage): Promise<void>;
}

