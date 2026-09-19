import pg from "pg";
import type { Database, Queryable } from "./database.ts";

const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Plaintext is only acceptable on this machine; anything else must verify the
 * server certificate and host name.
 */
export function assertSafeConnectionString(connectionString: string): void {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("Database URL is not a valid postgres:// URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("Database URL is not a valid postgres:// URL");
  }
  const socketHost = url.searchParams.get("host");
  const local = url.hostname === ""
    ? socketHost === null || socketHost.startsWith("/")
    : localHosts.has(url.hostname) && socketHost === null;
  if (!local && url.searchParams.get("sslmode") !== "verify-full") {
    throw new Error("Remote databases require sslmode=verify-full");
  }
}

function wrap(client: pg.Pool | pg.PoolClient): Queryable {
  return {
    query: async <Row>(text: string, params: readonly unknown[] = []) => {
      const result = await client.query(text, [...params]);
      return { rows: result.rows as Row[] };
    },
    execute: async (script) => {
      await client.query(script);
    },
  };
}

export function connectPostgres(connectionString: string): Database {
  assertSafeConnectionString(connectionString);
  const pool = new pg.Pool({
    connectionString,
    max: 4,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,
    query_timeout: 15_000,
  });
  // Idle-client errors would otherwise crash the process; the next query surfaces the failure.
  pool.on("error", () => {});
  const pooled = wrap(pool);
  return {
    ...pooled,
    async transaction(run) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await run(wrap(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
