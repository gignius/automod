import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EncryptedAuthState } from "./encrypted-auth-state.ts";

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "automod-auth-"));
  try {
    await run(join(root, "state"));
  } finally {
    await chmod(root, 0o700);
    await rm(root, { recursive: true, force: true });
  }
}

test("round-trips credentials and signal keys through an owner-only encrypted snapshot", () =>
  withRoot(async (root) => {
    const key = randomBytes(32);
    const first = await EncryptedAuthState.open(root, "main", key);
    const identity = Buffer.from(first.state.creds.noiseKey.private);
    await first.state.keys.set({ "pre-key": { "1": { public: Buffer.alloc(32, 1), private: Buffer.alloc(32, 2) } } });
    await first.saveCreds({ registered: true });
    await first.close();

    const snapshot = join(root, "main", "auth.enc");
    assert.equal((await stat(snapshot)).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, "main"))).mode & 0o777, 0o700);
    assert.equal((await readFile(snapshot)).includes(identity), false);

    const second = await EncryptedAuthState.open(root, "main", key);
    assert.equal(second.state.creds.registered, true);
    assert.deepEqual(Buffer.from(second.state.creds.noiseKey.private), identity);
    const keys = await second.state.keys.get("pre-key", ["1", "2"]);
    assert.deepEqual(Object.keys(keys), ["1"]);
    assert.deepEqual(Buffer.from(keys["1"]!.private), Buffer.alloc(32, 2));
    await second.close();
  }));

test("refuses a wrong key without replacing the snapshot", () =>
  withRoot(async (root) => {
    const store = await EncryptedAuthState.open(root, "main", randomBytes(32));
    await store.close();
    const before = await readFile(join(root, "main", "auth.enc"));

    await assert.rejects(EncryptedAuthState.open(root, "main", randomBytes(32)), /Cannot open/);
    assert.deepEqual(await readFile(join(root, "main", "auth.enc")), before);
  }));

test("binds a snapshot to its session ID", () =>
  withRoot(async (root) => {
    const key = randomBytes(32);
    await (await EncryptedAuthState.open(root, "first", key)).close();
    await mkdir(join(root, "second"), { mode: 0o700 });
    await copyFile(join(root, "first", "auth.enc"), join(root, "second", "auth.enc"));
    await chmod(join(root, "second", "auth.enc"), 0o600);

    await assert.rejects(EncryptedAuthState.open(root, "second", key), /Cannot open/);
  }));

test("refuses tampered and truncated snapshots", () =>
  withRoot(async (root) => {
    const key = randomBytes(32);
    await (await EncryptedAuthState.open(root, "main", key)).close();
    const path = join(root, "main", "auth.enc");
    const original = await readFile(path);

    const tampered = Buffer.from(original);
    tampered[tampered.length - 1]! ^= 1;
    await writeFile(path, tampered);
    await assert.rejects(EncryptedAuthState.open(root, "main", key), /Cannot open/);

    await writeFile(path, original.subarray(0, 20));
    await assert.rejects(EncryptedAuthState.open(root, "main", key), /Cannot open/);
  }));

test("refuses snapshots readable by other users", () =>
  withRoot(async (root) => {
    const key = randomBytes(32);
    await (await EncryptedAuthState.open(root, "main", key)).close();
    await chmod(join(root, "main", "auth.enc"), 0o644);

    await assert.rejects(EncryptedAuthState.open(root, "main", key), /Cannot open/);
  }));

test("refuses group- or world-accessible state directories", () =>
  withRoot(async (root) => {
    await mkdir(root, { mode: 0o755 });
    await chmod(root, 0o755);

    await assert.rejects(EncryptedAuthState.open(root, "main", randomBytes(32)), /mode 0700/);
  }));

test("rejects unsafe session IDs and wrong-length keys", () =>
  withRoot(async (root) => {
    await assert.rejects(EncryptedAuthState.open(root, "../escape", randomBytes(32)), /safe session ID/);
    await assert.rejects(EncryptedAuthState.open(root, "main", randomBytes(16)), /32-byte/);
  }));

test("holds an exclusive writer lock until closed", () =>
  withRoot(async (root) => {
    const key = randomBytes(32);
    const store = await EncryptedAuthState.open(root, "main", key);

    await assert.rejects(EncryptedAuthState.open(root, "main", key), /locked/);
    await store.close();
    await (await EncryptedAuthState.open(root, "main", key)).close();
  }));

test("signals a failed write and refuses all further use", () =>
  withRoot(async (root) => {
    const store = await EncryptedAuthState.open(root, "main", randomBytes(32));
    let failed = false;
    void store.failed.then(() => { failed = true; });
    const directory = join(root, "main");
    await chmod(directory, 0o500);
    try {
      await assert.rejects(store.saveCreds({ registered: true }));
      await store.failed;
      assert.equal(failed, true);
      await chmod(directory, 0o700);
      await assert.rejects(store.saveCreds(), /failed a write/);
      await assert.rejects(async () => store.state.keys.get("pre-key", ["1"]), /failed a write/);
    } finally {
      await chmod(directory, 0o700);
      await store.close();
    }
  }));

test("finishes queued writes on close, then refuses new ones", () =>
  withRoot(async (root) => {
    const key = randomBytes(32);
    const store = await EncryptedAuthState.open(root, "main", key);
    const write = store.saveCreds({ registered: true });
    await store.close();
    await write;
    await assert.rejects(store.saveCreds(), /closed/);

    const reopened = await EncryptedAuthState.open(root, "main", key);
    assert.equal(reopened.state.creds.registered, true);
    await reopened.close();
  }));
