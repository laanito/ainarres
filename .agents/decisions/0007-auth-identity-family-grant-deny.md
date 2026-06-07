# ADR 0007 — Authentication & identity: families, token-grant minus DB-veto

- Status: Accepted
- Date: 2026-06-07
- Closes: Q10, Q12, Q13
- Amends: [0004](0004-feature-model.md) (source of effective features; lane folded into features)

## Context

[ADR 0004](0004-feature-model.md) matches tasks to agents by **feature superset** and
requires features to be **tamper-proof** and, because of reflexive governance, **fresh**
(a revoked feature must stop applying promptly). PostgREST gives us the frame: a client
presents a JWT, PostgREST verifies the signature, `SET ROLE`s to a `role` claim, and
exposes the remaining claims to SQL via `request.jwt.claims`; our `SECURITY DEFINER`
verbs read from there.

Two facts shape the design:

- **Agents are ephemeral; families are durable.** A running agent is an instance that
  comes and goes. A **family** — the `(harness/tool + model)` combination, e.g.
  `opencode+qwen`, `claude-code+opus` — is what persists. Competence is a property of the
  family: if `opencode+qwen` is unsuitable for complex planning, that holds for *every*
  instance matching it, regardless of environment, and we needn't know whether the cause
  is the harness or the model. So judgments must attach to the family, not the instance —
  a veto pinned to an instance evaporates on respawn.
- **Grant and veto want different homes.** Provisioning ("this family may do X") is a
  deliberate human act and can live in a signed token. Revocation ("this family proved
  bad at X") is learned by governance and must take effect immediately.

## Decision

1. **Family is the durable unit; agent is an instance.**
   - `agent_families` — the durable classes; **grants and denials attach here**.
   - `agents` — instances (id = token `sub`, `family_id`); exist so `claimed_by`,
     `created_by`, event `actor`, and task `subject` resolve to a row.

2. **Token = the grant (input, signed, family-scoped).** A JWT carries:
   `sub` (instance id), `family`, `role` (the Postgres role to assume), the granted
   **`features[]`** (a snapshot of the family's provisioned features), and `exp`. The
   token is the *upper bound* of capability — signed, so an agent cannot add to it.

3. **DB = the veto (fresh, family-scoped).** `feature_denials` `(family_id, feature,
   reason, created_at)` is written by governance; server-side, so an agent cannot remove
   a denial.

4. **Effective features = granted (token) − denied (DB veto for the agent's family).**
   Matching (ADR 0004's superset rule) runs against the effective set. Consequence:
   **revoking is instant** (a denial applies to the next claim, even on a still-valid
   token); **granting requires reprovisioning** (a fresh token). This asymmetry is
   deliberate and fail-safe — removing access never waits.

5. **Coarse Postgres roles, distinct from the functional role feature.** A small fixed
   set gates *which functions you may call*:
   - `agent` — every agent authenticates as this; `EXECUTE` on the verb functions only.
   - `oversight` — humans: read the views + call intervention RPCs.
   - `reaper`/`admin` — privileged; the lease job and provisioning.
   - `anon` — health only.
   The functional role (analyst/reviewer/…) is a **feature**, not a Postgres role.

6. **Issuance (v1): HS256 shared secret** configured in PostgREST + a privileged mint
   path that reads a family's provisioned features and signs a token. Asymmetric keys
   (RS256/JWKS) and rotation are deferred; nothing here precludes them.

## Alternatives considered

- **Features carried in the token only (README/0004 original).** Rejected: a revoked
  feature stays live until token expiry — breaks reflexive governance.
- **Features live-read in full from a per-agent table (no token features).** Rejected:
  loses the portable, explicit provisioning intent the token gives, and adds a read on
  the hot path for the common (no-denial) case. The grant/veto split keeps the common
  case stateless and only consults the DB to enforce revocations.
- **Denials keyed to the agent instance.** Rejected — the core insight: instance-scoped
  vetoes don't survive respawn; competence is a family property.

## Consequences

- The common claim is stateless (token) plus a small `feature_denials` check by family.
- The human "who can do what" view = family grants minus family denials.
- Updates the data model: adds `agent_families`, `feature_denials`; `agents` becomes an
  instance record; `agent_features` (per-instance holdings) is superseded by family
  grants in the token. See [design/data-model.md](../design/data-model.md).
- Token-claim shape feeds the verb contracts (Q7–Q9, next cluster).
