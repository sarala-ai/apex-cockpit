-- The front door to a lifecycle.
--
-- Three lifecycle pipelines have been seeded since 0170/0171 (`bug`,
-- `design-change`, `feature`, each carrying its `ticket_type`), and until now
-- nothing on the board could travel one: a ticket had no way to say what KIND
-- of work it is, so no ticket could be matched to a process. This column is
-- that statement, and the join key: a ticket enters the pipeline whose
-- `pipelines.ticket_type` equals its own.
--
-- NULLABLE, WITH NO DEFAULT — deliberately, and this is the load-bearing
-- choice. Backfilling every existing ticket to 'chore' would be inventing a
-- claim nobody made; "this ticket's author never declared a type" and "this
-- ticket is a chore" are different facts and the board must be able to show
-- the difference. Every row that exists today therefore stays untyped, and
-- surfaces render that as untyped rather than as a default.
--
-- 'chore' IS a legal value here and matches no pipeline, on purpose. See
-- TICKET_TYPES in packages/shared/src/constants.ts and the note on
-- LIFECYCLE_DEFINITIONS: a sequence with no agent step and no gate should not
-- be a process, but it is still a kind of work a person files.
--
-- The value is NOT constrained to an enum in the database. `pipelines.
-- ticket_type` is a free text column, and a check constraint here would make
-- adding a lifecycle a schema migration rather than a seeded row — which is
-- exactly the coupling the pipeline-as-data model exists to avoid. The
-- application validates against TICKET_TYPES at the edge (createIssueSchema).

alter table "issues" add column if not exists "ticket_type" text;

-- Board queries filter by type within a company ("show me open bugs"), and the
-- lifecycle backfill/report queries group by it. Partial: an index over the
-- untyped majority would be mostly dead weight on write.
create index if not exists "issues_company_ticket_type_idx"
  on "issues" ("company_id", "ticket_type")
  where "ticket_type" is not null;
