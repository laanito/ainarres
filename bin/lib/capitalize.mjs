// Pure, deterministic capitalize helper.
// No I/O, no clock, no side effects — same input → same output.

export function capitalize(str) {
  if (str.length === 0) return "";
  return str[0].toUpperCase() + str.slice(1);
}
