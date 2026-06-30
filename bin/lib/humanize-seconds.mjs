// Pure, deterministic human-friendly rendering of a number of seconds.
// No I/O, no clock, no side effects — same input → same output.
// Units: d (day), h (hour), m (minute), s (second).
// Drops zero components except the special "0s" case.
// Never emits more than the three largest non-zero units.
// Negative inputs get a "-" prefix on the absolute value.

export function humanizeSeconds(n) {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";

  const days = Math.floor(abs / 86400);
  const hours = Math.floor((abs % 86400) / 3600);
  const minutes = Math.floor((abs % 3600) / 60);
  const seconds = abs % 60;

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);

  if (parts.length === 0) return "0s";

  // Never emit more than the three largest non-zero units.
  const clipped = parts.slice(0, 3);

  return sign + clipped.join(" ");
}
