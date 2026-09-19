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

See [docs/session-design.md](docs/session-design.md) and [docs/storage-design.md](docs/storage-design.md) for the security decisions and threat models.

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

The first run must be from an interactive terminal: it asks for the number and prints an 8-character pairing code to enter under WhatsApp > Linked devices > Link with phone number. If the process crashes, verify no worker is running before removing `.state/<session>/writer.lock`.

## Next Phase 0 slices

1. Add Redis/BullMQ ingestion with per-number ordering and limits (durable delivery).
2. Build the labelled-message evaluation harness and model bake-off.

