-- Ticket body vs agent brief: a ticket records the outcome wanted and the
-- decision; the machine-facing brief an agent needs (ids, coordinates, payload
-- shapes, CLI invocations) is a DIFFERENT artifact that until now shared the
-- `description` field and made the human reading surface unreadable.
--
-- Additive and nullable by design: every existing ticket keeps its body as its
-- body. Nothing is migrated, nothing is destroyed — only future tickets split.
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "agent_brief" text;
