-- Durable inbox: a stored message stays pending until its handler succeeds.
-- Design: docs/storage-design.md ("Durable inbox").

ALTER TABLE messages
  ADD COLUMN processed_at timestamptz,
  ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN lease_until timestamptz,
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN dead_at timestamptz;

-- Messages stored before the inbox existed were already observed; never replay them.
UPDATE messages SET processed_at = stored_at;

CREATE INDEX messages_inbox ON messages (group_jid, received_at, id)
  WHERE processed_at IS NULL AND dead_at IS NULL;
