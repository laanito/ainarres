// Pure, deterministic string truncation helper.
// No I/O, no clock, no side effects — same input → same output.

export function truncate(str, max) {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + "\u2026";
}
