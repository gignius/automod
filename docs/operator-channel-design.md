# Phase 0 operator channel: verdict digests and reply-to-label

Scope: the bot DMs the operator a periodic digest of flagged shadow verdicts,
and the operator labels them by replying with short codes. Labels feed the
eval set. This is the bot's first outbound traffic and first command input.
It sends only to the operator, never to members or groups.

## Flow

```
verdicts (Postgres) → digest builder → bot account ┆→ operator's WhatsApp (DM)
operator reply "K7P scam" ┆→ bot account → operator filter → command parser → labelMessage
```

## Decisions (Rafter secure-design)

- **Identity (who may command):** a small set of operators, each needing **two
  keys** — a row in the `operators` table (migration 009) *and* their number
  passed as `--operator` at startup. A row alone is a record, not a grant, so
  write access to Postgres cannot mint an operator who can remove members; a
  flag alone matches nobody on record, so a mistyped number is inert rather
  than aimed at a stranger. Authorisation therefore still comes from startup
  configuration, never from anything a message or a runtime row can influence.
  A DM is a command only if it is a one-to-one chat,
  not from this account, and the sender's address, either the chat JID or the
  server-supplied alternate address (`remoteJidAlt`, set by WhatsApp from the
  authenticated stanza, not by the sender), matches one of those operators.
  Groups, broadcasts, statuses, and other contacts are ignored without a reply.
  Operators share one review queue: each is sent the same codes, whoever
  answers first acts, and a duplicate reply is refused as `not-member` rather
  than acting twice. The action log names whoever asked, by label. The
  operator number must differ from the bot's own.
- **Authorization (what commands can do):** only label a message that was put
  in a digest sent to the operator, identified by a 3-character code from an
  unambiguous 32-symbol alphabet (no 0, 1, I, or O). No command changes policy, mode, allowlists,
  or sends to anyone else. Natural-language rules are a later slice.
- **Parsing:** strict line grammar, `<code> <label>` with label in
  `allowed|ok|spam|scam|abuse|other`; up to 20 lines per message; text over
  2 KB is ignored. Unknown lines are counted and ignored.
- **Codes:** random per digest item from a CSPRNG, unique among open items;
  items expire 7 days after sending and go with their message at the 30-day
  purge. A code only resolves if it was actually sent.
- **Outbound envelope (ban risk):** at most one digest per 15 minutes, 20
  digests and 60 reactions per day, none during quiet hours (23:00–07:00 in the
  operator's time zone), a random 2–8 s delay with a composing indicator before
  each digest, and no link previews. Label replies get an emoji reaction, not a
  text reply, so a chatty operator can't make the bot talk a lot.
- **Content in the digest:** flagged message text, truncated to 280
  characters, with URLs defanged (`hxxps://example[.]com`) so a scam link
  can't be tapped from the digest. It has no sender numbers and no model reasons,
  and each group is identified only by the last 4 digits of its ID. The
  digest leaves our 30-day retention once delivered: it lives on in the
  operator's WhatsApp history, which is the operator's responsibility.
- **Logging:** counters only (digests sent, items, labels applied, ignored
  commands, refused sends). Never command text, codes, or phone numbers.

## Threat model (new boundaries: operator ⇄ bot)

| STRIDE | Threat → control |
| --- | --- |
| Spoofing | A member DMs "K7P allowed" to poison labels → sender must be the configured operator by server-supplied address; others ignored. |
| Tampering | Guessing codes → only codes actually sent to the operator resolve; operator-only anyway. |
| Repudiation | Labels record time; review items record when they were sent and labelled. |
| Disclosure | Member text copied to each operator's phone → truncated, no sender, links defanged; every extra operator is one more copy, so the set is kept small and explicit. Strike counts say how often a sender was flagged without naming them. |
| DoS / ban risk | Bot flooding the operator, or reply loops → digest interval and daily caps, reactions not replies, quiet hours, no replies to non-operators. |
| Elevation | Commands can only label items the operator was shown; no policy or action surface. |

Abuse twins: a member who learns a code still cannot use it (wrong sender); a
flood of flagged messages produces at most 10 items per digest and one digest
per 15 minutes, with "+N more" instead of more sends; a compromised operator
phone can mislabel the eval set, but it can't make the bot act.

Residual: a compromised operator WhatsApp account can poison labels (the eval
set is reviewable in `pnpm label`); digests persist on the operator's phone.

## Review record (2026-09-19)

- `pnpm test`: 111 passing. Covered: only the operator (by chat JID or the
  server-supplied alternate) can label, and others get no reply, even with a
  valid code; an operator LID with no phone-number alternate is ignored
  (fails closed); codes resolve only after being sent and expire after 7 days;
  strict command grammar (ambiguous characters, extra words, and over 20 lines
  are rejected); digests carry no sender, defanged links, no control or bidi
  characters, and truncation; interval, daily caps, quiet hours in the
  operator's zone, never messaging itself; failed sends stay unsent; DMs never
  enter moderation or become deletion targets.
- `pnpm check` clean; `pnpm audit`: no known vulnerabilities; `rafter secrets .`: none.
- Remote `rafter run` on slice 4 (`check` @ 77de412) found a **real** issue:
  the file-writing tool had decoded `\u` escapes in `terminal-text.ts` into raw
  control and bidi characters (a trojan-source pattern). Rewritten with ASCII
  escapes, and a new `source-hygiene` test fails the suite if any source,
  migration, or doc file contains such characters (verified to catch the bad
  version). The same scan's reflected-XSS warnings on the CLIs are false
  positives (stdout writes, no HTTP server) and are triaged in `.rafter.yml`.
- Not yet verified on a real account: that WhatsApp supplies the operator's
  phone-number address (`remoteJidAlt`) on DMs addressed by LID. If it does
  not, labels are ignored rather than accepted from the wrong person.

## Natural-language group rules

- `rules NNNN` followed by the rules on the next lines sets that group's rules;
  `rules NNNN` alone shows them; `rules NNNN clear` removes them. Same
  `pnpm policy --rules-file` / `--clear-rules` locally. Up to 2,000 bytes.
- Each change appends a policy version (audit trail), and mode, categories,
  threshold, and the shadow start are carried forward unchanged.
- The rules go into that group's classifier instruction inside a
  `<group_rules>` fence, with control and bidi characters stripped and any
  closing fence removed. The instruction says rules cannot change the
  categories or output format; the output is still schema-validated.
- Rules only shape classification. Violations map to `other` unless a more
  specific category fits, and live deletion stays limited to spam and scam at
  confidence of 0.9 or more with every gate, so a rule alone can't make the bot
  delete a new kind of message.
- Threat: a compromised operator account can write rules that skew verdicts.
  It is bounded by the same live-mode limits, and every version is kept in
  `group_policies`.

## Watching admin deletions

- When a group admin deletes someone else's message, WhatsApp sends a revoke
  (protocol message type REVOKE) whose sender differs from the original
  author. automod records these for allowlisted groups in `admin_deletions`:
  group, message ID, the admin's JID, time, and a link to the stored message
  when this worker saw it arrive. Self-deletions and this account's own
  deletions are ignored.
- Deleted messages always go into the next digest as "deleted by an admin",
  with the model's verdict if any, so the operator can label them. That puts
  human moderation decisions into the eval set, including cases the model
  rated as fine.
- Retention: rows are deleted after 30 days (and with their message at the
  message purge). The admin's JID is kept only for that period. Logs carry
  only the `adminDeletions` counter.
- Limits: only live deletions seen while the worker is connected are
  recorded. The text is only available if the message arrived while the
  worker was running and was plain text. Revokes do not say which admin role
  the deleter holds; any non-author deletion in a group is by an admin.

## Community auto-watch

- `--community <parent group ID>` watches every **member group** of that
  WhatsApp Community once the number is in it, checked on connect and every
  5 minutes. Group names are never used, so naming a group "…Haus" does
  nothing. Only community admins can add groups to the community, and group
  admins decide whether the number is admitted.
- New groups start in shadow (a default shadow policy is created on first
  message); live deletion still needs that group listed in `--live-group`.
  The operator gets one "Now watching …" DM per group, within the reply cap.
- The announcements group (admin-only posting) and the parent are skipped.
- Removing a group from watching needs a restart without it (and leaving the
  group, or removing it from the community).
