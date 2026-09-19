export class RollingWindowLimiter {
  readonly #events = new Map<string, number[]>();
  readonly #maximumEvents: number;
  readonly #windowMilliseconds: number;

  constructor(maximumEvents: number, windowMilliseconds: number) {
    if (maximumEvents < 1 || windowMilliseconds < 1) {
      throw new RangeError("Limiter values must be positive");
    }

    this.#maximumEvents = maximumEvents;
    this.#windowMilliseconds = windowMilliseconds;
  }

  tryAcquire(key: string, now: Date): boolean {
    const cutoff = now.getTime() - this.#windowMilliseconds;
    const recentEvents = (this.#events.get(key) ?? []).filter(
      (timestamp) => timestamp > cutoff,
    );

    if (recentEvents.length >= this.#maximumEvents) {
      this.#events.set(key, recentEvents);
      return false;
    }

    recentEvents.push(now.getTime());
    this.#events.set(key, recentEvents);
    return true;
  }
}
