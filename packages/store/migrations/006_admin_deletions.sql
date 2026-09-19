-- Messages a human group admin deleted (a revoke by someone other than the author).
-- A strong labelling signal; see docs/operator-channel-design.md. Kept 30 days.
CREATE TABLE admin_deletions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_jid text NOT NULL CHECK (group_jid ~ '^[0-9-]{1,40}@g\.us$'),
  message_id text NOT NULL CHECK (message_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  -- The stored message, when this worker saw it arrive.
  message_row_id bigint REFERENCES messages (id) ON DELETE CASCADE,
  deleted_by_jid text NOT NULL CHECK (deleted_by_jid ~ '^\d{1,20}(:\d{1,5})?@(s\.whatsapp\.net|lid)$'),
  deleted_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_jid, message_id)
);
CREATE INDEX admin_deletions_message ON admin_deletions (message_row_id);
