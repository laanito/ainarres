// Pure, deterministic numeric clamp helper.
// No I/O, no clock, no side effects — same input → same output.

export function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
