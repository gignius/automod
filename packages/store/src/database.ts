/** The minimal query surface the store needs; implemented for pg and, in tests, PGlite. */
export interface Queryable {
  /** One parameterized statement. SQL text must be static; values go in `params`. */
  query<Row>(text: string, params?: readonly unknown[]): Promise<{ rows: Row[] }>;
  /** A trusted multi-statement script with no parameters (migrations only). */
  execute(script: string): Promise<void>;
}

export interface Database extends Queryable {
  transaction<Result>(run: (transaction: Queryable) => Promise<Result>): Promise<Result>;
  close(): Promise<void>;
}
