import {
  moderationCategories,
  type GroupMessage,
  type GroupPolicy,
  type ModerationCategory,
  type ModerationMode,
  type Verdict,
  type VerdictStore,
} from "../../core/src/index.ts";
import type { Database, Queryable } from "./database.ts";

/** Member content and identifiers are hard-deleted this many days after receipt. */
export const messageRetentionDays = 30;
const purgeBatchSize = 1_000;

export interface StoredPolicy extends GroupPolicy {
  shadowStartedAt: Date;
}

export type PolicyChange = Omit<StoredPolicy, "groupId" | "version">;

export type MessageKey = Pick<GroupMessage, "groupId" | "senderId" | "id">;

export interface PurgeResult {
  messages: number;
}

export interface ErasureResult {
  messages: number;
  evalExamples: number;
}

interface PolicyRow {
  group_jid: string;
  version: number;
  mode: ModerationMode;
  auto_action_categories: ModerationCategory[];
  minimum_auto_action_confidence: number;
  shadow_started_at: Date;
}

function assertValidDate(value: Date, name: string): void {
  if (!Number.isFinite(value.getTime())) throw new RangeError(`${name} must be a valid date`);
}

function isCategory(value: unknown): value is ModerationCategory {
  return moderationCategories.includes(value as ModerationCategory);
}

const messageRowIdSql = "SELECT id::text AS id FROM messages WHERE group_jid = $1 AND sender_jid = $2 AND message_id = $3";

/**
 * Postgres persistence for the moderation loop. Every statement is static SQL
 * with bound parameters; the schema's CHECK constraints are the last line of
 * validation behind the checks here.
 */
export class PostgresStore implements VerdictStore {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  /** Stores an observed message; returns false when it was already stored (redelivery). */
  async saveMessage(message: GroupMessage): Promise<boolean> {
    assertValidDate(message.receivedAt, "receivedAt");
    const { rows } = await this.#database.query<{ id: string }>(
      `INSERT INTO messages (group_jid, sender_jid, message_id, text, received_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (group_jid, sender_jid, message_id) DO NOTHING
       RETURNING id::text AS id`,
      [message.groupId, message.senderId, message.id, message.text, message.receivedAt]);
    return rows.length === 1;
  }

  /** Records a verdict for a stored message; the message must have been saved first. */
  async save(verdict: Verdict): Promise<void> {
    assertValidDate(verdict.decidedAt, "decidedAt");
    const { rows } = await this.#database.query<{ id: string }>(
      `INSERT INTO verdicts (message_row_id, group_jid, policy_version, category, confidence, reason, outcome, decided_at)
       SELECT id, group_jid, $4, $5, $6, $7, $8, $9 FROM messages
       WHERE group_jid = $1 AND sender_jid = $2 AND message_id = $3
       RETURNING id::text AS id`,
      [verdict.groupId, verdict.senderId, verdict.messageId, verdict.policyVersion, verdict.category,
        verdict.confidence, verdict.reason, verdict.outcome, verdict.decidedAt]);
    if (rows.length !== 1) throw new Error("Verdict refers to a message that is not stored");
  }

  /** Appends a new policy version; earlier versions are never modified. */
  async appendPolicy(groupId: string, change: PolicyChange): Promise<StoredPolicy> {
    assertValidDate(change.shadowStartedAt, "shadowStartedAt");
    return this.#database.transaction(async (transaction) => {
      // Serializes concurrent appends for one group so versions stay dense.
      await transaction.query("SELECT pg_advisory_xact_lock(hashtext($1))", [groupId]);
      const { rows } = await transaction.query<PolicyRow>(
        `INSERT INTO group_policies
           (group_jid, version, mode, auto_action_categories, minimum_auto_action_confidence, shadow_started_at)
         SELECT $1, COALESCE(MAX(version), 0) + 1, $2, $3, $4, $5 FROM group_policies WHERE group_jid = $1
         RETURNING group_jid, version, mode, auto_action_categories, minimum_auto_action_confidence, shadow_started_at`,
        [groupId, change.mode, [...change.autoActionCategories], change.minimumAutoActionConfidence,
          change.shadowStartedAt]);
      return this.#toPolicy(rows[0]!);
    });
  }

  async currentPolicy(groupId: string): Promise<StoredPolicy | undefined> {
    const { rows } = await this.#database.query<PolicyRow>(
      `SELECT group_jid, version, mode, auto_action_categories, minimum_auto_action_confidence, shadow_started_at
       FROM group_policies WHERE group_jid = $1 ORDER BY version DESC LIMIT 1`, [groupId]);
    return rows[0] === undefined ? undefined : this.#toPolicy(rows[0]);
  }

  /**
   * Records the admin's expected category for a stored message. With
   * `keepForEval`, also copies the text (without the sender) into the eval set,
   * which outlives the 30-day message retention.
   */
  async labelMessage(key: MessageKey, expectedCategory: ModerationCategory, labelledAt: Date,
    options: { keepForEval: boolean }): Promise<void> {
    if (!isCategory(expectedCategory)) throw new RangeError("Unknown category");
    assertValidDate(labelledAt, "labelledAt");
    await this.#database.transaction(async (transaction) => {
      const { rows } = await transaction.query<{ id: string }>(`${messageRowIdSql} FOR UPDATE`,
        [key.groupId, key.senderId, key.id]);
      const messageRowId = rows[0]?.id;
      if (messageRowId === undefined) throw new Error("Label refers to a message that is not stored");
      await transaction.query(
        `INSERT INTO feedback_labels (message_row_id, expected_category, labelled_at) VALUES ($1, $2, $3)
         ON CONFLICT (message_row_id) DO UPDATE
           SET expected_category = EXCLUDED.expected_category, labelled_at = EXCLUDED.labelled_at`,
        [messageRowId, expectedCategory, labelledAt]);
      if (options.keepForEval) {
        await transaction.query(
          `INSERT INTO eval_examples (source_message_row_id, group_jid, text, expected_category, labelled_at)
           SELECT id, group_jid, text, $2, $3 FROM messages WHERE id = $1
           ON CONFLICT (source_message_row_id) DO UPDATE
             SET expected_category = EXCLUDED.expected_category, labelled_at = EXCLUDED.labelled_at`,
          [messageRowId, expectedCategory, labelledAt]);
      } else {
        await transaction.query("DELETE FROM eval_examples WHERE source_message_row_id = $1", [messageRowId]);
      }
    });
  }

  async deleteEvalExample(id: string): Promise<boolean> {
    if (!/^[1-9]\d{0,18}$/.test(id)) throw new RangeError("Invalid eval example ID");
    const { rows } = await this.#database.query<{ id: string }>(
      "DELETE FROM eval_examples WHERE id = $1::bigint RETURNING id::text AS id", [id]);
    return rows.length === 1;
  }

  /**
   * Hard-deletes messages past retention, in bounded batches. The cutoff comes
   * from the database clock and a fixed constant; nothing the caller passes can
   * widen deletion to fresh data.
   */
  async purgeExpired(): Promise<PurgeResult> {
    let messages = 0;
    for (;;) {
      const deleted = await this.#database.transaction(async (transaction) => {
        const { rows } = await transaction.query<{ id: string }>(
          `SELECT id::text AS id FROM messages
           WHERE received_at < now() - make_interval(days => $1)
           ORDER BY received_at LIMIT $2 FOR UPDATE`,
          [messageRetentionDays, purgeBatchSize]);
        return this.#deleteMessages(transaction, rows.map((row) => row.id));
      });
      messages += deleted;
      if (deleted < purgeBatchSize) return { messages };
    }
  }

  /** Erases one member's content everywhere it is still linked, in one transaction. */
  async eraseSender(senderId: string): Promise<ErasureResult> {
    return this.#database.transaction(async (transaction) => {
      const { rows } = await transaction.query<{ id: string }>(
        `DELETE FROM eval_examples WHERE source_message_row_id IN
           (SELECT id FROM messages WHERE sender_jid = $1)
         RETURNING id::text AS id`, [senderId]);
      const { rows: doomed } = await transaction.query<{ id: string }>(
        "SELECT id::text AS id FROM messages WHERE sender_jid = $1 FOR UPDATE", [senderId]);
      const messages = await this.#deleteMessages(transaction, doomed.map((row) => row.id));
      return { messages, evalExamples: rows.length };
    });
  }

  /** Deletes messages and scrubs verdict reasons that may quote them. */
  async #deleteMessages(transaction: Queryable, ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    await transaction.query(
      "UPDATE verdicts SET reason = NULL, message_row_id = NULL WHERE message_row_id = ANY($1::bigint[])", [ids]);
    const { rows } = await transaction.query<{ id: string }>(
      "DELETE FROM messages WHERE id = ANY($1::bigint[]) RETURNING id::text AS id", [ids]);
    return rows.length;
  }

  #toPolicy(row: PolicyRow): StoredPolicy {
    return {
      groupId: row.group_jid,
      version: row.version,
      mode: row.mode,
      autoActionCategories: row.auto_action_categories,
      minimumAutoActionConfidence: row.minimum_auto_action_confidence,
      shadowStartedAt: new Date(row.shadow_started_at),
    };
  }
}
