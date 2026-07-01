// Pure, deterministic list-joining helper.
// No I/O, no clock, no side effects — same input → same output.

export function listJoin(items) {
  if (!Array.isArray(items)) {
    throw new TypeError("listJoin: items must be an array");
  }

  if (items.length === 0) return "";
  if (items.length === 1) return String(items[0]);

  const last = items[items.length - 1];
  const rest = items.slice(0, -1);

  if (rest.length === 1) {
    return `${rest[0]} and ${last}`;
  }

  return `${rest.join(", ")} and ${last}`;
}
