import { RollingWindowLimiter, type ModerationCategory } from "../../core/src/index.ts";
import type { Digest } from "../../store/src/index.ts";
import { terminalSafe } from "../../store/src/terminal-text.ts";
import { isSameAccount } from "./deletion-gate.ts";
import type { DirectMessage } from "./normalize-message.ts";

/*
 * The bot's only outbound conversation: digests of flagged shadow verdicts to
 * one operator, and reply-to-label commands from that operator. Design and
 * envelope: docs/operator-channel-design.md.
 */

export interface OperatorStore {
  prepareDigest(limit: number): Promise<Digest>;
  markDigestSent(codes: readonly string[]): Promise<void>;
  labelByCode(code: string, category: ModerationCategory, labelledAt: Date): Promise<boolean>;
}

export interface OperatorTransport {
  sendText(jid: string, text: string): Promise<void>;
  setComposing(jid: string, composing: boolean): Promise<void>;
  react(chatJid: string, messageId: string, emoji: string): Promise<void>;
}

export interface OperatorChannelOptions {
  /** Digits only, with country code. */
  operatorPhone: string;
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
}

export interface OperatorChannelCounters {
  digestsSent: number;
  itemsSent: number;
  labelsApplied: number;
  unknownCommands: number;
  ignoredSenders: number;
  refusedSends: number;
  errors: number;
}

export const digestIntervalMilliseconds = 15 * 60_000;
const digestItemLimit = 10;
const digestsPerDay = 20;
const reactionsPerDay = 60;
const dayMilliseconds = 24 * 60 * 60_000;
const maximumCommandLines = 20;
const itemTextLength = 280;

const labelWords: Record<string, ModerationCategory> = {
  allowed: "allowed", ok: "allowed", spam: "spam", scam: "scam", abuse: "abuse", other: "other",
};

export interface ParsedCommands {
  labels: { code: string; category: ModerationCategory }[];
  unknown: number;
}

/** Strict grammar: one `<code> <label>` per line; anything else counts as unknown. */
export function parseOperatorCommands(text: string): ParsedCommands {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  const result: ParsedCommands = { labels: [], unknown: Math.max(0, lines.length - maximumCommandLines) };
  for (const line of lines.slice(0, maximumCommandLines)) {
    const match = /^#?([2-9A-HJ-NP-Z]{3})\s+([a-z]{2,7})$/i.exec(line);
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
    return `*${item.code}* · ${item.category} ${item.confidence.toFixed(2)} · group …${item.groupId.split("@")[0]!.slice(-4)}\n${text}`;
  });
  return [
    "Automod shadow digest. Nothing was removed.",
    "Reply with one \"CODE label\" per line (allowed, spam, scam, abuse, other).",
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
    digestsSent: 0, itemsSent: 0, labelsApplied: 0, unknownCommands: 0, ignoredSenders: 0, refusedSends: 0, errors: 0,
  };
  readonly #operatorJid: string;
  readonly #store: OperatorStore;
  readonly #transport: OperatorTransport;
  readonly #ownIds: () => readonly string[];
  readonly #timeZone: string;
  readonly #clock: () => Date;
  readonly #random: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #digests = new RollingWindowLimiter(digestsPerDay, dayMilliseconds);
  readonly #reactions = new RollingWindowLimiter(reactionsPerDay, dayMilliseconds);
  #lastDigestAt = Number.NEGATIVE_INFINITY;
  #sending = false;

  constructor(options: OperatorChannelOptions) {
    if (!/^[1-9]\d{7,14}$/.test(options.operatorPhone)) throw new Error("Operator phone must be digits with country code");
    try {
      new Intl.DateTimeFormat("en-GB", { timeZone: options.timeZone });
    } catch {
      throw new Error("Unknown time zone");
    }
    this.#operatorJid = `${options.operatorPhone}@s.whatsapp.net`;
    this.#store = options.store;
    this.#transport = options.transport;
    this.#ownIds = options.ownIds;
    this.#timeZone = options.timeZone;
    this.#clock = options.clock ?? (() => new Date());
    this.#random = options.random ?? Math.random;
    this.#sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  /** The sender must be the operator by an address WhatsApp itself supplied. */
  isOperator(message: DirectMessage): boolean {
    return message.senderAddresses.some((address) => isSameAccount(address, this.#operatorJid));
  }

  /** Applies label commands from the operator; everyone else is ignored without a reply. */
  async handleDirectMessage(message: DirectMessage): Promise<void> {
    if (!this.isOperator(message)) {
      this.counters.ignoredSenders += 1;
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
    await this.#react(message, applied > 0 ? "✅" : "❓");
  }

  /** Sends one digest if the envelope allows it; call on a timer. */
  async sendDigest(): Promise<void> {
    const now = this.#clock();
    if (this.#sending || now.getTime() - this.#lastDigestAt < digestIntervalMilliseconds ||
      isQuietHour(now, this.#timeZone)) return;
    if (this.#ownIds().some((id) => isSameAccount(id, this.#operatorJid))) {
      this.counters.refusedSends += 1;
      return;
    }
    this.#sending = true;
    try {
      const digest = await this.#store.prepareDigest(digestItemLimit);
      if (digest.items.length === 0) return;
      if (!this.#digests.tryAcquire("digest", now)) {
        this.counters.refusedSends += 1;
        return;
      }
      this.#lastDigestAt = now.getTime();
      // Look like a person typing: a composing indicator, then a 2-8 s pause.
      await this.#transport.setComposing(this.#operatorJid, true);
      await this.#sleep(2_000 + Math.floor(this.#random() * 6_000));
      await this.#transport.sendText(this.#operatorJid, formatDigest(digest));
      await this.#transport.setComposing(this.#operatorJid, false).catch(() => {});
      await this.#store.markDigestSent(digest.items.map((item) => item.code));
      this.counters.digestsSent += 1;
      this.counters.itemsSent += digest.items.length;
    } catch {
      // Unsent items stay unsent and are offered again in the next digest.
      this.counters.errors += 1;
    } finally {
      this.#sending = false;
    }
  }

  async #react(message: DirectMessage, emoji: string): Promise<void> {
    if (!this.#reactions.tryAcquire("reaction", this.#clock())) {
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
