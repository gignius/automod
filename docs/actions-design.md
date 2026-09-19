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
  still logged and rate-limited.

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
| Tampering | DB row flips a group live → also needs the CLI flag; backdated shadow start → residual (needs DB write access). |
| Repudiation | Every attempt logged before contact, with who asked (policy or operator). |
| Disclosure | Log keeps sender IDs 30 days only; logs print counters only. |
| DoS / ban risk | Per-group rate limits; quarantine after start; one approval batch per hour; no bulk history sweeps. |
| Elevation | Classifier output can only reach deletion through the gates; it cannot remove, lock, or approve. |

Residual: a compromised operator WhatsApp account can remove non-admin members
and lock groups within the rate limits; the action log records it.

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
