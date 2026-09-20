# Phase 0 group actions and live mode

Scope: the first code paths that change a WhatsApp group. Automatic deletion of
high-confidence spam and scam in groups explicitly switched to live, plus
operator commands over DM: remove a flagged message's sender, lock or unlock a
group, approve pending join requests. Every attempt is written to a durable
action log before WhatsApp is contacted.

## Gates (all must pass; any doubt refuses)

Automatic deletion (existing `GatedDeletionAdapter`, now fed live policy):

1. **Two keys for live mode:** the group's current policy in Postgres says
   `live` (set with the local `pnpm policy` tool) **and** the worker was started
   with `--live-group <jid>` for that group. Neither alone is enough, so a
   tampered database row or a stray flag cannot enable deletion.
2. The group's first policy is at least 7 days old (shadow period). `pnpm policy`
   carries the original shadow start forward and has no way to set it.
3. The account was first linked on this database at least 5 days ago (warm-up),
   recorded automatically on first connection.
4. Not within a minute of process start; the message key was observed by this
   process in the last 15 minutes; five attempts per group per minute; the bot
   is a current admin (fresh metadata lookup).
5. **Idempotent:** a `pending` row for (delete, message) is inserted first; if
   one exists the attempt is refused, so retries after a crash can never delete
   twice or burn the rate limit on replays.

Operator actions (new `GroupActionGate`):

- Only via the operator channel (same sender check as labelling). `CODE remove`
  targets the sender of a message the operator was sent; `lock/unlock/approve
  NNNN` targets an allowlisted group by the last 4 digits of its ID (refused if
  ambiguous).
- Account warm-up and startup quarantine as above; the bot must be a current
  admin; removal refuses admins, this account, and the operator; limits per
  group: 10 removals/hour, 6 lock changes/hour, 1 approval batch/hour of at
  most 20 requests.
- Operator actions do not require live mode: a human chose them. They are
  still logged and rate-limited. One exception: `lock` silences every member at
  once rather than one person the operator reviewed, so it waits out the
  group's shadow period like a deletion. `unlock` never waits.

Deferred: warnings (in-group replies and DMs), the escalation ladder,
automatic removal, and join screening. None of them exist, so none can fire.

## Action log (`actions` table)

`kind`, group, target message (if any), target sender (if any), `requested_by`
(`policy` or `operator`), status (`pending`, `succeeded`, `failed`,
`refused`), refusal reason, timestamps. It is append-only apart from
completing a pending row. Retention: the row is kept, and the target sender
is nulled 30 days after the action, like message data. The log is what
repudiation and incident review rely on; it closes the slice-1 blocker "durable
action audit/idempotency" for live mode.

## Threat model (new boundary: worker → group state)

| STRIDE | Threat → control |
| --- | --- |
| Spoofing | Forged delete target → exact observed key; forged operator → server-supplied sender address. |
| Tampering | DB row flips a group live → also needs the CLI flag; the shadow start is server-assigned and write-once, and the trigger's `search_path` is pinned so a `pg_temp` table cannot stand in for the real one. |
| Repudiation | Every attempt logged before contact, with who asked (policy or operator). |
| Disclosure | Log keeps sender IDs 30 days only; logs print counters only. |
| DoS / ban risk | Per-group rate limits; quarantine after start; one approval batch per hour; no bulk history sweeps. |
| Elevation | Classifier output can only reach deletion through the gates; it cannot remove, lock, or approve. |

Residual: a compromised operator WhatsApp account can remove non-admin members
and lock groups within the rate limits; the action log records it.

## Hardening review (2026-09-20)

Six findings from an audit of the action surface, and what was decided.

- **The warm-up clock belonged to `--session`, not to the account.** It was keyed
  on a free-form string the operator types, so re-pairing a brand-new number
  under an existing session name inherited an elapsed warm-up and could act 60
  seconds after start — the `ban-recovery` path leads straight there. The same
  refuse-list item as deriving a tenant from the request instead of the session.
  `linked_accounts` is now keyed on the linked account (its own address with the
  device suffix stripped, so re-linking the same number keeps its clock).
  Migration 008 drops the old session-keyed rows: they name no account and
  cannot be mapped to one, so the clock restarts once, which is the direction
  that refuses rather than acts.
- **Nothing checked that an "admin deletion" came from an admin.** The only test
  was deleter ≠ author, and the digest turns any such revocation into a review
  code — so whoever could get a revoke relayed to this worker chose who the
  operator was shown a removal button for, with the classifier never involved.
  `AdminVerifier` now confirms the deleter holds admin rank against current
  group metadata before anything is recorded, cached for a minute so a burst of
  revocations cannot amplify into a burst of queries. WhatsApp enforces
  admin-only revokes server-side, but that is its rule to change, not a property
  this worker can prove, and the digest is where a human's attention is aimed.
- **A completed action could be logged, and reported, as a refusal.**
  `finishAction("succeeded")` ran inside the `try`, so a write failure after the
  member was already gone returned `refused`/`failed` and wrote a row saying the
  opposite of what the group saw. The write is now a separate step: the row
  stays `pending` — outcome unknown — and the failure is surfaced through
  `onLogFailure` rather than silently inverted.
- **One transient Postgres failure latched every gate shut for the process
  lifetime.** The lookup ran only on a connection `open` event and a stable
  connection never produces a second one, so an account months past warm-up
  refused everything until a restart. `WarmupClock` retries with backoff and
  stays undefined until a real date lands, so the fix never trades stuck-closed
  for acting too early.
- **`lock` skipped the group shadow period.** Unlike a deletion it read no
  policy and checked no shadow clock, while the allowlist it consults grows at
  runtime from the community watcher — so a group admitted minutes ago could be
  silenced wholesale. Locking now waits out the same 7-day period a deletion
  does, and refuses when the group has no policy row yet. `unlock` is
  deliberately never gated: undoing a silence must always be available.
  Removal is also left ungated here, because it reaches the operator only
  through a digest item about one person they have already reviewed.
- **`shadow_started_at` was client-supplied and unconstrained.** One INSERT with
  a backdated value erased the longest gate. It is now write-once and
  server-assigned by a trigger: the first version for a group starts the clock,
  later versions inherit that instant, and an UPDATE cannot move it.

### Follow-up, same day

An adversarial review of the fixes above found four more, all fixed here.

- **The new trigger was itself defeatable with INSERT rights.** Its body named
  `group_policies` unqualified, and Postgres searches `pg_temp` first while
  granting TEMP to PUBLIC — so `CREATE TEMP TABLE group_policies` seeded with an
  old date made the trigger read the caller's table and write that date onto the
  real row. Reproduced against the real migrations before fixing. The function
  now carries `SET search_path = pg_catalog, pg_temp` and names
  `public.group_policies`; a regression test creates the temp table and asserts
  the stored value is still `now()`. The claim this section previously made —
  "defeating it needs DDL rights" — was wrong, because creating a temp table is
  not the kind of DDL right that sentence meant.
- **`AdminVerifier` cached only successes.** A failed `groupMetadata` lookup was
  never cached, so the throttle collapsed exactly when WhatsApp was rejecting
  those queries: every revocation missed the cache and issued another live one,
  a feedback loop against the single account every other limit exists to protect.
  Failures are now cached for 10s — long enough to bound the query rate, short
  enough that a real admin deletion is delayed rather than lost.
- **A dead database was reported to the operator as the seven-day wait.** A
  throwing shadow-clock lookup refused with `group-shadow-period`, which reads
  as "come back in days", and logged nothing — so an operator would stop trying
  during exactly the incident a lock is for. It now refuses `shadow-check-failed`
  and reports through `onError`. The rate-limit count one statement later used to
  throw straight out of the gate, leaving no reply at all; it now refuses too, so
  the same dead dependency cannot produce two different wrong answers.
- **Warm-up retry chains were never deduplicated.** A connection flapping during
  a database outage forked a new retry chain per `open`, multiplying the backoff
  into a burst. At most one chain now exists.

## Review record (2026-09-19)

- `pnpm test`: 129 passing. Covered:
  - Live deletion needs all three of stored `live` policy, `--live-group`, and
    a deletion path; any one alone deletes nothing.
  - The database rejects live policies outside spam/scam or below 0.9.
  - End to end on real SQL: handler → audit log → gate → revoke happens once,
    the replay is refused as already attempted, and the log shows one
    `succeeded` row.
  - Completed log rows are never rewritten, refusals don't consume rate
    limits, and targets are nulled after 30 days while the row stays.
  - Warm-up starts at the first recorded connection, and every gate refuses
    until it is known.
  - Operator gate: admins, the operator, this account, and non-members are
    never removed; warm-up, quarantine, clock, admin checks, and hourly limits
    come from the durable log; WhatsApp failures log as `failed`.
  - Operator commands resolve only sent codes and unambiguous group suffixes,
    are ignored from anyone else, and do nothing without `--operator-actions`.
- `pnpm check` clean; `pnpm audit` and `rafter secrets .` clean; the
  source-hygiene test passes.
- Not yet exercised against WhatsApp: revoke, remove, announcement mode, and
  join-request approval have only been run against fakes. The first real use
  should be one `lock`/`unlock` on a test group after warm-up.
