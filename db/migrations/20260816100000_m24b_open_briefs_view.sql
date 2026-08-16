-- M24 Slice B — the open-briefs surface (view half). design/intake.md D7 · ADR 0023.
-- Makes the intake board visible to oversight: every intake-lane task by stage
-- (proposed_brief / briefed / accepted), newest-first, reusing api.board. Read-only,
-- oversight-only — the same view+report-line pattern as every v5 / M23 surface.
--
-- The report INTAKE LINE that turns these rows into pending/briefed/accepted counts is
-- the SWARM slice (a pure formatter + graceful fetch, substrate-free to validate — the
-- #87/#91 hands-off slice); this view stays dumb. Built ASSISTED (a DB view cannot be
-- self-validated in a worktree — the board-wipe briefing rule).
--
-- Depends on api.board (20260630 observability_views). Ordering is safe under
-- verify-down: this migration is LATER, so its down (drop open_briefs) runs BEFORE the
-- observability down that drops/recreates api.board.

-- migrate:up
create view api.open_briefs as
  select
    project, lane, stage, is_terminal, task_id, priority, blocked,
    claimed_by_family, abandoned, age_in_stage, subject, created_at, updated_at
  from api.board
  where lane = 'intake'
  order by created_at desc;

revoke all on api.open_briefs from public;
grant select on api.open_briefs to oversight;

-- migrate:down
drop view if exists api.open_briefs;
