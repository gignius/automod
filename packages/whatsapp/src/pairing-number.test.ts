import assert from "node:assert/strict";
import test from "node:test";
import { normalizePairingNumber } from "./pairing-number.ts";

test("accepts international numbers in common formats and shows them back", () => {
  for (const input of ["61412345678", "+61 412 345 678", "+61 (412) 345-678", " 61412345678 "]) {
    assert.deepEqual(normalizePairingNumber(input), { digits: "61412345678", display: "+61 412 345 678" }, input);
  }
  assert.deepEqual(normalizePairingNumber("+1 415 555 0100"), { digits: "14155550100", display: "+14155550100" });
});

test("catches the mistakes that make WhatsApp refuse the link", () => {
  assert.match((normalizePairingNumber("0412345678") as { error: string }).error, /country code/);
  assert.match((normalizePairingNumber("+61 0412 345 678") as { error: string }).error, /Drop the 0 after 61/);
  assert.match((normalizePairingNumber("61412abc") as { error: string }).error, /digits only/);
  assert.match((normalizePairingNumber("61412") as { error: string }).error, /full international/);
});
