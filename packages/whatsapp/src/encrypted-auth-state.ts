import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readPrivateFile } from "../../core/src/private-file.ts";
import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from "@whiskeysockets/baileys";

const header = Buffer.from("AMWA001\n");
const maximumSnapshotBytes = 16 * 1024 * 1024;

function additionalDataFor(sessionId: string): Buffer {
  return Buffer.from(`automod/session/${sessionId}/v1`);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 || metadata.uid !== process.getuid?.()) {
    throw new Error("Auth directory must be owned by this user with mode 0700");
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function decodeSnapshot(plaintext: Buffer): {
  creds: AuthenticationCreds;
  keys: Map<string, unknown>;
} {
  const parsed = JSON.parse(plaintext.toString("utf8"), BufferJSON.reviver);
  if (!parsed || typeof parsed !== "object" || !parsed.creds ||
    typeof parsed.creds.registered !== "boolean" ||
    !(parsed.creds.noiseKey?.private instanceof Uint8Array) ||
    parsed.creds.noiseKey.private.length !== 32 || !Array.isArray(parsed.keys) ||
    !parsed.keys.every((entry: unknown) => Array.isArray(entry) &&
      entry.length === 2 && typeof entry[0] === "string")) {
    throw new Error("Invalid authentication snapshot");
  }
  return { creds: parsed.creds, keys: new Map(parsed.keys) };
}

export class EncryptedAuthState {
  readonly state: AuthenticationState;
  readonly #directory: string;
  readonly #key: Buffer;
  readonly #additionalData: Buffer;
  readonly #keys: Map<string, unknown>;
  /** Settles once a write fails; the store then refuses all further use. */
  readonly failed: Promise<void>;
  #signalFailure!: () => void;
  #pending = Promise.resolve();
  #broken = false;
  #closed = false;
  #closing: Promise<void> | undefined;

  private constructor(directory: string, key: Buffer, sessionId: string,
    creds: AuthenticationCreds, keys: Map<string, unknown>) {
    this.#directory = directory;
    this.#key = Buffer.from(key);
    this.#additionalData = additionalDataFor(sessionId);
    this.#keys = keys;
    this.failed = new Promise((resolve) => { this.#signalFailure = resolve; });
    this.state = {
      creds,
      keys: {
        get: async <Category extends keyof SignalDataTypeMap>(category: Category, ids: string[]) => {
          await this.#pending;
          this.#assertUsable();
          const result: Record<string, SignalDataTypeMap[Category]> = Object.create(null);
          for (const id of ids) {
            const stored = this.#keys.get(JSON.stringify([category, id]));
            if (stored === undefined) continue;
            result[id] = (category === "app-state-sync-key"
              ? proto.Message.AppStateSyncKeyData.fromObject(stored as Record<string, unknown>)
              : stored) as SignalDataTypeMap[Category];
          }
          return result;
        },
        set: (updates) => this.#enqueue(async () => {
          for (const [category, entries] of Object.entries(updates)) {
            for (const [id, value] of Object.entries(entries ?? {})) {
              const key = JSON.stringify([category, id]);
              if (value == null) this.#keys.delete(key);
              else this.#keys.set(key, value);
            }
          }
          await this.#persist();
        }),
      },
    };
  }

  static async open(rootDirectory: string, sessionId: string, encryptionKey: Buffer): Promise<EncryptedAuthState> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId) || encryptionKey.length !== 32) {
      throw new Error("A safe session ID and a 32-byte encryption key are required");
    }
    const root = resolve(rootDirectory);
    const directory = join(root, sessionId);
    await ensurePrivateDirectory(root);
    await ensurePrivateDirectory(directory);
    try {
      await mkdir(join(directory, "writer.lock"), { mode: 0o700 });
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      throw new Error("Session is locked; verify no worker is running before removing writer.lock");
    }
    let store: EncryptedAuthState | undefined;
    try {
      let snapshot: Buffer | undefined;
      try {
        snapshot = await readPrivateFile(join(directory, "auth.enc"), maximumSnapshotBytes);
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) throw error;
      }
      let creds: AuthenticationCreds;
      let keys: Map<string, unknown>;
      if (snapshot === undefined) {
        creds = initAuthCreds();
        keys = new Map();
      } else {
        if (snapshot.length < 36 || !snapshot.subarray(0, 8).equals(header)) {
          throw new Error("Unsupported authentication snapshot");
        }
        const decipher = createDecipheriv("aes-256-gcm", encryptionKey, snapshot.subarray(8, 20),
          { authTagLength: 16 });
        decipher.setAAD(additionalDataFor(sessionId));
        decipher.setAuthTag(snapshot.subarray(20, 36));
        const plaintext = Buffer.concat([decipher.update(snapshot.subarray(36)), decipher.final()]);
        try {
          ({ creds, keys } = decodeSnapshot(plaintext));
        } finally {
          plaintext.fill(0);
        }
      }
      store = new EncryptedAuthState(directory, encryptionKey, sessionId, creds, keys);
      if (snapshot === undefined) await store.saveCreds();
      return store;
    } catch {
      if (store !== undefined) store.#key.fill(0);
      await rmdir(join(directory, "writer.lock"));
      throw new Error("Cannot open encrypted auth state; check permissions, key, and snapshot integrity");
    }
  }

  saveCreds(update: Partial<AuthenticationCreds> = {}): Promise<void> {
    return this.#enqueue(async () => {
      Object.assign(this.state.creds, update);
      await this.#persist();
    });
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    try {
      this.#assertUsable();
    } catch (error) {
      return Promise.reject(error);
    }
    const result = this.#pending.then(() => {
      // In-memory state may be ahead of disk after a failed write; never persist on top of it.
      if (this.#broken) throw new Error("Authentication store failed a write");
      return operation();
    });
    this.#pending = result.catch(() => {
      this.#broken = true;
      this.#signalFailure();
    });
    return result;
  }

  #assertUsable(): void {
    if (this.#broken) throw new Error("Authentication store failed a write");
    if (this.#closed) throw new Error("Authentication store is closed");
  }

  async #persist(): Promise<void> {
    const plaintext = Buffer.from(JSON.stringify({
      creds: this.state.creds,
      keys: [...this.#keys],
    }, BufferJSON.replacer));
    if (plaintext.length + 36 > maximumSnapshotBytes) {
      plaintext.fill(0);
      throw new Error("Authentication snapshot exceeds size limit");
    }
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce, { authTagLength: 16 });
    cipher.setAAD(this.#additionalData);
    let encrypted: Buffer;
    try {
      encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    } finally {
      plaintext.fill(0);
    }
    const temporaryPath = join(this.#directory, `${randomUUID()}.tmp`);
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(Buffer.concat([header, nonce, cipher.getAuthTag(), encrypted]));
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporaryPath, join(this.#directory, "auth.enc"));
      const directory = await open(this.#directory, constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    } finally {
      await unlink(temporaryPath).catch((error: unknown) => {
        if (!hasErrorCode(error, "ENOENT")) throw error;
      });
    }
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = (async () => {
      try { await this.#pending; } finally {
        this.#key.fill(0);
        await rmdir(join(this.#directory, "writer.lock"));
      }
    })();
    return this.#closing;
  }
}
