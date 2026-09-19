-- Admin-written group rules, versioned with the policy. Design: docs/operator-channel-design.md.
ALTER TABLE group_policies ADD COLUMN rules text CHECK (octet_length(rules) BETWEEN 1 AND 2000);
