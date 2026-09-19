import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { moderationCategories, type ModerationCategory } from "../../core/src/index.ts";
import { connectPostgresFromFile, migrate, PostgresStore, type Database } from "../../store/src/index.ts";
import { evaluate } from "./evaluate.ts";
import { defaultModel, GeminiClassifier, vertexGenerate } from "./gemini-classifier.ts";

/*
 * Bake-off harness: runs one model over the labelled eval set and prints an
 * aggregate JSON report (no message text). Run it once per candidate model.
 */

const usage = `Usage: pnpm eval --database-url-file <file> --gcp-project <id> [options]

  --gcp-location   Vertex AI endpoint: global (default), us, or eu.
  --model          Default ${defaultModel}.
  --threshold      Auto-action confidence threshold (default 0.95).
  --categories     Comma-separated auto-action categories (default spam,scam).
  --concurrency    Parallel requests (default 4).
  --input-price    USD per 1M input tokens, to estimate cost (optional).
  --output-price   USD per 1M output tokens, including thinking (optional).`;

function fail(message: string): never {
  process.stderr.write(`${message}\n\n${usage}\n`);
  process.exit(2);
}

function price(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) fail(`--${name} must be a non-negative number.`);
  return parsed;
}

async function main(): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        "database-url-file": { type: "string" },
        "gcp-project": { type: "string" },
        "gcp-location": { type: "string" },
        model: { type: "string" },
        threshold: { type: "string" },
        categories: { type: "string" },
        concurrency: { type: "string" },
        "input-price": { type: "string" },
        "output-price": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    fail("Unrecognised arguments.");
  }
  if (values.help) {
    process.stdout.write(`${usage}\n`);
    return 0;
  }
  const urlFile = values["database-url-file"];
  const project = values["gcp-project"];
  if (urlFile === undefined || project === undefined) fail("--database-url-file and --gcp-project are required.");
  const threshold = Number(values.threshold ?? "0.95");
  if (!(threshold >= 0 && threshold <= 1)) fail("--threshold must be within 0..1.");
  const categories = (values.categories ?? "spam,scam").split(",").map((category) => category.trim());
  if (!categories.every((category) => category !== "allowed" &&
    moderationCategories.includes(category as ModerationCategory))) {
    fail("--categories must be from spam, scam, abuse, other.");
  }
  const concurrency = Number(values.concurrency ?? "4");
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) fail("--concurrency must be 1..16.");
  const inputPrice = price(values["input-price"], "input-price");
  const outputPrice = price(values["output-price"], "output-price");
  const model = values.model ?? defaultModel;
  if (!/^[a-z0-9][a-z0-9.-]{1,63}$/.test(model)) fail("Invalid --model.");

  let classifier: GeminiClassifier;
  try {
    classifier = new GeminiClassifier(vertexGenerate({ project, location: values["gcp-location"] ?? "global", model }));
  } catch (error) {
    fail(error instanceof Error ? error.message : "Invalid Vertex AI settings.");
  }

  let database: Database | undefined;
  try {
    database = await connectPostgresFromFile(resolve(urlFile));
    await migrate(database);
    const examples = await new PostgresStore(database).listEvalExamples();
    if (examples.length === 0) {
      process.stderr.write("The eval set is empty; label messages with `pnpm label` first.\n");
      return 1;
    }
    process.stderr.write(`Evaluating ${model} on ${examples.length} example(s)...\n`);
    const report = await evaluate(examples, classifier, {
      autoActionCategories: categories as ModerationCategory[],
      threshold,
      concurrency,
    });
    const usage = classifier.usage;
    const outputTokens = usage.outputTokens + usage.thoughtTokens;
    const cost = inputPrice === undefined || outputPrice === undefined ? null
      : (usage.promptTokens * inputPrice + outputTokens * outputPrice) / 1_000_000;
    process.stdout.write(`${JSON.stringify({
      model,
      ranAt: new Date().toISOString(),
      ...report,
      usage: {
        ...usage,
        promptTokensPerCall: usage.calls === 0 ? null : usage.promptTokens / usage.calls,
        outputTokensPerCall: usage.calls === 0 ? null : outputTokens / usage.calls,
        estimatedCostUsd: cost,
        estimatedCostPerMessageUsd: cost === null || usage.calls === 0 ? null : cost / usage.calls,
      },
    }, null, 2)}\n`);
    return 0;
  } catch (error) {
    // Only our own messages; driver and SDK errors can echo values or request bodies.
    const own = error instanceof Error && !("code" in error) && /database URL/.test(error.message);
    process.stderr.write(`${own ? error.message : "Evaluation failed before completing"}\n`);
    return 1;
  } finally {
    await database?.close().catch(() => {});
  }
}

process.exitCode = await main();
