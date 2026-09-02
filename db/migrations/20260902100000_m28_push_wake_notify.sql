-- M28 Slice A (v7.2 · ADR 0027 · design/precise-service.md D4/D5): the board fires a
-- TRUTH-FREE wake NUDGE on app.tasks, so a standing supervisor can LISTEN and wake the
-- instant something could become claimable, instead of waiting out the interval poll.
--
-- The cost this exists to remove: the supervisor (loop/service.sh) wakes only on an
-- interval poll (LOOP_IDLE_POLL_SECS, default 15s), so work posted one second after a tick
-- waits nearly a full interval before anyone looks. ADR 0027 fixes that with Postgres
-- LISTEN/NOTIFY: the board fires a notification, the supervisor wakes at once, and the poll
-- STAYS as a permanent backstop.
--
-- What this is — and what it is NOT. This is a transient SIGNAL, not coordination truth.
-- It persists nothing, coordinates nothing, decides nothing. The board remains the only
-- source of truth; correctness must survive this notification being lost entirely, which is
-- exactly what the interval poll backstop is for. A notification that never arrives only
-- costs latency, never correctness.
--
-- This is ADR 0027's OWNED exception to ADR 0024's "~zero substrate change" rule. ADR 0024
-- keeps the substrate minimal and the service in charge; a wake nudge is the one deliberate,
-- bounded crossing, and it is justified because it adds no truth and no state. The bright
-- line still holds: a *truth* migration — one that persisted, decided, or coordinated — would
-- be the stop-and-rethink signal that ADR 0024 exists to raise.
--
-- FIRING RULE (decided, do not widen): it fires on INSERT of a task, or on an UPDATE that
-- changes `stage` or `blocked` — i.e. every write that can create claimable work (a new
-- task, an advance, an unblock, an accepted intake brief). Nothing else. The payload is the
-- LANE KEY, minimal and informational.
--
-- DELIBERATE GAP — PRESERVED, NOT WIDENED: a task that becomes claimable because a lease
-- EXPIRED (lazy reclaim, ADR 0009) writes no row, so no notification fires; the same is true
-- of a plain `release` (which clears claimed_by without changing stage). ADR 0027 names this
-- limit explicitly, and it is exactly why the interval poll remains permanent. The trigger
-- must NOT cover claimed_by or lease_expires_at — that would reopen a decided contract and
-- would also fire on every heartbeat.
--
-- Fail-safe (same rule as the M21 strike trigger): the notify is wrapped so any error is
-- swallowed — a wake NUDGE must never fail the legitimate task write that triggered it.

-- migrate:up
create function app.notify_activity() returns trigger
  language plpgsql
  security definer
  set search_path = app, pg_temp
  as $$
  declare v_lane text;
  begin
    begin
      select l.key into v_lane from app.lanes l where l.id = new.lane_id;
      perform pg_notify('ainarres_activity', coalesce(v_lane, ''));
    exception when others then
      null;  -- a wake NUDGE must never fail the task write that triggered it
    end;
    return null;   -- AFTER trigger: the return value is ignored
  end;
  $$;
revoke execute on function app.notify_activity() from public;

create trigger tasks_notify_activity_insert
  after insert on app.tasks
  for each row execute function app.notify_activity();

create trigger tasks_notify_activity_update
  after update on app.tasks
  for each row
  when (new.stage is distinct from old.stage or new.blocked is distinct from old.blocked)
  execute function app.notify_activity();

-- migrate:down
drop trigger if exists tasks_notify_activity_update on app.tasks;
drop trigger if exists tasks_notify_activity_insert on app.tasks;
drop function if exists app.notify_activity();
