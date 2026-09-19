import { PGlite, type Transaction } from "@electric-sql/pglite";
import type { Database, Queryable } from "./database.ts";

function wrap(client: PGlite | Transaction): Queryable {
  return {
    query: async <Row>(text: string, params: readonly unknown[] = []) => {
      const result = await client.query<Row>(text, [...params]);
      return { rows: result.rows };
    },
    execute: async (script) => {
      await client.exec(script);
    },
  };
}

/** In-process Postgres (WASM) so tests exercise the real migrations and SQL. */
export async function createTestDatabase(): Promise<Database & { raw: PGlite }> {
  const raw = await PGlite.create();
  return {
    ...wrap(raw),
    raw,
    transaction: (run) => raw.transaction((transaction) => run(wrap(transaction))),
    close: () => raw.close(),
  };
}
