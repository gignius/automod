import {
  RollingWindowLimiter,
  type Classification,
  type Classifier,
  type GroupMessage,
  type GroupPolicy,
} from "../../core/src/index.ts";

export class ClassificationBudgetExceededError extends Error {
  constructor() {
    super("Daily classification budget exhausted");
    this.name = "ClassificationBudgetExceededError";
  }
}

/**
 * Caps model calls per rolling day so a message flood cannot run up an
 * unbounded bill. Over budget, calls fail; the inbox retries and eventually
 * dead-letters them.
 */
export class BudgetedClassifier implements Classifier {
  readonly #inner: Classifier;
  readonly #limiter: RollingWindowLimiter;
  readonly #clock: () => Date;
  #refused = 0;

  constructor(inner: Classifier, callsPerDay = 20_000, clock: () => Date = () => new Date()) {
    if (!Number.isSafeInteger(callsPerDay) || callsPerDay < 1) throw new RangeError("Budget must be a positive integer");
    this.#inner = inner;
    this.#limiter = new RollingWindowLimiter(callsPerDay, 24 * 60 * 60_000);
    this.#clock = clock;
  }

  get refused(): number {
    return this.#refused;
  }

  classify(message: GroupMessage, policy: GroupPolicy, signal?: AbortSignal): Promise<Classification> {
    if (!this.#limiter.tryAcquire("calls", this.#clock())) {
      this.#refused += 1;
      return Promise.reject(new ClassificationBudgetExceededError());
    }
    return this.#inner.classify(message, policy, signal);
  }
}
