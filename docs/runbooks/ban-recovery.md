# Runbook: number banned or logged out

For the dedicated bot number (the eSIM line in the WhatsApp Business app).
Phase 0 exit requires this runbook to be tested once; record the date and
outcome at the bottom.

## Detect

The worker logs a `stopped` event and exits non-zero with one of:

| Reason | Meaning |
| --- | --- |
| `logged-out` | The linked device was removed, or the account was logged out or banned. |
| `forbidden` | WhatsApp refused the account; treat as a likely ban. |
| `connection-replaced` | Another session took over this linked device. Check nothing else runs with the same state. |
| `reconnect-exhausted` | Network or WhatsApp outage; not a ban. Restart later. |

Then check the phone: open **WhatsApp Business** on the eSIM line. A ban shows
a banned screen instead of chats.

## Contain (first 10 minutes)

1. Stop the worker and keep it stopped. Do not re-pair in a loop; repeated
   linking attempts from a flagged number make things worse.
2. Take every group out of live mode on the next start: drop all
   `--live-group` flags. Optionally set shadow in the store too:
   `pnpm policy --database-url-file <file> --group <jid> --mode shadow`.
3. Tell the groups' other admins that moderation is paused.
4. Note the time, the stop reason, and the last `status` line (counters only).

## Recover

**Logged out, not banned** (phone app still works):

1. On the phone: Linked devices → remove the old automod device if listed.
2. Archive, don't delete, the old state: move `.state/<session>/` aside. Keep
   the key file separate from it.
3. Create a fresh key (`umask 077; head -c 32 /dev/urandom > <key>`), start the
   worker from an interactive terminal, and re-pair with the pairing code.
4. The warm-up clock is per session ID in `linked_accounts`. Reusing the same
   `--session` keeps the original warm-up date. Use a new session ID if you
   want warm-up to restart.

**Banned:**

1. In the WhatsApp Business app, use the review request offered on the banned
   screen. Say what the account does: moderating the operator's own
   community groups as an admin.
2. While under review: leave the worker stopped and don't register the
   number anywhere else.
3. If the ban is lifted, follow "Logged out, not banned" with a **new session
   ID**, so warm-up (5 days) restarts, and keep all groups in shadow for
   another 7 days.
4. If the ban is permanent: buy a new eSIM number, register it in WhatsApp
   Business, redo warm-up (plan section 3), add it to groups one or two a
   day, and promote it to admin. Use a new `--session` ID. Old messages,
   verdicts, and labels stay in Postgres and are purged on the usual 30-day
   schedule; the eval set is kept.

## Review afterwards

- Query the action log for the 24 hours before the ban:
  `SELECT kind, status, count(*) FROM actions WHERE created_at > now() - interval '1 day' GROUP BY 1, 2;`
- Check how many digests and replies went to the operator (the `operator`
  counters in `status` lines).
- If sends or actions spiked, tighten the envelope before re-enabling live mode.

## Test log

| Date | Scenario exercised | Outcome | Follow-ups |
| --- | --- | --- | --- |
| _pending_ | Unlink the device from the phone, then re-pair with a fresh key | | |
