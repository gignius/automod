import assert from "node:assert/strict";
import test from "node:test";
import type { Classification, Classifier, ModerationCategory } from "../../core/src/index.ts";
import { evaluate, type EvalExample } from "./evaluate.ts";

function example(id: string, expectedCategory: ModerationCategory): EvalExample {
  return { id, groupId: "120363000000000001@g.us", text: `text ${id}`, expectedCategory };
}

function scripted(results: Record<string, Classification | "fail">): Classifier {
  return {
    classify: async (message) => {
      const result = results[message.id];
      if (result === undefined || result === "fail") throw new Error("down");
      return result;
    },
  };
}

test("computes accuracy, confusion, auto-action false positives, and coverage", async () => {
  const examples = [
    example("1", "scam"), example("2", "scam"), example("3", "allowed"),
    example("4", "allowed"), example("5", "spam"), example("6", "abuse"),
  ];
  const classifier = scripted({
    "1": { category: "scam", confidence: 0.99, reason: "" },
    "2": { category: "scam", confidence: 0.80, reason: "" },
    "3": { category: "scam", confidence: 0.97, reason: "" },
    "4": { category: "allowed", confidence: 0.99, reason: "" },
    "5": { category: "spam", confidence: 0.96, reason: "" },
    "6": "fail",
  });
  let tick = 0;

  const report = await evaluate(examples, classifier, {
    autoActionCategories: ["spam", "scam"], threshold: 0.95, concurrency: 1, clock: () => (tick += 10),
  });

  assert.equal(report.examples, 6);
  assert.equal(report.classified, 5);
  assert.equal(report.failures, 1);
  assert.deepEqual(report.failedExampleIds, ["6"]);
  assert.equal(report.accuracy, 4 / 5);
  assert.deepEqual(report.misclassifiedExampleIds, ["3"]);
  assert.equal(report.confusion.allowed.scam, 1);
  assert.equal(report.confusion.scam.scam, 2);
  assert.deepEqual(report.categories.scam, { support: 2, precision: 2 / 3, recall: 1 });
  assert.equal(report.categories.other.precision, null);
  assert.equal(report.autoAction.wouldAct, 3);
  assert.deepEqual(report.autoAction.wrongActionExampleIds, ["3"]);
  assert.equal(report.autoAction.falsePositiveRate, 1 / 3);
  assert.equal(report.autoAction.coverage, 2 / 3);
  assert.equal(report.latencyMilliseconds.p50, 10);
  assert.equal(JSON.stringify(report).includes("text "), false, "reports never contain message text");
});

test("handles an empty set and rejects bad options", async () => {
  const report = await evaluate([], scripted({}), { autoActionCategories: ["spam"], threshold: 0.9 });
  assert.equal(report.accuracy, null);
  assert.equal(report.autoAction.falsePositiveRate, null);
  await assert.rejects(evaluate([], scripted({}), { autoActionCategories: ["spam"], threshold: 2 }), RangeError);
});
