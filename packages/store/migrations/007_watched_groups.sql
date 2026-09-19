-- Groups added by community auto-watch, so restarts don't re-announce them.
CREATE TABLE watched_groups (
  group_jid text PRIMARY KEY CHECK (group_jid ~ '^[0-9-]{1,40}@g\.us$'),
  first_watched_at timestamptz NOT NULL DEFAULT now()
);
