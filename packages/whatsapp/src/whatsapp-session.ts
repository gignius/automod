import { setTimeout as sleepFor } from "node:timers/promises";
import makeWASocket, {
  DisconnectReason,
  type AuthenticationCreds,
  type AuthenticationState,
  type BaileysEventMap,
  type ConnectionState,
  type GroupMetadata,
  type UserFacingSocketConfig,
  type WASocket,
} from "@whiskeysockets/baileys";
import pino from "pino";
import type { GroupMessage } from "../../core/src/types.ts";
import type { DeletionTransport } from "./deletion-gate.ts";
import { isGroupId, normalizeMessage } from "./normalize-message.ts";
import { RecentMessageCache, type ObservedMessageKey } from "./recent-message-cache.ts";

export type SessionSocket = Pick<WASocket, "ev" | "requestPairingCode" | "groupMetadata" | "sendMessage" | "end">;
export type SocketFactory = (config: UserFacingSocketConfig) => SessionSocket;

export interface SessionAuthStore {
  readonly state: AuthenticationState;
  /** Settles only if a credential or key write fails; the session then stops. */
  readonly failed: Promise<void>;
  saveCreds(update?: Partial<AuthenticationCreds>): Promise<void>;
}

export interface PairingHandler {
  /** Digits only, including the country code. */
  phoneNumber(): Promise<string>;
  /** The only place a pairing code is ever delivered. */
  showCode(code: string): void;
}

export type SessionStopReason =
  | "requested"
  | "logged-out"
  | "connection-replaced"
  | "forbidden"
  | "multidevice-mismatch"
  | "pairing-unavailable"
  | "pairing-failed"
  | "pairing-expired"
  | "reconnect-exhausted"
  | "persistence-failed"
  | "overloaded";

/** Status events carry no message content, identifiers, or secrets. */
export type SessionEvent =
  | { type: "connecting" }
  | { type: "pairing-code-issued" }
  | { type: "open" }
  | { type: "reconnecting"; attempt: number; delayMilliseconds: number }
  | { type: "stopped"; reason: SessionStopReason };

export interface SessionCounters {
  accepted: number;
  duplicates: number;
  ignored: number;
  handled: number;
  handlerErrors: number;
}

export interface WhatsAppSessionOptions {
  auth: SessionAuthStore;
  allowedGroupIds: Iterable<string>;
  onMessage(message: GroupMessage): Promise<void>;
  onEvent?(event: SessionEvent): void;
  pairing?: PairingHandler;
  socketFactory?: SocketFactory;
  recentMessages?: RecentMessageCache;
  clock?: () => Date;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<unknown>;
  maximumQueuedMessages?: number;
  maximumReconnectAttempts?: number;
}

const phoneNumberPattern = /^[1-9]\d{7,14}$/;
const maximumReconnectDelayMilliseconds = 60_000;
const silentLogger = pino({ level: "silent" });

function statusCodeOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("output" in error)) return undefined;
  const output = error.output;
  if (typeof output !== "object" || output === null || !("statusCode" in output)) return undefined;
  return typeof output.statusCode === "number" ? output.statusCode : undefined;
}

/**
 * One linked WhatsApp account. Owns the socket lifecycle, turns live group
 * traffic into bounded, ordered, de-duplicated handler calls, and exposes the
 * minimal transport the deletion gate needs. It never opens or closes the
 * credential store; whoever opened it closes it after `start()` settles.
 */
export class WhatsAppSession implements DeletionTransport {
  readonly counters: SessionCounters = { accepted: 0, duplicates: 0, ignored: 0, handled: 0, handlerErrors: 0 };
  readonly #auth: SessionAuthStore;
  readonly #allowedGroupIds: ReadonlySet<string>;
  readonly #onMessage: (message: GroupMessage) => Promise<void>;
  readonly #onEvent: (event: SessionEvent) => void;
  readonly #pairing: PairingHandler | undefined;
  readonly #socketFactory: SocketFactory;
  readonly #recentMessages: RecentMessageCache;
  readonly #clock: () => Date;
  readonly #sleep: (milliseconds: number, signal: AbortSignal) => Promise<unknown>;
  readonly #maximumQueuedMessages: number;
  readonly #maximumReconnectAttempts: number;
  readonly #abort = new AbortController();
  readonly #queue: GroupMessage[] = [];
  readonly #finished: Promise<SessionStopReason>;
  #resolveFinished!: (reason: SessionStopReason) => void;
  #socket: SessionSocket | undefined;
  #open = false;
  #started = false;
  #stopReason: SessionStopReason | undefined;
  #draining: Promise<void> | undefined;
  #reconnectAttempts = 0;
  #pairingPhoneNumber: string | undefined;
  #pairingCodeRequested = false;

  constructor(options: WhatsAppSessionOptions) {
    const allowedGroupIds = new Set(options.allowedGroupIds);
    if (allowedGroupIds.size === 0 || ![...allowedGroupIds].every(isGroupId)) {
      throw new Error("At least one valid group ID must be allowlisted");
    }
    const maximumQueuedMessages = options.maximumQueuedMessages ?? 1_000;
    const maximumReconnectAttempts = options.maximumReconnectAttempts ?? 8;
    if (!Number.isSafeInteger(maximumQueuedMessages) || maximumQueuedMessages < 1 ||
      !Number.isSafeInteger(maximumReconnectAttempts) || maximumReconnectAttempts < 1) {
      throw new RangeError("Session limits must be positive integers");
    }
    this.#auth = options.auth;
    this.#allowedGroupIds = allowedGroupIds;
    this.#onMessage = options.onMessage;
    this.#onEvent = options.onEvent ?? (() => {});
    this.#pairing = options.pairing;
    this.#socketFactory = options.socketFactory ?? ((config) => makeWASocket(config));
    this.#recentMessages = options.recentMessages ?? new RecentMessageCache();
    this.#clock = options.clock ?? (() => new Date());
    this.#sleep = options.sleep ?? ((milliseconds, signal) => sleepFor(milliseconds, undefined, { signal }));
    this.#maximumQueuedMessages = maximumQueuedMessages;
    this.#maximumReconnectAttempts = maximumReconnectAttempts;
    this.#finished = new Promise((resolve) => { this.#resolveFinished = resolve; });
  }

  get recentMessages(): RecentMessageCache {
    return this.#recentMessages;
  }

  /** Connects and resolves with the reason once the session has fully stopped. */
  start(): Promise<SessionStopReason> {
    if (this.#started) throw new Error("A session can only be started once");
    this.#started = true;
    this.#auth.failed.then(() => this.#stop("persistence-failed"), () => this.#stop("persistence-failed"));
    void this.#begin();
    return this.#finished;
  }

  stop(): Promise<SessionStopReason> {
    void this.#stop("requested");
    return this.#finished;
  }

  async fetchGroupMetadata(groupId: string): Promise<GroupMetadata> {
    return this.#requireOpenSocket().groupMetadata(groupId);
  }

  async revoke(key: ObservedMessageKey): Promise<void> {
    await this.#requireOpenSocket().sendMessage(key.remoteJid, { delete: { ...key } });
  }

  ownIds(): readonly string[] {
    const me = this.#auth.state.creds.me;
    return [me?.id, me?.lid, me?.phoneNumber].filter((id): id is string => typeof id === "string");
  }

  async #begin(): Promise<void> {
    try {
      const creds = this.#auth.state.creds;
      if (!creds.registered) {
        if (this.#pairing === undefined) return void await this.#stop("pairing-unavailable");
        // requestPairingCode stores the claimed number before the phone confirms.
        // An abandoned attempt would otherwise make Baileys try to log in as it.
        if (creds.me !== undefined) {
          delete creds.me;
          await this.#auth.saveCreds();
        }
        const phoneNumber = await this.#pairing.phoneNumber();
        if (!phoneNumberPattern.test(phoneNumber)) return void await this.#stop("pairing-failed");
        this.#pairingPhoneNumber = phoneNumber;
      }
      if (this.#stopReason === undefined) this.#connect();
    } catch {
      await this.#stop(this.#auth.state.creds.registered ? "persistence-failed" : "pairing-failed");
    }
  }

  #connect(): void {
    if (this.#stopReason !== undefined) return;
    this.#emit({ type: "connecting" });
    let socket: SessionSocket;
    try {
      socket = this.#socketFactory(this.#socketConfig());
    } catch {
      this.#scheduleReconnect(false);
      return;
    }
    this.#socket = socket;
    socket.ev.on("creds.update", (update) => {
      this.#auth.saveCreds(update).catch(() => this.#stop("persistence-failed"));
    });
    socket.ev.on("connection.update", (update) => {
      if (socket === this.#socket) this.#onConnectionUpdate(socket, update);
    });
    socket.ev.on("messages.upsert", (upsert) => {
      if (socket === this.#socket) this.#onUpsert(upsert);
    });
  }

  #socketConfig(): UserFacingSocketConfig {
    return {
      auth: this.#auth.state,
      logger: silentLogger,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      generateHighQualityLinkPreview: false,
      emitOwnEvents: false,
      getMessage: async () => undefined,
    };
  }

  #onConnectionUpdate(socket: SessionSocket, update: Partial<ConnectionState>): void {
    if (this.#stopReason !== undefined) return;
    if (update.qr !== undefined && !this.#auth.state.creds.registered) {
      void this.#requestPairingCode(socket);
    }
    if (update.connection === "open") {
      this.#open = true;
      this.#reconnectAttempts = 0;
      this.#emit({ type: "open" });
    } else if (update.connection === "close") {
      this.#open = false;
      this.#socket = undefined;
      this.#onClose(statusCodeOf(update.lastDisconnect?.error));
    }
  }

  async #requestPairingCode(socket: SessionSocket): Promise<void> {
    // WhatsApp keeps rotating QR references; one code per run is enough.
    if (this.#pairingCodeRequested) return;
    this.#pairingCodeRequested = true;
    const phoneNumber = this.#pairingPhoneNumber;
    const pairing = this.#pairing;
    if (phoneNumber === undefined || pairing === undefined) return void await this.#stop("pairing-unavailable");
    try {
      const code = await socket.requestPairingCode(phoneNumber);
      if (this.#stopReason !== undefined || socket !== this.#socket) return;
      pairing.showCode(code);
      this.#emit({ type: "pairing-code-issued" });
    } catch {
      await this.#stop("pairing-failed");
    }
  }

  #onClose(statusCode: number | undefined): void {
    switch (statusCode) {
      case DisconnectReason.loggedOut:
        return void this.#stop("logged-out");
      case DisconnectReason.connectionReplaced:
        return void this.#stop("connection-replaced");
      case DisconnectReason.forbidden:
        return void this.#stop("forbidden");
      case DisconnectReason.multideviceMismatch:
        return void this.#stop("multidevice-mismatch");
      case DisconnectReason.restartRequired:
        // Expected once right after pairing; still counted so it cannot spin.
        return this.#scheduleReconnect(true);
    }
    if (this.#pairingCodeRequested && !this.#auth.state.creds.registered) {
      return void this.#stop("pairing-expired");
    }
    this.#scheduleReconnect(false);
  }

  #scheduleReconnect(immediate: boolean): void {
    this.#reconnectAttempts += 1;
    if (this.#reconnectAttempts > this.#maximumReconnectAttempts) {
      return void this.#stop("reconnect-exhausted");
    }
    const delayMilliseconds = immediate ? 0
      : Math.min(maximumReconnectDelayMilliseconds, 1_000 * 2 ** (this.#reconnectAttempts - 1));
    this.#emit({ type: "reconnecting", attempt: this.#reconnectAttempts, delayMilliseconds });
    this.#sleep(delayMilliseconds, this.#abort.signal).then(() => this.#connect(), () => {});
  }

  #onUpsert({ messages, type }: BaileysEventMap["messages.upsert"]): void {
    // "append" carries history and offline catch-up; only live traffic is moderated.
    if (type !== "notify" || this.#stopReason !== undefined) return;
    const now = this.#clock();
    for (const raw of messages) {
      const message = normalizeMessage(raw, now);
      if (message === undefined || !this.#allowedGroupIds.has(message.groupId)) {
        this.counters.ignored += 1;
        continue;
      }
      if (!this.#recentMessages.remember(message, now)) {
        this.counters.duplicates += 1;
        continue;
      }
      if (this.#queue.length >= this.#maximumQueuedMessages) {
        return void this.#stop("overloaded");
      }
      this.#queue.push(message);
      this.counters.accepted += 1;
    }
    this.#drain();
  }

  #drain(): void {
    if (this.#draining !== undefined) return;
    this.#draining = (async () => {
      try {
        for (let message = this.#queue.shift(); message !== undefined && this.#stopReason === undefined;
          message = this.#queue.shift()) {
          try {
            await this.#onMessage(message);
            this.counters.handled += 1;
          } catch {
            // One bad message must not halt moderation for everything behind it.
            this.counters.handlerErrors += 1;
          }
        }
      } finally {
        this.#draining = undefined;
      }
    })();
  }

  #requireOpenSocket(): SessionSocket {
    if (!this.#open || this.#socket === undefined || this.#stopReason !== undefined) {
      throw new Error("WhatsApp session is not connected");
    }
    return this.#socket;
  }

  #emit(event: SessionEvent): void {
    try {
      this.#onEvent(event);
    } catch {
      // Observers cannot break the session.
    }
  }

  async #stop(reason: SessionStopReason): Promise<void> {
    if (this.#stopReason !== undefined) return;
    this.#stopReason = reason;
    this.#abort.abort();
    this.#queue.length = 0;
    const socket = this.#socket;
    this.#socket = undefined;
    this.#open = false;
    try {
      await socket?.end(undefined);
    } catch {
      // The socket is being discarded either way.
    }
    await this.#draining;
    this.#emit({ type: "stopped", reason });
    this.#resolveFinished(reason);
  }
}
