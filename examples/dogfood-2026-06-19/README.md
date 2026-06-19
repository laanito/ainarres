# Dogfood run — 2026-06-19 (M6b self-hosting checkpoint)

These two files are **real work product** produced by a live agent worker driving
AINARRES through its own verbs — the ADR 0012 success gate. They are committed here
(git) as the durable artifact; during the run they lived in the gitignored
`work/<task-id>/` scratch space and the DB carried only path references (ADR 0003).

## What happened

- **Substrate:** AINARRES (PostgreSQL + PostgREST), `snippet-factory` workflow,
  `snippets` lane.
- **Worker:** `opencode + qwen3.6:35b-mlx` (local, via ollama), running the
  `ainarres-worker` agent/skill, calling the `ainarres` CLI for every verb.
- **Reviewer:** Claude (role-feature `role:reviewer`), independently re-running each
  task's `validate` before accepting.

Each task travelled the full pipeline **entirely through the verbs**:

```
create (reviewer) → claim (qwen) → solve + self-validate (qwen)
  → advance:review (qwen) → claim (reviewer) → independent verify → advance:done (reviewer)
```

| Task | Instruction | qwen's solution | Outcome |
|------|-------------|-----------------|---------|
| `019edf49-b5a3…` | export CommonJS `add(a,b)` | `add(a,b){ return a+b }` | validated → **done** |
| `019edf49-b602…` | export CommonJS `reverse(s)` | `reverse(s){ return s.split('').reverse().join('') }` | validated → **done** |

Both `validate` commands passed for the worker (self-check) and again for the
reviewer (independent check). No rework was needed this run; the reject→rework path
is covered deterministically by `test/e2e.test.ts`.
