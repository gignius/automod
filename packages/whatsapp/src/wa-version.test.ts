import assert from "node:assert/strict";
import test from "node:test";
import type { WAVersion } from "@whiskeysockets/baileys";
import { resolveWaWebVersion } from "./wa-version.ts";

const bundled: WAVersion = [2, 3000, 1043857760];

test("uses a newer WhatsApp Web version when WhatsApp reports one", async () => {
  assert.deepEqual(await resolveWaWebVersion(async () => ({ version: [2, 3000, 1047956849], isLatest: true }), bundled),
    { version: [2, 3000, 1047956849], source: "latest" });
});

test("keeps the bundled version on failure, malformed, older, or foreign-major answers", async () => {
  const cases: Parameters<typeof resolveWaWebVersion>[0][] = [
    async () => { throw new Error("offline"); },
    async () => ({ version: bundled, isLatest: false }),
    async () => ({ version: [2, 3000, 1] as WAVersion, isLatest: true }),
    async () => ({ version: [3, 0, 0] as WAVersion, isLatest: true }),
    async () => ({ version: [2, 3000] as unknown as WAVersion, isLatest: true }),
    async () => ({ version: [2, 3000, -5] as WAVersion, isLatest: true }),
    () => new Promise(() => {}),
  ];
  for (const fetcher of cases) {
    assert.deepEqual(await resolveWaWebVersion(fetcher, bundled, 20), { version: bundled, source: "bundled" });
  }
});
