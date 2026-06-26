# Retro — M9: dev workflow, worker ergonomics, docs

- Date: 2026-06-22
- PR: build/m9-dev-workflow
- Plan: [v2-plan.md](../plans/v2-plan.md) (M9)
- Implements: [ADR 0016](../decisions/0016-development-workflow.md) (+ ergonomics, README)

## What shipped

The last hand-built milestone before dogfooding: the substrate now knows the loop it
will run its own development on, and long real tasks are ergonomic.

- **The `ainarres-dev` workflow, as data ([ADR 0016](../decisions/0016-development-workflow.md)):**
  stages `proposed → designing → implementing → reviewing → integrating → validating →
  done` (single terminal), advance + reject(rework) transitions, each gated by the role
  that owns the step; `integrating` additionally requires `capability:integrate`
  ([ADR 0015](../decisions/0015-egress-as-capability.md)). Generous per-stage leases
  (1–2h) since real work runs minutes-to-hours.
- **Real families on the `dev` lane:** the frontier (`claude-code+opus`) holds
  designer/reviewer/integrator + `capability:integrate`; the worker (`opencode+qwen3.6`)
  holds implementer. Roles are configuration (features), not code.
- **Bounded auto-heartbeat:** `ainarres heartbeat <id> --watch --interval N --max M`
  renews the lease while a task is worked, then **stops on its own** at the cap — so a
  forgotten/orphaned watcher can't hold a lease forever (ADR 0009's safety property
  holds). A healthy long task is not reclaimed; a stopped watcher lets the lease expire.
- **README reconciled with reality:** lazy reclaim (not `pg_cron`), plpgsql-only (not
  `plv8`), status = v1-done/v2-in-progress, port 3010, egress-as-capability; scaling/
  substrate-egress explicitly framed as roadmap. The README no longer contradicts the code.

## Decisions / notes

- **Lane membership is a feature row.** Caught in test: creating the `dev` *lane*
  doesn't create the `lane:dev` *feature* — families can only be granted features that
  exist, so the grant silently no-op'd until `('lane','dev')` was seeded. The `seed.test`
  `family_features` count (10 vs expected 11) is what surfaced it. Good argument for the
  exact-count assertion.
- **Gating is data, asserted as data.** `test/dev-workflow.test.ts` reads every
  transition's `required_features` and checks the full map against ADR 0016, plus
  verb-level spot checks (a non-designer can't claim/advance a `proposed` task).
- **Heartbeat ergonomics tested for real:** a spawned `--watch` keeps a 2s-lease task
  held past expiry; killing the watcher lets it reclaim (~7s test, generous margins).

## Done-tests (met)

- `make reset` green: **61 tests pass** (4 new: 2 dev-workflow shape/gating, 1 heartbeat,
  +seed). Seed idempotent; `family_features` = 11.
- Role/capability gating matches ADR 0016 exactly (data + verb checks).
- README checked against the running stack — no contradicted claims.

## Bootstrap honesty (ADR 0013)

**Built 100% by hand** — correctly: you can't seed the dev workflow on a dev workflow
that doesn't exist yet, and the role skills that let agents *operate* it don't land until
M10. M9 is the last hand-built floor. **M10 (role skills + context-clean rehearsal) is
the first milestone we can run on AINARRES; M11 (the oversight tool) is the full proof.**

## Follow-ups (not blocking)

- The three M10/M11 operational questions remain open: the "fresh frontier instance"
  mechanism, the integrator runtime + `gh` auth, and worktree isolation for parallel
  implementers. They come due at M10.

**Blog:** "Teaching AINARRES its own development loop."
