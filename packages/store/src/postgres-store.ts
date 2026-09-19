import {
  moderationCategories,
  type GroupMessage,
  type GroupPolicy,
  type ModerationCategory,
  type ModerationMode,
  type Verdict,
  type VerdictStore,
} from "../../core/src/index.ts";
import { randomInt } from "node:crypto";
import type { Database, Queryable } from "./database.ts";

/** Member content and identifiers are hard-deleted this many days after receipt. */
export const messageRetentionDays = 30;
const purgeBatchSize = 1_000;

export interface StoredPolicy extends GroupPolicy {
  shadowStartedAt: Date;
}

export type PolicyChange = Omit<StoredPolicy, "groupId" | "version">;

export type MessageKey = Pick<GroupMessage, "groupId" | "senderId" | "id">;

/** A pending message leased to this worker. */
export interface InboxMessage {
  rowId: string;
  message: GroupMessage;
  /** Including this one. */
  attempts: number;
}

/** What the inbox processor needs; implemented by PostgresStore. */
export interface Inbox {
  /** Leases the oldest pending message of up to `limit` groups, at most one per group. */
  claim(limit: number, leaseSeconds: number): Promise<InboxMessage[]>;
  complete(rowId: string): Promise<void>;
  /** Schedules a retry with backoff, or dead-letters once `maximumAttempts` is reached. */
  fail(rowId: string, maximumAttempts: number): Promise<"retrying" | "dead">;
}

interface InboxRow {
  id: string;
  group_jid: string;
  sender_jid: string;
  message_id: string;
  text: string;
  received_at: Date;
  attempts: number;
}

export interface EvalExampleRecord {
  id: string;
  groupId: string;
  text: string;
  expectedCategory: ModerationCategory;
}

/** A stored message awaiting the operator's label, with its shadow verdict if any. */
export interface LabelCandidate {
  message: GroupMessage;
  verdict: { category: ModerationCategory; confidence: number } | undefined;
}

/** One flagged message prepared for the operator's digest. */
export interface DigestItem {
  code: string;
  groupId: string;
  text: string;
  category: ModerationCategory;
  confidence: number;
}

export interface Digest {
  items: DigestItem[];
  /** Flagged, unreviewed messages that did not fit in this digest. */
  more: number;
}

const codeAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const reviewCodeDays = 7;
const digestLookbackHours = 24;

function reviewCode(): string {
  return Array.from({ length: 3 }, () => codeAlphabet[randomInt(codeAlphabet.length)]).join("");
}

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

function assertRowId(id: string): string {
  if (!/^[1-9]\d{0,18}$/.test(id)) throw new RangeError("Invalid row ID");
  return id;
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
export class PostgresStore implements VerdictStore, Inbox {
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

  /**
   * Records a verdict for a stored message; the message must have been saved
   * first. The first verdict wins: the inbox delivers at least once, so a
   * message re-handled after a crash must not fail on its earlier verdict.
   */
  async save(verdict: Verdict): Promise<void> {
    assertValidDate(verdict.decidedAt, "decidedAt");
    const { rows } = await this.#database.query<{ stored: boolean }>(
      `WITH target AS (${messageRowIdSql}),
       inserted AS (
         INSERT INTO verdicts
           (message_row_id, group_jid, policy_version, category, confidence, reason, outcome, decided_at)
         SELECT id::bigint, $1, $4, $5, $6, $7, $8, $9 FROM target
         ON CONFLICT (message_row_id) WHERE message_row_id IS NOT NULL DO NOTHING
         RETURNING id
       )
       SELECT EXISTS (SELECT 1 FROM target) AS stored`,
      [verdict.groupId, verdict.senderId, verdict.messageId, verdict.policyVersion, verdict.category,
        verdict.confidence, verdict.reason, verdict.outcome, verdict.decidedAt]);
    if (rows[0]?.stored !== true) throw new Error("Verdict refers to a message that is not stored");
  }

  async claim(limit: number, leaseSeconds: number): Promise<InboxMessage[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
      !Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3_600) {
      throw new RangeError("Claim limit and lease must be small positive integers");
    }
    // Only a group's head is eligible, so each group is handled in order; a
    // leased or backing-off head holds its group without stalling the others.
    // The outer UPDATE re-checks the lease under the row lock, so two workers
    // racing for the same head cannot both win.
    const { rows } = await this.#database.query<InboxRow>(
      `WITH heads AS (
         SELECT DISTINCT ON (group_jid) id, lease_until, next_attempt_at, received_at
         FROM messages
         WHERE processed_at IS NULL AND dead_at IS NULL
         ORDER BY group_jid, received_at, id
       ), claimable AS (
         SELECT id FROM heads
         WHERE (lease_until IS NULL OR lease_until <= now())
           AND (next_attempt_at IS NULL OR next_attempt_at <= now())
         ORDER BY received_at, id
         LIMIT $1
       )
       UPDATE messages AS m
       SET lease_until = now() + make_interval(secs => $2), attempts = m.attempts + 1
       FROM claimable
       WHERE m.id = claimable.id AND m.processed_at IS NULL AND m.dead_at IS NULL
         AND (m.lease_until IS NULL OR m.lease_until <= now())
       RETURNING m.id::text AS id, m.group_jid, m.sender_jid, m.message_id, m.text, m.received_at, m.attempts`,
      [limit, leaseSeconds]);
    return rows
      .sort((left, right) => new Date(left.received_at).getTime() - new Date(right.received_at).getTime())
      .map((row) => ({
        rowId: row.id,
        attempts: row.attempts,
        message: {
          id: row.message_id,
          groupId: row.group_jid,
          senderId: row.sender_jid,
          text: row.text,
          receivedAt: new Date(row.received_at),
        },
      }));
  }

  async complete(rowId: string): Promise<void> {
    await this.#database.query(
      "UPDATE messages SET processed_at = now(), lease_until = NULL WHERE id = $1::bigint AND processed_at IS NULL",
      [assertRowId(rowId)]);
  }

  async fail(rowId: string, maximumAttempts: number): Promise<"retrying" | "dead"> {
    if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1) {
      throw new RangeError("maximumAttempts must be a positive integer");
    }
    // Backoff doubles per attempt from 2 s, capped at 5 minutes.
    const { rows } = await this.#database.query<{ dead: boolean }>(
      `UPDATE messages SET
         lease_until = NULL,
         next_attempt_at = now() + make_interval(secs => LEAST(300, power(2, LEAST(attempts, 9)))),
         dead_at = CASE WHEN attempts >= $2 THEN now() END
       WHERE id = $1::bigint AND processed_at IS NULL
       RETURNING dead_at IS NOT NULL AS dead`,
      [assertRowId(rowId), maximumAttempts]);
    return rows[0]?.dead === true ? "dead" : "retrying";
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

  async listEvalExamples(): Promise<EvalExampleRecord[]> {
    const { rows } = await this.#database.query<{ id: string; group_jid: string; text: string;
      expected_category: ModerationCategory }>(
      "SELECT id::text AS id, group_jid, text, expected_category FROM eval_examples ORDER BY id");
    return rows.map((row) => ({
      id: row.id, groupId: row.group_jid, text: row.text, expectedCategory: row.expected_category,
    }));
  }

  /**
   * Unlabelled messages for the labelling tool. Messages the classifier flagged
   * come first so the rare categories fill in quickly; then newest first.
   */
  async labelCandidates(limit: number): Promise<LabelCandidate[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RangeError("Invalid limit");
    const { rows } = await this.#database.query<InboxRow & { category: ModerationCategory | null;
      confidence: number | null }>(
      `SELECT m.id::text AS id, m.group_jid, m.sender_jid, m.message_id, m.text, m.received_at, m.attempts,
              v.category, v.confidence
       FROM messages m
       LEFT JOIN feedback_labels l ON l.message_row_id = m.id
       LEFT JOIN verdicts v ON v.message_row_id = m.id
       WHERE l.message_row_id IS NULL
       ORDER BY (v.category IS NOT NULL AND v.category <> 'allowed') DESC, m.received_at DESC
       LIMIT $1`, [limit]);
    return rows.map((row) => ({
      message: {
        id: row.message_id, groupId: row.group_jid, senderId: row.sender_jid, text: row.text,
        receivedAt: new Date(row.received_at),
      },
      verdict: row.category === null || row.confidence === null ? undefined
        : { category: row.category, confidence: row.confidence },
    }));
  }

  /**
   * Collects up to `limit` flagged, unlabelled messages from the last day for
   * the operator, assigning each a fresh review code. Items prepared earlier
   * but never sent are offered again first. Call `markDigestSent` after delivery.
   */
  async prepareDigest(limit: number): Promise<Digest> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new RangeError("Invalid digest limit");
    return this.#database.transaction(async (transaction) => {
      const flagged = `FROM messages m
        JOIN verdicts v ON v.message_row_id = m.id AND v.category <> 'allowed'
        LEFT JOIN feedback_labels l ON l.message_row_id = m.id
        LEFT JOIN review_items r ON r.message_row_id = m.id
        WHERE l.message_row_id IS NULL AND m.received_at > now() - make_interval(hours => $1)
          AND (r.message_row_id IS NULL OR r.sent_at IS NULL)`;
      const { rows } = await transaction.query<{ id: string; code: string | null }>(
        `SELECT m.id::text AS id, r.code ${flagged}
         ORDER BY (r.code IS NOT NULL) DESC, m.received_at LIMIT $2 FOR UPDATE OF m`,
        [digestLookbackHours, limit]);
      const { rows: [total] } = await transaction.query<{ count: number }>(
        `SELECT count(*)::int AS count ${flagged}`, [digestLookbackHours]);
      const codes: string[] = [];
      for (const row of rows) {
        if (row.code !== null) {
          codes.push(row.code);
          continue;
        }
        for (let attempt = 0; ; attempt += 1) {
          if (attempt === 20) throw new Error("Could not allocate a unique review code");
          const { rows: inserted } = await transaction.query<{ code: string }>(
            `INSERT INTO review_items (code, message_row_id) VALUES ($1, $2::bigint)
             ON CONFLICT (code) DO NOTHING RETURNING code`, [reviewCode(), row.id]);
          if (inserted[0] !== undefined) {
            codes.push(inserted[0].code);
            break;
          }
        }
      }
      const { rows: items } = await transaction.query<{ code: string; group_jid: string; text: string;
        category: ModerationCategory; confidence: number }>(
        `SELECT r.code, m.group_jid, m.text, v.category, v.confidence
         FROM review_items r JOIN messages m ON m.id = r.message_row_id
         JOIN verdicts v ON v.message_row_id = m.id
         WHERE r.code = ANY($1::text[]) ORDER BY m.received_at`, [codes]);
      return {
        items: items.map((item) => ({ code: item.code, groupId: item.group_jid, text: item.text,
          category: item.category, confidence: item.confidence })),
        more: Math.max(0, (total?.count ?? 0) - items.length),
      };
    });
  }

  async markDigestSent(codes: readonly string[]): Promise<void> {
    await this.#database.query("UPDATE review_items SET sent_at = now() WHERE code = ANY($1::text[]) AND sent_at IS NULL",
      [[...codes]]);
  }

  /**
   * Applies the operator's label to a message they were sent. Only codes that
   * were delivered in the last 7 days resolve; relabelling overwrites.
   */
  async labelByCode(code: string, category: ModerationCategory, labelledAt: Date): Promise<boolean> {
    if (!/^[2-9A-HJ-NP-Z]{3}$/.test(code)) return false;
    const { rows } = await this.#database.query<{ group_jid: string; sender_jid: string; message_id: string }>(
      `SELECT m.group_jid, m.sender_jid, m.message_id FROM review_items r JOIN messages m ON m.id = r.message_row_id
       WHERE r.code = $1 AND r.sent_at IS NOT NULL AND r.sent_at > now() - make_interval(days => $2)`,
      [code, reviewCodeDays]);
    const row = rows[0];
    if (row === undefined) return false;
    await this.labelMessage({ groupId: row.group_jid, senderId: row.sender_jid, id: row.message_id }, category,
      labelledAt, { keepForEval: true });
    await this.#database.query("UPDATE review_items SET labelled_at = $2 WHERE code = $1", [code, labelledAt]);
    return true;
  }

  async deleteEvalExample(id: string): Promise<boolean> {
    const { rows } = await this.#database.query<{ id: string }>(
      "DELETE FROM eval_examples WHERE id = $1::bigint RETURNING id::text AS id", [assertRowId(id)]);
    return rows.length === 1;
  }

  /**
   * Hard-deletes messages past retention, in bounded batches. The cutoff comes
   * from the database clock and a fixed constant; nothing the caller passes can
   * widen deletion to fresh data.
   */
  async purgeExpired(): Promise<PurgeResult> {
    await this.#database.query(
      "DELETE FROM review_items WHERE COALESCE(sent_at, created_at) < now() - make_interval(days => $1)",
      [reviewCodeDays]);
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
