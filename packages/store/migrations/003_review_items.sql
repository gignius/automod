-- Flagged messages sent to the operator for labelling. Design: docs/operator-channel-design.md.
CREATE TABLE review_items (
  code text PRIMARY KEY CHECK (code ~ '^[2-9A-HJ-NP-Z]{3}$'),
  message_row_id bigint NOT NULL UNIQUE REFERENCES messages (id) ON DELETE CASCADE,
  sent_at timestamptz,
  labelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_items_open ON review_items (sent_at) WHERE labelled_at IS NULL;
