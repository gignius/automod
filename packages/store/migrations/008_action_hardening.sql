-- Hardening of the two gates a single INSERT could previously defeat.
--
-- 1. The warm-up clock belonged to the operator-chosen --session string, so
--    re-pairing a brand-new number under an existing session id inherited that
--    session's elapsed warm-up and could act 60 seconds after start. It now
--    belongs to the linked WhatsApp account. Existing rows name a session, not
--    an account, and cannot be mapped to one, so they are dropped: the clock
--    restarts once, which is the fail-closed direction.
--
-- 2. group_policies.shadow_started_at was client-supplied and unconstrained, so
--    one backdated INSERT erased the 7-day group shadow period. It is now
--    server-assigned: the first policy row for a group starts the clock, every
--    later version inherits that same instant, and the value the client sends
--    is ignored. Defeating it now needs rights over this function or the
--    trigger, not a plain INSERT.
--
-- Design: docs/actions-design.md.

DROP TABLE linked_accounts;

CREATE TABLE linked_accounts (
  -- The account with its device suffix stripped, as normalizeAccountId writes
  -- it, so re-linking the same number keeps its clock and a different number
  -- never inherits one.
  account_id text PRIMARY KEY CHECK (account_id ~ '^\d{1,20}@(s\.whatsapp\.net|lid)$'),
  -- Kept for the operator's own audit trail; it never decides the clock.
  session_id text NOT NULL CHECK (session_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  first_connected_at timestamptz NOT NULL DEFAULT now()
);

-- Write-once per group, server-assigned: the first version starts the clock,
-- later versions inherit that instant, and an UPDATE cannot move it. Whatever
-- value the client sends is discarded in every case.
--
-- `search_path` is pinned and the table is schema-qualified because Postgres
-- searches pg_temp first for an unqualified relation, and TEMP is granted to
-- PUBLIC by default: without this, `CREATE TEMP TABLE group_policies` seeded
-- with an old date makes this lookup read the caller's table and write that
-- date onto the real row — the whole gate defeated with INSERT rights alone.
CREATE FUNCTION pin_group_shadow_start() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  started timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.shadow_started_at := OLD.shadow_started_at;
    RETURN NEW;
  END IF;
  SELECT shadow_started_at INTO started FROM public.group_policies
    WHERE group_jid = NEW.group_jid ORDER BY version LIMIT 1;
  NEW.shadow_started_at := COALESCE(started, now());
  RETURN NEW;
END;
$$;

CREATE TRIGGER group_policies_pin_shadow_start BEFORE INSERT OR UPDATE ON group_policies
  FOR EACH ROW EXECUTE FUNCTION pin_group_shadow_start();
