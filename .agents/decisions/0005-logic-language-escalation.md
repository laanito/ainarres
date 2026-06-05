# ADR 0005 — Logic-language escalation ladder (plpgsql-first)

- Status: Accepted
- Date: 2026-06-05
- Closes: Q17, Q18

## Context

The README recommended `plv8` as the default logic language (JSON-native, shareable
dry-run with JS/TS clients). But everything except Postgres + PostgREST is open, and the
owner's stated principle is: keep logic in functions, and **only when complexity
outgrows the simpler tool do we reach for a heavier one**.

## Decision

A strict escalation ladder. Start at the lowest rung; climb only when a concrete need
forces it:

1. **`plpgsql`** — the default for all verbs and the transition validator. Zero extra
   dependencies; the matching and transition logic is set-oriented SQL, which plpgsql
   handles natively.
2. **`plv8` (or another trusted PL)** — adopted only if a piece of logic becomes
   genuinely awkward in plpgsql (heavy JSON shaping, logic we want to share verbatim with
   JS/TS clients). Introduced per-function, not wholesale.
3. **External functionality via FDW / untrusted languages** — only for work that must
   leave the DB (heavy scoring, filesystem). Kept off the agent-facing hot path and
   behind privileged roles, never exposed through PostgREST directly.

## Alternatives considered

- **`plv8` as the default from day one** (README's suggestion). Rejected for v1: adds a
  build/runtime dependency (the extension must be present in every image) before any
  logic has proven too complex for plpgsql. The ladder lets that cost arrive only when
  earned.

## Consequences

- v1 images stay dependency-light: stock Postgres + the extensions we actually use.
- Each climb up the ladder is a deliberate, reviewable decision (likely its own ADR),
  not a default.
- A client-shared dry-run (the original `plv8` motivation) is deferred until we decide we
  want it; nothing here precludes adding it later.
