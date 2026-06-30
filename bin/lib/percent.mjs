// Pure, deterministic percent string helper.
// No I/O, no clock, no side effects — same input → same output.

export function percent(part, whole) {
  if (whole === 0) return "0%";
  const p = Math.round((part / whole) * 100);
  return `${p}%`;
}
