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
- Operator channel: digests of flagged verdicts DM'd to you, labelled by replying `CODE label`
- Natural-language group rules over DM (`rules 1234` + text), versioned with the policy and given to the classifier
- Audited group actions: live deletion of high-confidence spam and scam behind two keys and every gate; operator remove, lock, unlock, and join approval over DM

Ban or logout? Follow [the ban-recovery runbook](docs/runbooks/ban-recovery.md).

Security decisions and threat models: [session](docs/session-design.md), [storage](docs/storage-design.md), [classifier](docs/classifier-design.md), [operator channel](docs/operator-channel-design.md), [actions and live mode](docs/actions-design.md).

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

Add `--operator <your personal number>` (and optionally `--timezone`, default `Australia/Sydney`) to receive a digest of flagged messages in your WhatsApp DMs, at most every 15 minutes and never 23:00-07:00. Reply with lines like `K7P scam` or `Q2R ok` to label them; the bot reacts ✅ or ❓. Links in digests are defanged. The bot never messages anyone else.

The first run must be from an interactive terminal: it asks for the number and prints an 8-character pairing code to enter under WhatsApp > Linked devices > Link with phone number. If the process crashes, verify no worker is running before removing `.state/<session>/writer.lock`.

## Actions and live mode

Everything starts in shadow. To act:

- **Operator actions** (`--operator-actions`): reply `K7P remove` to remove the sender of a digest item, or `lock 1234`, `unlock 1234`, `approve 1234` for the allowlisted group whose ID ends in 1234. The bot must be a group admin. Admins, you, and the bot are never removed. Nothing runs in the first 5 days after the account first connects: that clock belongs to the linked WhatsApp account, so reconnecting or renaming `--session` keeps it, and pairing a different number starts a fresh one. `lock` also waits out the group's 7-day shadow period, because it silences everyone at once rather than one reviewed person; `unlock` never waits. Hourly limits per group: 10 removals, 6 lock changes, 1 approval batch of 20.
- **Automatic deletion** needs two keys. Set the group live with `pnpm policy --database-url-file <file> --group <jid> --mode live --threshold 0.97` (spam and scam only, threshold ≥ 0.9), **and** start the worker with `--live-group <jid>`. It still waits out the 7-day shadow period and account warm-up, deletes at most 5 per minute per group, and only deletes messages it saw arrive in the last 15 minutes. Pick the threshold from the bake-off (under 2% false positives).

Every attempt is written to the `actions` table before WhatsApp is contacted.

## Building the eval set and running the bake-off

```sh
pnpm label --database-url-file ~/.automod/db.url          # label stored messages in a terminal
pnpm eval --database-url-file ~/.automod/db.url --gcp-project <id> \
  --model gemini-3.1-flash-lite --input-price <usd/1M> --output-price <usd/1M>
```

`pnpm eval` prints an aggregate JSON report (accuracy, per-category precision/recall, auto-action false-positive rate at the threshold, tokens, cost, latency) with example IDs but no message text. Run it once per candidate model; the Phase 0 bar is under 2% false positives on auto-action categories.

## Next Phase 0 slices

1. Collect and label 500–1,000 real messages; run the bake-off and pick the model and threshold; turn on live mode for one group.
2. Warnings (in-group replies, second-infraction DMs) and the escalation ladder.
3. Test the ban-recovery runbook once and record it; measure cost per message on real traffic.

