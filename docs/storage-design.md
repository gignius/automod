# Phase 0 storage design

Scope: Postgres persistence for observed group messages, versioned group
policies, verdicts, and admin feedback labels, plus retention purge and
per-sender erasure. One operator, one worker, one database. No endpoints, no
tenants, no classifier calls; queues (BullMQ) remain the next slice.

## Data classification and retention (Rafter secure-design)

| Table | Fields | Class | Retention |
| --- | --- | --- | --- |
| `messages` | group JID, sender JID, WhatsApp message ID, text, received time | PII (phone numbers) + member content | Hard-deleted 30 days after receipt |
| `verdicts` | category, confidence, outcome, time, policy version; model `reason` | Derived metadata; `reason` may quote content | Row kept; `reason` and message link cleared when the message is purged |
| `feedback_labels` | admin label/category on a message | Derived | Deleted with the message unless promoted to an eval example |
| `eval_examples` | text, expected category, label time | Member content, **no sender JID** | Kept for the model bake-off until explicitly deleted |
| `group_policies` | mode, categories, threshold, shadow start | Operator config | Append-only versions, kept |

- Minimization: eval examples drop the sender identity; they are the only
  content kept past 30 days. Verdict rows keep no sender or text after purge.
- Erasure: `eraseSender(senderJid)` deletes that member's messages, labels, and
  any eval examples still linked to those messages, in one transaction. Once a
  source message is purged the example is unlinked; erasing it then needs an
  explicit `deleteEvalExample(id)`. Accepted residual for Phase 0 (own groups).
- Purge: `purgeExpired()` takes no arguments. The cutoff is the database's own
  `now()` minus a fixed 30 days, deleted in batches of 1,000, so neither a bad
  argument nor a skewed worker clock can widen deletion to fresh data. The CLI
  runs it at startup and hourly.
- Encryption at rest: none at application level. The DB is inside the same
  trust boundary as the worker; rely on disk encryption of the host (FileVault
  locally, encrypted volumes on Hetzner). Backups (`pg_dump`) inherit the
  message class: keep them 30 days at most and outside the database host.
- Durable dedupe: `messages` is unique on (group, sender, message ID) with
  `ON CONFLICT DO NOTHING`, so redelivery after a restart is recognized and
  nothing is ever overwritten. This closes the slice-1 residual that in-memory
  dedupe did not survive restarts.

## Credentials and transport

- The connection string is read from an owner-only file (`--database-url-file`,
  same checks as the auth key), never from argv, and never logged. Env vars
  are not used for it.
- Non-local hosts require `sslmode=verify-full`; plaintext is accepted only for
  `localhost`, `127.0.0.1`, `::1`, or a Unix socket.
- Pool is small (max 4) with `statement_timeout` and connection timeouts so a
  stuck database cannot pin the worker.
- Phase 0 uses one role for migrations and runtime. Before multi-tenant, split
  a migration owner from a runtime role without DDL, and revoke UPDATE/DELETE
  on `group_policies` and `verdicts` from the runtime role except the purge.

## Queries and migrations

- All SQL is static text with `$n` parameters; no identifiers or fragments are
  built from input.
- Migrations are numbered `.sql` files; all pending ones apply in a single
  transaction under a Postgres advisory lock and are recorded with a SHA-256
  checksum, so a failure leaves the schema untouched. An edited or
  missing applied migration stops startup instead of drifting.

## Dependencies

- `pg` `8.23.0` (brianc/node-postgres, canonical driver, pure JS): pick, don't
  write, the wire protocol. `@types/pg` for types.
- `@electric-sql/pglite` `0.5.8` (ElectricSQL, dev only): real Postgres in
  WASM so tests run the actual migrations without a server.
- Exact pins, install scripts stay disabled, lockfile committed, `pnpm audit`
  before commit.

## Threat model

Worker → Postgres is the new boundary; the stores are the new assets.

| Boundary / store | Threats and controls |
| --- | --- |
| Worker → DB | Spoofing: credential in owner-only file; TLS verify-full off-host. Tampering: parameterized SQL only. Disclosure: DB errors are never logged (constraint errors can echo values). DoS: pool cap and statement timeout; handler failures are counted, not fatal. |
| `messages` | Disclosure: 30-day hard delete, no content logging, backups ≤ 30 days. Tampering: insert-only from the worker; duplicates never overwrite. Abuse: flooding is bounded by the session queue, 16 KB text cap, and purge. |
| `group_policies` | Tampering is the privilege risk: a DB writer could backdate shadow start or set `live`. The shipped CLI has no deletion path and does not load policies; enabling live mode must require an operator control outside the DB (future slice). |
| `verdicts` | Repudiation: append-only rows with outcome and policy version form the start of an action log; durable deletion audit and idempotency remain blockers for live mode. |

Abuse twins: a member re-sending a colliding message ID cannot overwrite
another member's row (sender is in the key); a member's erasure request removes
their content in one transaction; a mistaken purge cannot delete fresh data
because the cutoff is not an input.

Residual limits: host or DB-superuser compromise exposes up to 30 days of
content; eval examples outlive message links; single DB role until Phase 1.

## Review record (2026-09-19)

- `pnpm test`: 68 passing; store tests run the real migrations and SQL on
  PGlite (Postgres 18.3 in WASM). PGlite is single-connection, so concurrent
  policy appends are checked for dense versions but not for lock contention.
- `pnpm check` clean; `pnpm audit`: no known vulnerabilities; `rafter secrets .`: none.
- Rafter walk: no SQL built from runtime values (the one template is a constant
  concatenation); CLI logs only our own URL-check messages and SQLSTATE/errno
  codes, never driver messages, URLs, or row values; the database URL comes
  from an owner-only file and plaintext is refused off-host.
- Remote `rafter run` on the pushed slice 1 (`check` @ 078bd35): 2 "Unsafe
  Regular Expression" warnings on the JID patterns, triaged as false positives
  (anchored, bounded, no nesting; 1 MB adversarial input < 0.3 ms) and
  suppressed in `.rafter.yml` with that evidence. Rescan after pushing this slice.
- Known gap: a failed `saveMessage` is counted as a handler error and the
  message is not retried (it is already in the in-memory dedupe cache). Durable
  delivery arrives with the queue slice. The CLI's database path is verified for
  setup failures only; nothing has run against a live Postgres server yet.
