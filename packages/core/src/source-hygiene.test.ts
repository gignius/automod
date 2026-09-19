import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));

// Control characters (other than tab, newline, carriage return), zero-width
// and directional marks, bidi embeddings/overrides/isolates, and BOM.
// Built from code points so this file itself contains none of them.
const hidden = new RegExp(`[${[
  [0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x9f],
  [0x200b, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069], [0x061c, 0x061c], [0xfeff, 0xfeff],
].map(([from, to]) => `${String.fromCodePoint(from!)}-${String.fromCodePoint(to!)}`).join("")}]`, "u");

async function* sourceFiles(directory: string): AsyncGenerator<string> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (/\.(ts|sql|md|json|ya?ml)$/.test(entry.name)) yield path;
  }
}

test("no source, migration, or doc file contains invisible or bidi control characters", async () => {
  const offenders: string[] = [];
  for (const directory of ["packages", "docs"]) {
    for await (const path of sourceFiles(join(root, directory))) {
      const lines = (await readFile(path, "utf8")).split("\n");
      lines.forEach((line, index) => {
        if (hidden.test(line)) offenders.push(`${relative(root, path)}:${index + 1}`);
      });
    }
  }
  assert.deepEqual(offenders, []);
});
