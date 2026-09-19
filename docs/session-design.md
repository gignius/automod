# Phase 0 session design

Scope: one operator-owned WhatsApp number per process, canonical Baileys adapter,
pairing-code callbacks, encrypted local authentication state, and bounded live
text ingestion. Postgres message/verdict persistence remains the next slice.

## Security decisions (Rafter secure-design)

- Identity: the operator links their own dedicated account using WhatsApp's
  linked-device pairing flow. No web login, passwords, JWTs, or public endpoints
  exist here. The local OS user controls the process. Pairing codes go only to an
  explicit callback; the CLI requires an interactive terminal to show one.
- Authorization: a trusted group allowlist controls ingestion. Deletion requires
  explicit live policy, five elapsed days of account warm-up, seven elapsed days
  of group shadow observation, current bot admin membership, and an exact recently
  observed message key. The shipped CLI configures shadow mode exclusively.
  Classifier output cannot authorize groups or change the mode.
- Credentials: Baileys credentials and Signal keys are account-takeover secrets.
  Node's AES-256-GCM encrypts a single versioned snapshot, with a fresh 96-bit
  nonce per write and session identity bound as authenticated data. An operator
  supplies a separate 32-byte key file (owner-only permissions, outside the state
  directory); keys are never generated as a fallback or printed by the worker.
  Production secret-manager distribution and envelope key rotation are deferred
  until deployment. Local key rotation means stop, revoke the linked device,
  archive/remove its encrypted state, supply a fresh key, and explicitly re-pair.
- Storage: owner-only session directories and files, atomic rename after fsync,
  serialized writes, and exclusive session locks prevent concurrent writers.
  Refuse symlinks, oversized snapshots, wrong keys, and corrupt state; only a
  genuinely missing snapshot creates new credentials. Crash-stale locks require
  operator verification before removal. This is a local single-host store, not
  a multi-tenant database. The key must not be backed up with the ciphertext.
- Retention: credentials last until device revocation/re-pairing. The operator
  removes old snapshots and backups after revocation; no automatic recursive
  deletion. Message text lives only in bounded transient memory; CLI logs contain
  status and aggregate counts, never message bodies, phone numbers, auth objects,
  QR data, raw errors, or pairing codes. The interactive pairing display is the
  only deliberate secret disclosure, directly to the operator.
- Ingestion: upstream protobuf decoding is followed by checks on group/sender
  JIDs, IDs, timestamps, text size, allowlisting, and event type. Ignore historical
  batches, own messages, DMs, statuses, view-once/media/control messages, and old
  timestamps. No media downloads, URL fetches, or user-controlled paths. A bounded
  recent-message cache suppresses duplicate deliveries; overload stops the worker.
- Dependency: use `@whiskeysockets/baileys` exactly `7.0.0-rc14` from
  [WhiskeySockets](https://github.com/WhiskeySockets/Baileys/releases/tag/v7.0.0-rc14),
  confirmed against npm metadata. It is an upstream release candidate, not proven
  stable for this project. Persist credentials and Signal keys per the
  [upstream guidance](https://github.com/WhiskeySockets/Baileys#saving--restoring-sessions).
  Disable install scripts, commit the integrity lockfile, audit dependencies, and
  test upgrades before changing the pin. Reuse upstream BufferJSON/protobuf for
  auth serialization, Node crypto for encryption, and pino with logging disabled.
- Transport: Baileys owns authenticated WhatsApp transport with normal certificate
  validation. No custom TLS weakening, inbound servers, service-to-service calls,
  external LLM calls, billing, or remote telemetry are introduced.

## Threat model

Operator/key file → worker → encrypted snapshot is the local credential boundary.
WhatsApp → Baileys → normalized messages → trusted callback is the content boundary.
Policy + recent message + fresh group metadata → deletion is the action boundary.

| Boundary | Threats and controls |
| --- | --- |
| Local credentials | Spoofing: pairing proof; tampering: GCM/session binding; disclosure: separate key and restricted files; DoS: size cap and exclusive lock; privilege: trusted operator paths only. Host-user compromise remains out of scope. |
| Network content | Spoofing: require group participant IDs; tampering: upstream protocol plus bounded parsing; disclosure: no content logging; DoS: bounded queue/cache; privilege: no input can change policy or invoke arbitrary tools. |
| Actions | Spoofing/tampering: require the observed message key and a current admin lookup; DoS/abuse: five attempted deletions per minute per group; privilege: warm-up/shadow/live gates. Repudiation remains a blocker for deploying live mode until durable action audit/idempotency exists. |

Abuse twins: pairing another account is limited to the trusted operator; replacing
or copying auth snapshots fails authentication; replaying history does not enqueue
moderation; forging a delete target fails exact-message matching; flooding group
messages stops ingestion before memory grows without bound.

Residual limits: host compromise can read process secrets; upstream protocol bugs
and account disconnection remain possible; message delivery is not durable until
the Postgres/queue slices; in-memory deduplication does not survive restarts.
Deletion is quarantined for the first minute after process startup, and the CLI
does not enable it. Logout stops reconnection and requires operator intervention.
Transient disconnects use bounded backoff; persistence failure stops the session.

## Review gate

Run focused tests, strict type checking, dependency audit, local secret scan, and
Rafter's CWE/LLM review. `rafter run` scans a remote Git ref, so it cannot certify
these uncommitted workspace changes. Record the scan result and this limitation
in the handoff; do not publish a branch solely to make a scan possible.

### Review record (2026-09-19)

- `pnpm test`: 50 passing, covering auth-state, ingestion, cache, deletion gate, and session.
- `pnpm check`: strict type check clean. `pnpm audit --prod`: no known vulnerabilities.
- `rafter secrets .`: no secrets detected.
- Rafter CWE Top 25 walk over `packages/whatsapp/src`: one finding fixed. The
  key-outside-state-dir check now canonicalizes through the nearest existing
  ancestor, so a symlinked parent cannot hide a key inside a not-yet-created
  state directory. No prototype-pollution sinks on untrusted input, all input
  regexes are anchored and bounded, queues/caches/snapshots are size-capped, and
  logs carry only typed status events and counts.
- `rafter run` not executed: it scans a remote Git ref and this slice is uncommitted.
  Run it once the branch is pushed.
