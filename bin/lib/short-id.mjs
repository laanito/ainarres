// Pure, deterministic short-id helper.
// No I/O, no clock, no side effects — same input → same output.
// Returns the first 8 characters of a string, or the whole string if < 8 chars.
// Non-string input and empty string return "".

export function shortId(id) {
  if (typeof id !== "string" || id.length === 0) return "";
  return id.length < 8 ? id : id.slice(0, 8);
}
