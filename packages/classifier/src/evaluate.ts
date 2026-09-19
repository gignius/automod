import {
  moderationCategories,
  type Classifier,
  type GroupPolicy,
  type ModerationCategory,
} from "../../core/src/index.ts";

export interface EvalExample {
  id: string;
  groupId: string;
  text: string;
  expectedCategory: ModerationCategory;
}

export interface EvaluationOptions {
  /** Categories that would be auto-actioned, and the confidence needed to act. */
  autoActionCategories: readonly ModerationCategory[];
  threshold: number;
  concurrency?: number;
  clock?: () => number;
}

export interface CategoryMetrics {
  support: number;
  precision: number | null;
  recall: number | null;
}

/** Aggregates only: no message text ever appears in a report. */
export interface EvaluationReport {
  examples: number;
  classified: number;
  failures: number;
  accuracy: number | null;
  categories: Record<ModerationCategory, CategoryMetrics>;
  /** confusion[expected][predicted] */
  confusion: Record<ModerationCategory, Record<ModerationCategory, number>>;
  autoAction: {
    threshold: number;
    categories: ModerationCategory[];
    /** Would-be actions on messages whose label says otherwise, over all would-be actions. */
    falsePositiveRate: number | null;
    wouldAct: number;
    wrongActionExampleIds: string[];
    /** Labelled actionable messages the threshold would have acted on. */
    coverage: number | null;
  };
  latencyMilliseconds: { p50: number | null; p95: number | null };
  misclassifiedExampleIds: string[];
  failedExampleIds: string[];
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]!;
}

function emptyMatrix(): Record<ModerationCategory, Record<ModerationCategory, number>> {
  return Object.fromEntries(moderationCategories.map((expected) =>
    [expected, Object.fromEntries(moderationCategories.map((predicted) => [predicted, 0]))])) as
    Record<ModerationCategory, Record<ModerationCategory, number>>;
}

export async function evaluate(examples: readonly EvalExample[], classifier: Classifier,
  options: EvaluationOptions): Promise<EvaluationReport> {
  const concurrency = options.concurrency ?? 4;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 ||
    !(options.threshold >= 0 && options.threshold <= 1)) {
    throw new RangeError("Concurrency must be a positive integer and threshold within 0..1");
  }
  const clock = options.clock ?? (() => performance.now());
  const results: ({ category: ModerationCategory; confidence: number; latency: number } | undefined)[] = [];
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < examples.length; index = next++) {
      const example = examples[index]!;
      const policy: GroupPolicy = {
        groupId: example.groupId, version: 1, mode: "shadow",
        autoActionCategories: options.autoActionCategories, minimumAutoActionConfidence: options.threshold,
      };
      const started = clock();
      try {
        const classification = await classifier.classify(
          { id: example.id, groupId: example.groupId, senderId: "", text: example.text, receivedAt: new Date(0) },
          policy);
        results[index] = { ...classification, latency: clock() - started };
      } catch {
        results[index] = undefined;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, examples.length) }, worker));

  const confusion = emptyMatrix();
  const latencies: number[] = [];
  const misclassifiedExampleIds: string[] = [];
  const failedExampleIds: string[] = [];
  const wrongActionExampleIds: string[] = [];
  let correct = 0;
  let wouldAct = 0;
  let actionableLabelled = 0;
  let actionableCaught = 0;
  examples.forEach((example, index) => {
    const result = results[index];
    const actionableLabel = options.autoActionCategories.includes(example.expectedCategory);
    if (actionableLabel) actionableLabelled += 1;
    if (result === undefined) {
      failedExampleIds.push(example.id);
      return;
    }
    latencies.push(result.latency);
    confusion[example.expectedCategory][result.category] += 1;
    if (result.category === example.expectedCategory) correct += 1;
    else misclassifiedExampleIds.push(example.id);
    const acts = options.autoActionCategories.includes(result.category) && result.confidence >= options.threshold;
    if (acts) {
      wouldAct += 1;
      if (result.category !== example.expectedCategory) wrongActionExampleIds.push(example.id);
      else actionableCaught += 1;
    }
  });
  const classified = examples.length - failedExampleIds.length;
  const categories = Object.fromEntries(moderationCategories.map((category) => {
    const support = moderationCategories.reduce((sum, predicted) => sum + confusion[category][predicted], 0);
    const predictedTotal = moderationCategories.reduce((sum, expected) => sum + confusion[expected][category], 0);
    const truePositives = confusion[category][category];
    return [category, { support, precision: ratio(truePositives, predictedTotal), recall: ratio(truePositives, support) }];
  })) as Record<ModerationCategory, CategoryMetrics>;
  latencies.sort((left, right) => left - right);

  return {
    examples: examples.length,
    classified,
    failures: failedExampleIds.length,
    accuracy: ratio(correct, classified),
    categories,
    confusion,
    autoAction: {
      threshold: options.threshold,
      categories: [...options.autoActionCategories],
      falsePositiveRate: ratio(wrongActionExampleIds.length, wouldAct),
      wouldAct,
      wrongActionExampleIds,
      coverage: ratio(actionableCaught, actionableLabelled),
    },
    latencyMilliseconds: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
    misclassifiedExampleIds,
    failedExampleIds,
  };
}
