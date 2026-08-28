#!/usr/bin/env bash
# Demand-gate selftest (M27 / v7.1) — SUBSTRATE-FREE: no docker, no database, no ports.
# It stubs the `ainarres` CLI with a scripted `demand` feed and drives should_spawn
# directly, so it can run anywhere, including while a real service is up on the loop
# substrate.
#
# What it pins: should_spawn must decide against the board as it is NOW, not as it was
# when the round began. Demand was once sampled once per round, so with ONE pending task
# and FOUR capable implementer tiers, the pool claimed it and the three serial tiers each
# still spawned a model against a stale snapshot — four model loads for one task — while a
# reviewer that could have run immediately waited for the next round.
#
# Run: bash loop/demand-gate-selftest.sh   (or `make demand-gate-selftest`)
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# The stand-in CLI: only `demand` matters. Each call consumes the NEXT line of the
# scripted feed, which is how the board "changes" underneath a round.
cat > "$TMP/ainarres-stub.sh" <<'STUB'
#!/usr/bin/env bash
if [ "${1:-}" = "demand" ]; then
  n=$(cat "$DEMAND_SEQ_N" 2>/dev/null || echo 1)
  sed -n "${n}p" "$DEMAND_SEQ"
  echo $((n + 1)) > "$DEMAND_SEQ_N"
fi
exit 0
STUB
chmod +x "$TMP/ainarres-stub.sh"

export LOOP_MODE=mock LOOP_CONSUME_DEMAND=1 LOOP_CONSUME_GOVERNANCE=0
# shellcheck source=/dev/null
. loop/roles.sh
# shellcheck source=/dev/null
. loop/driver-lib.sh
# AFTER both — each of them sets AINARRES itself.
AINARRES=("$TMP/ainarres-stub.sh")
OVERSIGHT_TOKEN=stub
CAPMAP_DOWN=""   # every tier live
GOV_BANNED=""

IMPL='[{"bundle":["lane:dev","role:implementer"],"lane":"dev","pending":1}]'
REVW='[{"bundle":["lane:dev","role:reviewer"],"lane":"dev","pending":1}]'
NONE='[]'

export DEMAND_SEQ="$TMP/seq" DEMAND_SEQ_N="$TMP/seq.n"

# Ask each tier in the order a round asks them, and collect who would spawn.
run_case() {
  echo 1 > "$DEMAND_SEQ_N"
  SPAWNED=()
  local tier
  for tier in cheap-implementer muse-implementer cursor-implementer fallback-implementer \
              frontier frontier-claude-reviewer; do
    if should_spawn "$tier" 1 >/dev/null 2>&1; then SPAWNED+=("$tier"); fi
  done
}

expect() {
  local label="$1" want="$2" got="${SPAWNED[*]:-}"
  if [ "$got" = "$want" ]; then
    echo "  ✓ $label"
    return 0
  fi
  echo "  ✗ $label"
  echo "      expected: ${want:-<none>}"
  echo "      got:      ${got:-<none>}"
  FAILED=1
}

FAILED=0
echo "demand-gate-selftest: should_spawn reads demand fresh (M27)"

# 1. One implementer task, claimed by the pool the moment it runs. The three redundant
#    implementer tiers must stand down; the reviewers wake in the SAME round.
printf '%s\n%s\n%s\n%s\n%s\n%s\n' "$IMPL" "$REVW" "$REVW" "$REVW" "$REVW" "$REVW" > "$DEMAND_SEQ"
run_case
expect "the pool claims the one task; redundant implementer tiers skip, reviewers wake" \
       "cheap-implementer frontier frontier-claude-reviewer"

# 2. The pool fails to take it (demand still standing): the serial fallbacks MUST run.
#    This is the property the fix must not cost — cheap first, better after.
printf '%s\n%s\n%s\n%s\n%s\n%s\n' "$IMPL" "$IMPL" "$IMPL" "$IMPL" "$IMPL" "$IMPL" > "$DEMAND_SEQ"
run_case
# NB: `frontier` holds no role:implementer in loop/roles.sh (it is the designer /
# reviewer / integrator peer), so it correctly stays out of this one.
expect "standing implementer demand still reaches every implementer tier (fallback intact)" \
       "cheap-implementer muse-implementer cursor-implementer fallback-implementer"

# 3. An empty board spawns nothing. This is the case that separates "nothing is pending"
#    from "I could not ask": after the last task of a round finishes, demand is honestly
#    `[]`, and reading that as "everything is demanded" woke every remaining tier to find
#    an empty board.
printf '%s\n%s\n%s\n%s\n%s\n%s\n' "$NONE" "$NONE" "$NONE" "$NONE" "$NONE" "$NONE" > "$DEMAND_SEQ"
run_case
expect "an empty board spawns nothing" ""

# 4. Unreadable demand degrades to v7 — spawn everything, never stall. A cost failure is
#    always preferable to a correctness one.
printf '\n\n\n\n\n\n' > "$DEMAND_SEQ"
run_case
expect "unreadable demand degrades to spawning everything (fail-open)" \
       "cheap-implementer muse-implementer cursor-implementer fallback-implementer frontier frontier-claude-reviewer"

if [ "$FAILED" = 0 ]; then
  echo "✓ demand-gate-selftest PASSED"
  exit 0
fi
echo "✗ demand-gate-selftest FAILED"
exit 1
