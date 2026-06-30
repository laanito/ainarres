// Pure, deterministic ordinal string helper.
// No I/O, no clock, no side effects — same input → same output.

export function ordinal(n) {
  const abs = Math.abs(Math.floor(n));
  const last = abs % 10;
  const teen = abs % 100;
  let suffix;
  if (teen >= 11 && teen <= 13) suffix = "th";
  else if (last === 1) suffix = "st";
  else if (last === 2) suffix = "nd";
  else if (last === 3) suffix = "rd";
  else suffix = "th";
  return `${abs}${suffix}`;
}
