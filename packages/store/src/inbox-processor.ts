import type { GroupMessage } from "../../core/src/index.ts";
import type { Inbox } from "./postgres-store.ts";

export interface InboxCounters {
  handled: number;
  retried: number;
  deadLettered: number;
  /** Claim or bookkeeping queries that failed; the loop backs off and continues. */
  storeErrors: number;
}

export interface InboxProcessorOptions {
  inbox: Inbox;
  /** Called at least once per message, in order within a group. The signal fires on timeout or stop. */
  handle(message: GroupMessage, signal: AbortSignal): Promise<void>;
  /** Groups handled concurrently (one message per group at a time). */
  concurrency?: number;
  maximumAttempts?: number;
  handlerTimeoutMilliseconds?: number;
  /** How long an idle loop waits before re-checking for retries that became due. */
  idleMilliseconds?: number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

class HandlerTimeoutError extends Error {}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

/**
 * Drains the durable inbox: leases each group's oldest pending message, runs
 * the handler with a timeout, and marks it done or schedules a retry. A crash
 * leaves unfinished messages pending; they are leased again once their lease
 * expires, so delivery is at-least-once and handlers must be idempotent.
 */
export class InboxProcessor {
  readonly counters: InboxCounters = { handled: 0, retried: 0, deadLettered: 0, storeErrors: 0 };
  readonly #inbox: Inbox;
  readonly #handle: (message: GroupMessage, signal: AbortSignal) => Promise<void>;
  readonly #concurrency: number;
  readonly #maximumAttempts: number;
  readonly #handlerTimeoutMilliseconds: number;
  readonly #leaseSeconds: number;
  readonly #idleMilliseconds: number;
  readonly #sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly #stopping = new AbortController();
  #wake = new AbortController();
  #running: Promise<void> | undefined;

  constructor(options: InboxProcessorOptions) {
    const concurrency = options.concurrency ?? 4;
    const maximumAttempts = options.maximumAttempts ?? 5;
    const handlerTimeoutMilliseconds = options.handlerTimeoutMilliseconds ?? 60_000;
    const idleMilliseconds = options.idleMilliseconds ?? 5_000;
    for (const value of [concurrency, maximumAttempts, handlerTimeoutMilliseconds, idleMilliseconds]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("Inbox limits must be positive integers");
    }
    this.#inbox = options.inbox;
    this.#handle = options.handle;
    this.#concurrency = concurrency;
    this.#maximumAttempts = maximumAttempts;
    this.#handlerTimeoutMilliseconds = handlerTimeoutMilliseconds;
    // The lease outlives the timeout, so no other worker takes a message this one still owns.
    this.#leaseSeconds = Math.ceil(handlerTimeoutMilliseconds / 1000) * 2;
    this.#idleMilliseconds = idleMilliseconds;
    this.#sleep = options.sleep ?? abortableSleep;
  }

  /** Runs until `stop()`; resolves once in-flight messages have settled. */
  start(): Promise<void> {
    this.#running ??= this.#run();
    return this.#running;
  }

  /** Signals that a new message was stored, so an idle loop claims it now. */
  wake(): void {
    this.#wake.abort();
  }

  async stop(): Promise<void> {
    this.#stopping.abort();
    await this.#running;
  }

  async #run(): Promise<void> {
    while (!this.#stopping.signal.aborted) {
      const wake = this.#wake;
      let claimed;
      try {
        claimed = await this.#inbox.claim(this.#concurrency, this.#leaseSeconds);
      } catch {
        this.counters.storeErrors += 1;
        await this.#idle(wake);
        continue;
      }
      if (claimed.length === 0) {
        await this.#idle(wake);
        continue;
      }
      await Promise.all(claimed.map((entry) => this.#process(entry.rowId, entry.message)));
    }
  }

  async #idle(wake: AbortController): Promise<void> {
    if (!wake.signal.aborted) {
      await this.#sleep(this.#idleMilliseconds, AbortSignal.any([wake.signal, this.#stopping.signal]));
    }
    if (this.#wake === wake) this.#wake = new AbortController();
  }

  async #process(rowId: string, message: GroupMessage): Promise<void> {
    const timeout = new AbortController();
    const signal = AbortSignal.any([timeout.signal, this.#stopping.signal]);
    let timer: NodeJS.Timeout | undefined;
    let succeeded = false;
    try {
      await Promise.race([
        this.#handle(message, signal),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            timeout.abort();
            reject(new HandlerTimeoutError());
          }, this.#handlerTimeoutMilliseconds);
        }),
      ]);
      succeeded = true;
    } catch {
      // Handler failures and timeouts are retried; the cause is not logged here
      // because handler errors can carry message content.
    } finally {
      clearTimeout(timer);
    }
    try {
      if (succeeded) {
        await this.#inbox.complete(rowId);
        this.counters.handled += 1;
      } else if (await this.#inbox.fail(rowId, this.#maximumAttempts) === "dead") {
        this.counters.deadLettered += 1;
      } else {
        this.counters.retried += 1;
      }
    } catch {
      // The lease expires and the message is claimed again.
      this.counters.storeErrors += 1;
    }
  }
}
