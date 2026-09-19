import assert from "node:assert/strict";
import test from "node:test";
import { assertSafeConnectionString } from "./connect.ts";

test("allows plaintext only to this machine", () => {
  for (const url of [
    "postgres://automod@localhost/automod",
    "postgresql://automod@127.0.0.1:5432/automod",
    "postgres://automod@[::1]/automod",
    "postgres:///automod",
    "postgres:///automod?host=/var/run/postgresql",
  ]) {
    assert.doesNotThrow(() => assertSafeConnectionString(url), url);
  }
});

test("requires verified TLS for anything remote", () => {
  for (const url of [
    "postgres://automod@db.example.com/automod",
    "postgres://automod@db.example.com/automod?sslmode=require",
    "postgres://automod@localhost/automod?host=db.example.com",
    "postgres:///automod?host=db.example.com",
    "postgres://automod@localhost.example.com/automod",
  ]) {
    assert.throws(() => assertSafeConnectionString(url), /verify-full/, url);
  }
  assert.doesNotThrow(() => assertSafeConnectionString("postgres://automod@db.example.com/automod?sslmode=verify-full"));
});

test("rejects non-postgres URLs without echoing them", () => {
  for (const url of ["mysql://localhost/marker_db", "not a url marker_db"]) {
    assert.throws(() => assertSafeConnectionString(url), (error: Error) =>
      /valid postgres/.test(error.message) && !error.message.includes("marker_db"));
  }
});
