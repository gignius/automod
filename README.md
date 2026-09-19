# Automod

Safety-first WhatsApp community moderation. The current repository stage is Phase 0: prove the moderation behaviour envelope on one dedicated number before building multi-tenant onboarding.

## Current slice

- Provider-neutral classification contract
- Shadow mode that records verdicts without taking WhatsApp actions
- Confidence-gated live moderation
- Per-group deletion limiting (five deletions per rolling minute)
- WhatsApp adapter boundary so the protocol client can be replaced
- Canonical Baileys session (pinned `7.0.0-rc14`) with pairing-code linking and bounded live text ingestion
- AES-256-GCM encrypted auth-state persistence with an operator-supplied key
- Independent deletion gate: warm-up, group shadow period, startup quarantine, admin check, observed-message keys
- Postgres storage for messages (30-day retention), versioned policies, verdicts, feedback labels, and a sender-free eval set
- Durable Postgres inbox: per-group ordering, leases, retries with backoff, dead-lettering; survives restarts
- Shadow-mode classifier on Vertex AI (`gemini-3.1-flash-lite`), a labelling tool, and an evaluation harness for the model bake-off

Security decisions and threat models: [session](docs/session-design.md), [storage](docs/storage-design.md), [classifier](docs/classifier-design.md).

## Commands

```sh
pnpm install
pnpm test
pnpm check
```

## Running the Phase 0 observer

The session CLI links one dedicated number and ingests allowlisted groups. It has no deletion path, so it only ever runs in shadow; logs are status and aggregate counts.

```sh
# Key lives outside the state directory and is never backed up with it.
(umask 077; mkdir -p ~/.automod && head -c 32 /dev/urandom > ~/.automod/main.key)

pnpm session --state-dir .state --session main --key-file ~/.automod/main.key \
  --group 120363000000000000@g.us
```

To store observed messages, add `--database-url-file <file>`: an owner-only file containing a `postgres://` URL. Plaintext connections are allowed only to this machine; remote hosts need `sslmode=verify-full`. Migrations run at startup, and messages are purged 30 days after receipt.

To classify in shadow mode, also pass `--gcp-project <id>` (Vertex AI enabled; authenticate with `gcloud auth application-default login`). Verdicts are recorded and nothing is ever deleted. Member text is sent to Google, which offers this model only on `global`, `us`, or `eu` endpoints, so it is processed outside Australia.

The first run must be from an interactive terminal: it asks for the number and prints an 8-character pairing code to enter under WhatsApp > Linked devices > Link with phone number. If the process crashes, verify no worker is running before removing `.state/<session>/writer.lock`.

## Building the eval set and running the bake-off

```sh
pnpm label --database-url-file ~/.automod/db.url          # label stored messages in a terminal
pnpm eval --database-url-file ~/.automod/db.url --gcp-project <id> \
  --model gemini-3.1-flash-lite --input-price <usd/1M> --output-price <usd/1M>
```

`pnpm eval` prints an aggregate JSON report (accuracy, per-category precision/recall, auto-action false-positive rate at the threshold, tokens, cost, latency) with example IDs but no message text. Run it once per candidate model; the Phase 0 bar is under 2% false positives on auto-action categories.

## Next Phase 0 slices

1. Collect and label 500–1,000 real messages; run the bake-off and pick the model and threshold.
2. Send shadow verdicts to the operator's DM, with a reply-to-label teach loop.
3. Group actions behind the deletion gate: delete, remove, join approval, lockdown; then live mode for high-confidence spam and scam.

