// Pure, deterministic pluralization helper.
// No I/O, no clock, no side effects — same input → same output.
// Returns "<n> <word>" where word is the singular form when n === 1,
// the plural form otherwise. Default plural = singular + "s".

export function pluralize(n, singular, plural) {
  const word = n === 1 ? singular : (plural ?? `${singular}s`);
  return `${n} ${word}`;
}
