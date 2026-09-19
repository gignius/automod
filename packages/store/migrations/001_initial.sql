-- Phase 0 schema. Retention and classification: docs/storage-design.md.

CREATE TABLE group_policies (
  group_jid text NOT NULL CHECK (group_jid ~ '^[0-9-]{1,40}@g\.us$'),
  version integer NOT NULL CHECK (version > 0),
  mode text NOT NULL CHECK (mode IN ('shadow', 'live')),
  auto_action_categories text[] NOT NULL
    CHECK (auto_action_categories <@ ARRAY['spam', 'scam', 'abuse', 'other']::text[]),
  minimum_auto_action_confidence double precision NOT NULL
    CHECK (minimum_auto_action_confidence BETWEEN 0 AND 1),
  shadow_started_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_jid, version)
);

-- Member content and phone-number identifiers: hard-deleted 30 days after receipt.
CREATE TABLE messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_jid text NOT NULL CHECK (group_jid ~ '^[0-9-]{1,40}@g\.us$'),
  sender_jid text NOT NULL CHECK (sender_jid ~ '^\d{1,20}(:\d{1,5})?@(s\.whatsapp\.net|lid)$'),
  message_id text NOT NULL CHECK (message_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  text text NOT NULL CHECK (octet_length(text) BETWEEN 1 AND 16384),
  received_at timestamptz NOT NULL,
  stored_at timestamptz NOT NULL DEFAULT now(),
  -- The sender is part of the key so one member can never collide with another's message.
  UNIQUE (group_jid, sender_jid, message_id)
);
CREATE INDEX messages_received_at ON messages (received_at);
CREATE INDEX messages_sender_jid ON messages (sender_jid);

-- Kept after the message is purged, minus the reason (which may quote content).
CREATE TABLE verdicts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_row_id bigint REFERENCES messages (id) ON DELETE SET NULL,
  group_jid text NOT NULL,
  policy_version integer NOT NULL CHECK (policy_version > 0),
  category text NOT NULL CHECK (category IN ('allowed', 'spam', 'scam', 'abuse', 'other')),
  confidence double precision NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  reason text CHECK (octet_length(reason) <= 4096),
  outcome text NOT NULL
    CHECK (outcome IN ('allowed', 'shadowed', 'deleted', 'delete-failed', 'rate-limited')),
  decided_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX verdicts_one_per_message ON verdicts (message_row_id)
  WHERE message_row_id IS NOT NULL;

-- The admin's correction for one message; goes with the message.
CREATE TABLE feedback_labels (
  message_row_id bigint PRIMARY KEY REFERENCES messages (id) ON DELETE CASCADE,
  expected_category text NOT NULL
    CHECK (expected_category IN ('allowed', 'spam', 'scam', 'abuse', 'other')),
  labelled_at timestamptz NOT NULL
);

-- Labelled text kept for the model bake-off. Deliberately stores no sender.
CREATE TABLE eval_examples (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_message_row_id bigint UNIQUE REFERENCES messages (id) ON DELETE SET NULL,
  group_jid text NOT NULL,
  text text NOT NULL CHECK (octet_length(text) BETWEEN 1 AND 16384),
  expected_category text NOT NULL
    CHECK (expected_category IN ('allowed', 'spam', 'scam', 'abuse', 'other')),
  labelled_at timestamptz NOT NULL
);
