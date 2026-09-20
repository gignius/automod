-- More than one person may now operate the bot.
--
-- Two keys, the same shape live deletion already uses: a row here records who
-- an operator IS, and --operator at startup grants the power. A row alone
-- grants nothing, so write access to this database cannot make someone an
-- operator and hand them the ability to remove members; a flag alone matches
-- nobody, so a mistyped number is inert rather than aimed at a stranger.
--
-- Design: docs/operator-channel-design.md.

CREATE TABLE operators (
  phone text PRIMARY KEY CHECK (phone ~ '^[1-9][0-9]{7,14}$'),
  -- A stable short name. The action log stores this rather than the number, so
  -- attribution never spreads a phone number into another table.
  label text NOT NULL UNIQUE CHECK (label ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  added_at timestamptz NOT NULL DEFAULT now()
);

-- Which operator asked for an action. 'operator' alone stopped identifying a
-- person the moment a second one existed. Null for policy-driven actions and
-- for rows written before this migration.
ALTER TABLE actions ADD COLUMN actor text CHECK (actor ~ '^[a-z0-9][a-z0-9-]{0,31}$');

-- A policy-driven action can never name an operator. The reverse is deliberately
-- not enforced: operator rows written before this migration have no actor, and
-- a NOT NULL check here would refuse to validate them and fail the migration on
-- any database that has already logged one. New operator actions always carry an
-- actor because GroupActionGate requires it in TypeScript.
ALTER TABLE actions ADD CONSTRAINT actions_policy_actions_have_no_actor CHECK (
  requested_by = 'operator' OR actor IS NULL
);
