/*
 * The account warm-up clock that every action gate reads.
 *
 * It is looked up once per process, so a single transient Postgres failure used
 * to latch the worker shut for its whole life: the lookup ran only on a
 * connection "open" event, and a stable connection never produces a second one.
 * Every remove, lock, approve and automatic deletion then refused
 * "account-warming-up" forever on an account months past warm-up.
 *
 * It stays undefined — refusing everything — until a real date lands, so the
 * retry never trades a stuck-closed worker for one that acts too early.
 */

const defaultMaximumDelayMilliseconds = 60_000;

export interface WarmupClockOptions {
  lookup(accountId: string): Promise<Date>;
  onRecorded?: (startedAt: Date) => void;
  onFailure?: (error: unknown, attempt: number) => void;
  /** Defaults to an unref'd timer, so a pending retry never holds the process open. */
  schedule?: (run: () => void, delayMilliseconds: number) => void;
  maximumDelayMilliseconds?: number;
}

export class WarmupClock {
  readonly #lookup: (accountId: string) => Promise<Date>;
  readonly #onRecorded: (startedAt: Date) => void;
  readonly #onFailure: (error: unknown, attempt: number) => void;
  readonly #schedule: (run: () => void, delayMilliseconds: number) => void;
  readonly #maximumDelayMilliseconds: number;
  #startedAt: Date | undefined;
  #attempts = 0;
  #inFlight = false;
  #retryScheduled = false;

  constructor(options: WarmupClockOptions) {
    this.#lookup = options.lookup;
    this.#onRecorded = options.onRecorded ?? (() => {});
    this.#onFailure = options.onFailure ?? (() => {});
    this.#schedule = options.schedule ?? ((run, delay) => void setTimeout(run, delay).unref());
    this.#maximumDelayMilliseconds = options.maximumDelayMilliseconds ?? defaultMaximumDelayMilliseconds;
  }

  /** Undefined until the clock is known, which refuses every gated action. */
  startedAt(): Date | undefined {
    return this.#startedAt;
  }

  /**
   * Idempotent and safe to call on every connection. At most one lookup is in
   * flight and at most one retry chain exists: a reconnect arriving in the gap
   * between retries must not fork a second chain, or a flapping connection
   * multiplies the backoff into a burst against a database already in trouble.
   */
  record(accountId: string): void {
    if (this.#startedAt !== undefined || this.#inFlight || this.#retryScheduled) return;
    this.#inFlight = true;
    this.#lookup(accountId).then((startedAt) => {
      this.#inFlight = false;
      // A row that cannot be read as a date is a failure, not a warm-up start.
      if (!Number.isFinite(startedAt.getTime())) {
        this.#retry(accountId, new Error("Warm-up start is not a valid date"));
        return;
      }
      this.#startedAt = startedAt;
      this.#onRecorded(startedAt);
    }, (error: unknown) => {
      this.#inFlight = false;
      this.#retry(accountId, error);
    });
  }

  #retry(accountId: string, error: unknown): void {
    this.#attempts += 1;
    this.#onFailure(error, this.#attempts);
    const delay = Math.min(this.#maximumDelayMilliseconds, 1_000 * 2 ** Math.min(this.#attempts - 1, 6));
    this.#retryScheduled = true;
    this.#schedule(() => {
      this.#retryScheduled = false;
      this.record(accountId);
    }, delay);
  }
}
