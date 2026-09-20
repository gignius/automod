import { RollingWindowLimiter, type ModerationCategory } from "../../core/src/index.ts";
import { strikeWindowDays, type Digest, type ReviewTarget } from "../../store/src/index.ts";
import { terminalSafe } from "../../store/src/terminal-text.ts";
import { isSameAccount } from "./deletion-gate.ts";
import type { GroupActionGate, GroupActionOutcome } from "./group-actions.ts";
import type { DirectMessage } from "./normalize-message.ts";

/*
 * The bot's only outbound conversation: digests of flagged shadow verdicts to
 * the operators, and reply-to-label commands from them. Design and envelope:
 * docs/operator-channel-design.md.
 *
 * More than one person can operate the bot. They share one review queue: each
 * of them is sent the same codes, and whoever replies first acts. A second
 * reply for the same code is not harmful — the member is already gone, so the
 * gate refuses it as "not-member" — and the action log names whoever asked.
 */

export interface OperatorStore {
  prepareDigest(limit: number): Promise<Digest>;
  markDigestSent(codes: readonly string[]): Promise<void>;
  labelByCode(code: string, category: ModerationCategory, labelledAt: Date): Promise<boolean>;
  reviewTarget(code: string): Promise<ReviewTarget | undefined>;
}

export interface OperatorTransport {
  sendText(jid: string, text: string): Promise<void>;
  setComposing(jid: string, composing: boolean): Promise<void>;
  react(chatJid: string, messageId: string, emoji: string): Promise<void>;
}

/** A person allowed to operate the bot: on record in the database AND passed as --operator. */
export interface Operator {
  /** Digits only, with country code. */
  phone: string;
  /** Short name recorded in the action log, so attribution never stores a number. */
  label: string;
}

export interface OperatorChannelOptions {
  /** Everyone who may receive digests and issue commands. Must not be empty. */
  operators: readonly Operator[];
  store: OperatorStore;
  transport: OperatorTransport;
  /** This account's own addresses; digests are never sent to ourselves. */
  ownIds: () => readonly string[];
  /** IANA zone for quiet hours, e.g. "Australia/Sydney". */
  timeZone: string;
  clock?: () => Date;
  /** Uniform in [0, 1); used for the pre-send delay. */
  random?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  /** When set, the operator can also remove, lock, unlock, and approve. */
  actions?: { gate: GroupActionGate; allowedGroupIds: () => readonly string[] };
  /** When set, the operator can view and set each group's natural-language rules. */
  rules?: GroupRulesStore & { allowedGroupIds: () => readonly string[] };
}

export interface GroupRulesStore {
  getRules(groupId: string): Promise<string | undefined>;
  /** Appends a policy version with these rules (undefined clears them); returns the new version. */
  setRules(groupId: string, rules: string | undefined): Promise<number>;
}

export type RulesCommand = { groupSuffix: string } & ({ kind: "show" } | { kind: "clear" } | { kind: "set"; rules: string });

const maximumRulesLength = 2_000;

/** A whole message is a rules command when its first line is `rules NNNN` (optionally `clear`). */
export function parseRulesCommand(text: string): RulesCommand | undefined {
  const [first = "", ...rest] = text.split(/\r?\n/);
  const match = /^rules\s+(\d{4})(\s+clear)?$/i.exec(first.trim());
  if (match === null) return undefined;
  const groupSuffix = match[1]!;
  const body = rest.join("\n").trim();
  if (match[2] !== undefined) return body === "" ? { kind: "clear", groupSuffix } : undefined;
  if (body === "") return { kind: "show", groupSuffix };
  return Buffer.byteLength(body, "utf8") > maximumRulesLength ? undefined : { kind: "set", groupSuffix, rules: body };
}

export interface OperatorChannelCounters {
  digestsSent: number;
  itemsSent: number;
  labelsApplied: number;
  unknownCommands: number;
  ignoredSenders: number;
  refusedSends: number;
  actionsSucceeded: number;
  actionsRefused: number;
  errors: number;
}

export const digestIntervalMilliseconds = 15 * 60_000;
const digestItemLimit = 10;
const digestsPerDay = 20;
const reactionsPerDay = 60;
const actionRepliesPerDay = 20;
const dayMilliseconds = 24 * 60 * 60_000;
const maximumCommandLines = 20;
const itemTextLength = 280;

const labelWords: Record<string, ModerationCategory> = {
  allowed: "allowed", ok: "allowed", spam: "spam", scam: "scam", abuse: "abuse", other: "other",
};

export type GroupCommand =
  | { kind: "remove"; code: string }
  | { kind: "lock" | "unlock" | "approve"; groupSuffix: string };

export interface ParsedCommands {
  labels: { code: string; category: ModerationCategory }[];
  actions: GroupCommand[];
  unknown: number;
}

/**
 * Strict grammar, one command per line: `<code> <label>`, `<code> remove`, or
 * `lock|unlock|approve <last 4 digits of a group ID>`. Anything else is unknown.
 */
export function parseOperatorCommands(text: string): ParsedCommands {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  const result: ParsedCommands = { labels: [], actions: [], unknown: Math.max(0, lines.length - maximumCommandLines) };
  for (const line of lines.slice(0, maximumCommandLines)) {
    const groupCommand = /^(lock|unlock|approve)\s+(\d{4})$/i.exec(line);
    if (groupCommand !== null) {
      result.actions.push({ kind: groupCommand[1]!.toLowerCase() as "lock" | "unlock" | "approve",
        groupSuffix: groupCommand[2]! });
      continue;
    }
    const match = /^#?([2-9A-HJ-NP-Z]{3})\s+([a-z]{2,7})$/i.exec(line);
    if (match !== null && match[2]!.toLowerCase() === "remove") {
      result.actions.push({ kind: "remove", code: match[1]!.toUpperCase() });
      continue;
    }
    const category = match === null ? undefined : labelWords[match[2]!.toLowerCase()];
    if (match === null || category === undefined) {
      result.unknown += 1;
      continue;
    }
    result.labels.push({ code: match[1]!.toUpperCase(), category });
  }
  return result;
}

/** Makes links in member text inert: hxxps://example[.]com cannot be tapped. */
export function defang(text: string): string {
  return text
    .replace(/\bhttp(s?):\/\//gi, "hxxp$1://")
    .replace(/([a-z0-9-])\.(?=[a-z]{2,}\b)/gi, "$1[.]");
}

export function formatDigest(digest: Digest): string {
  const items = digest.items.map((item) => {
    const characters = Array.from(terminalSafe(item.text).replace(/\s+/g, " ").trim());
    const text = defang(characters.length > itemTextLength
      ? `${characters.slice(0, itemTextLength).join("")}…` : characters.join(""));
    const verdict = item.category === null || item.confidence === null ? undefined
      : `${item.category} ${item.confidence.toFixed(2)}`;
    const why = item.deletedByAdmin
      ? `deleted by an admin${verdict === undefined ? "" : ` (model: ${verdict})`}`
      : verdict ?? "flagged";
    // A first offence is not a pattern, so only a repeat is worth the line.
    // Phrased without naming anyone: the digest stays sender-free.
    const strikes = item.strikes.flagged > 1
      ? ` · ${item.strikes.flagged} flagged from this sender in ${strikeWindowDays}d${
        item.strikes.groups > 1 ? `, ${item.strikes.groups} groups` : ""}`
      : "";
    return `*${item.code}* · ${why} · group …${item.groupId.split("@")[0]!.slice(-4)}${strikes}\n${text}`;
  });
  return [
    "Automod shadow digest. Nothing was removed by automod.",
    "Reply with one \"CODE label\" per line (allowed, spam, scam, abuse, other), or \"CODE remove\".",
    "",
    items.join("\n\n"),
    ...(digest.more > 0 ? ["", `+${digest.more} more flagged; they will follow in later digests.`] : []),
  ].join("\n");
}

export function isQuietHour(at: Date, timeZone: string): boolean {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "numeric", hourCycle: "h23" }).format(at));
  return hour >= 23 || hour < 7;
}

export class OperatorChannel {
  readonly counters: OperatorChannelCounters = {
    digestsSent: 0, itemsSent: 0, labelsApplied: 0, unknownCommands: 0, ignoredSenders: 0, refusedSends: 0,
    actionsSucceeded: 0, actionsRefused: 0, errors: 0,
  };
  readonly #operators: readonly (Operator & { jid: string })[];
  readonly #store: OperatorStore;
  readonly #transport: OperatorTransport;
  readonly #ownIds: () => readonly string[];
  readonly #timeZone: string;
  readonly #clock: () => Date;
  readonly #random: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #digests = new RollingWindowLimiter(digestsPerDay, dayMilliseconds);
  readonly #reactions = new RollingWindowLimiter(reactionsPerDay, dayMilliseconds);
  readonly #actionReplies = new RollingWindowLimiter(actionRepliesPerDay, dayMilliseconds);
  readonly #actions: { gate: GroupActionGate; allowedGroupIds: () => readonly string[] } | undefined;
  readonly #rules: (GroupRulesStore & { allowedGroupIds: () => readonly string[] }) | undefined;
  #lastDigestAt = Number.NEGATIVE_INFINITY;
  readonly #pendingNotices: string[] = [];
  #sending = false;

  constructor(options: OperatorChannelOptions) {
    if (options.operators.length === 0) throw new Error("At least one operator is required");
    for (const operator of options.operators) {
      if (!/^[1-9]\d{7,14}$/.test(operator.phone)) throw new Error("Operator phone must be digits with country code");
      if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(operator.label)) throw new Error("Operator label must be lowercase letters, digits or -");
    }
    try {
      new Intl.DateTimeFormat("en-GB", { timeZone: options.timeZone });
    } catch {
      throw new Error("Unknown time zone");
    }
    this.#operators = options.operators.map((operator) =>
      ({ ...operator, jid: `${operator.phone}@s.whatsapp.net` }));
    this.#store = options.store;
    this.#transport = options.transport;
    this.#ownIds = options.ownIds;
    this.#timeZone = options.timeZone;
    this.#clock = options.clock ?? (() => new Date());
    this.#random = options.random ?? Math.random;
    this.#sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#actions = options.actions;
    this.#rules = options.rules;
  }

  /** Which operator sent this, matched on an address WhatsApp itself supplied. */
  operatorFor(message: DirectMessage): (Operator & { jid: string }) | undefined {
    return this.#operators.find((operator) =>
      message.senderAddresses.some((address) => isSameAccount(address, operator.jid)));
  }

  isOperator(message: DirectMessage): boolean {
    return this.operatorFor(message) !== undefined;
  }

  /** Applies label commands from the operator; everyone else is ignored without a reply. */
  async handleDirectMessage(message: DirectMessage): Promise<void> {
    const operator = this.operatorFor(message);
    if (operator === undefined) {
      this.counters.ignoredSenders += 1;
      return;
    }
    const rulesCommand = parseRulesCommand(message.text);
    if (rulesCommand !== undefined) {
      await this.#handleRules(message, rulesCommand);
      return;
    }
    const commands = parseOperatorCommands(message.text);
    this.counters.unknownCommands += commands.unknown;
    let applied = 0;
    try {
      for (const { code, category } of commands.labels) {
        if (await this.#store.labelByCode(code, category, this.#clock())) applied += 1;
        else this.counters.unknownCommands += 1;
      }
    } catch {
      this.counters.errors += 1;
    }
    this.counters.labelsApplied += applied;
    const results: string[] = [];
    for (const command of commands.actions) {
      const result = await this.#runAction(command, operator.label);
      if (result === undefined) this.counters.unknownCommands += 1;
      else results.push(result);
    }
    await this.#react(message, applied > 0 || results.some((line) => line.endsWith(": done")) ? "✅" : "❓");
    if (results.length > 0) await this.#replyToOperator(message.chatJid, results.join("\n"));
  }

  /** Runs one group command; undefined means it could not be resolved (unknown code or group). */
  async #runAction(command: GroupCommand, actor: string): Promise<string | undefined> {
    if (this.#actions === undefined) return undefined;
    const { gate, allowedGroupIds } = this.#actions;
    let outcome: GroupActionOutcome;
    let label: string;
    try {
      if (command.kind === "remove") {
        const target = await this.#store.reviewTarget(command.code);
        if (target === undefined) return undefined;
        label = `${command.code} remove`;
        outcome = await gate.remove(target.groupId, target.senderId,
          { senderId: target.senderId, id: target.messageId }, actor);
      } else {
        const matches = allowedGroupIds().filter((groupId) => groupId.split("@")[0]!.endsWith(command.groupSuffix));
        if (matches.length !== 1) return undefined;
        label = `${command.kind} …${command.groupSuffix}`;
        outcome = command.kind === "approve" ? await gate.approveJoinRequests(matches[0]!, actor)
          : await gate.setLocked(matches[0]!, command.kind === "lock", actor);
      }
    } catch {
      this.counters.errors += 1;
      return undefined;
    }
    if (outcome.status === "succeeded") {
      this.counters.actionsSucceeded += 1;
      return `${label}${outcome.count === undefined ? "" : ` (${outcome.count})`}: done`;
    }
    this.counters.actionsRefused += 1;
    return `${label}: refused (${outcome.refusal})`;
  }

  async #handleRules(message: DirectMessage, command: RulesCommand): Promise<void> {
    const matches = this.#rules?.allowedGroupIds().filter((groupId) =>
      groupId.split("@")[0]!.endsWith(command.groupSuffix)) ?? [];
    if (this.#rules === undefined || matches.length !== 1) {
      this.counters.unknownCommands += 1;
      await this.#react(message, "❓");
      return;
    }
    const groupId = matches[0]!;
    const label = `rules …${command.groupSuffix}`;
    try {
      if (command.kind === "show") {
        const rules = await this.#rules.getRules(groupId);
        await this.#replyToOperator(message.chatJid, rules === undefined ? `${label}: none set` : `${label}:\n${rules}`);
      } else {
        const version = await this.#rules.setRules(groupId, command.kind === "set" ? command.rules : undefined);
        this.counters.actionsSucceeded += 1;
        await this.#react(message, "✅");
        await this.#replyToOperator(message.chatJid,
          `${label}: ${command.kind === "set" ? "saved" : "cleared"} as policy v${version}`);
      }
    } catch {
      this.counters.errors += 1;
      await this.#react(message, "❓");
    }
  }

  /** A one-line notice to every operator (for example, a newly watched group), within the reply cap. */
  async notify(text: string): Promise<void> {
    // Quiet hours hold notices until morning; sendDigest's timer delivers them.
    if (isQuietHour(this.#clock(), this.#timeZone)) {
      if (this.#pendingNotices.length < 20) this.#pendingNotices.push(text);
      return;
    }
    for (const operator of this.#deliverableOperators()) {
      // Same envelope as digests: a composing indicator and a 2-8 s pause first.
      await this.#transport.setComposing(operator.jid, true).catch(() => {});
      await this.#sleep(2_000 + Math.floor(this.#random() * 6_000));
      await this.#replyToOperator(operator.jid, terminalSafe(text));
      await this.#transport.setComposing(operator.jid, false).catch(() => {});
    }
  }

  /** Operators we may message: never this account itself, whichever operator that is. */
  #deliverableOperators(): readonly (Operator & { jid: string })[] {
    const ownIds = this.#ownIds();
    return this.#operators.filter((operator) => {
      if (ownIds.some((id) => isSameAccount(id, operator.jid))) {
        this.counters.refusedSends += 1;
        return false;
      }
      return true;
    });
  }

  async #replyToOperator(chatJid: string, text: string): Promise<void> {
    // Keyed per recipient: one operator's replies must not exhaust another's.
    if (!this.#actionReplies.tryAcquire(`reply:${chatJid}`, this.#clock())) {
      this.counters.refusedSends += 1;
      return;
    }
    try {
      await this.#transport.sendText(chatJid, text);
    } catch {
      this.counters.errors += 1;
    }
  }

  /** Sends one digest (and any notices held over quiet hours) if the envelope allows it; call on a timer. */
  async sendDigest(): Promise<void> {
    const now = this.#clock();
    if (this.#pendingNotices.length > 0 && !isQuietHour(now, this.#timeZone)) {
      await this.notify(this.#pendingNotices.splice(0).join("\n\n"));
    }
    if (this.#sending || now.getTime() - this.#lastDigestAt < digestIntervalMilliseconds ||
      isQuietHour(now, this.#timeZone)) return;
    const recipients = this.#deliverableOperators();
    if (recipients.length === 0) return;
    this.#sending = true;
    try {
      const digest = await this.#store.prepareDigest(digestItemLimit);
      if (digest.items.length === 0) return;
      if (!this.#digests.tryAcquire("digest", now)) {
        this.counters.refusedSends += 1;
        return;
      }
      this.#lastDigestAt = now.getTime();
      const text = formatDigest(digest);
      let delivered = 0;
      for (const operator of recipients) {
        try {
          // Look like a person typing: a composing indicator, then a 2-8 s pause.
          await this.#transport.setComposing(operator.jid, true);
          await this.#sleep(2_000 + Math.floor(this.#random() * 6_000));
          await this.#transport.sendText(operator.jid, text);
          await this.#transport.setComposing(operator.jid, false).catch(() => {});
          delivered += 1;
        } catch {
          // One unreachable operator must not hold the queue for the others.
          this.counters.errors += 1;
        }
      }
      // Marked once the queue has reached someone. An operator whose own send
      // failed will not see these items again — they are a shared queue, and
      // the failure is counted above.
      if (delivered === 0) return;
      await this.#store.markDigestSent(digest.items.map((item) => item.code));
      this.counters.digestsSent += delivered;
      this.counters.itemsSent += digest.items.length;
    } catch {
      // Unsent items stay unsent and are offered again in the next digest.
      this.counters.errors += 1;
    } finally {
      this.#sending = false;
    }
  }

  async #react(message: DirectMessage, emoji: string): Promise<void> {
    if (!this.#reactions.tryAcquire(`reaction:${message.chatJid}`, this.#clock())) {
      this.counters.refusedSends += 1;
      return;
    }
    try {
      await this.#transport.react(message.chatJid, message.id, emoji);
    } catch {
      this.counters.errors += 1;
    }
  }
}
