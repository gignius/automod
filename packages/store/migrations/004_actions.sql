-- Durable action log and account warm-up record. Design: docs/actions-design.md.

CREATE TABLE actions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('delete', 'remove', 'lock', 'unlock', 'approve')),
  group_jid text NOT NULL CHECK (group_jid ~ '^[0-9-]{1,40}@g\.us$'),
  message_row_id bigint REFERENCES messages (id) ON DELETE SET NULL,
  -- WhatsApp message ID, kept after the message row is purged so replays stay idempotent.
  message_id text CHECK (message_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  target_jid text,
  requested_by text NOT NULL CHECK (requested_by IN ('policy', 'operator')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed', 'refused')),
  refusal text CHECK (refusal ~ '^[a-z-]{1,40}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
-- At most one deletion attempt per message, ever.
CREATE UNIQUE INDEX actions_one_delete_per_message ON actions (group_jid, target_jid, message_id)
  WHERE kind = 'delete';
CREATE INDEX actions_recent ON actions (group_jid, kind, created_at);

CREATE TABLE linked_accounts (
  session_id text PRIMARY KEY CHECK (session_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  first_connected_at timestamptz NOT NULL DEFAULT now()
);

-- Live mode may only auto-act on high-confidence spam and scam.
ALTER TABLE group_policies ADD CONSTRAINT live_policies_are_narrow CHECK (
  mode = 'shadow' OR (
    minimum_auto_action_confidence >= 0.9
    AND auto_action_categories <@ ARRAY['spam', 'scam']::text[]
    AND cardinality(auto_action_categories) > 0
  )
);
