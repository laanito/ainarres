import { describe, expect, it } from "vitest";
import { parseUsage } from "../bin/ainarres.mjs";

// M20 Slice A (design/track-record.md D1/D3). The driver-side per-family token parser
// — pure, no I/O. The load-bearing property: an UNKNOWN harness shape returns null,
// never zeroes, so a family we cannot measure reads as "unknown" (the view LEFT JOINs
// → NULL), never as "free". Today only the claude families emit a parseable shape;
// opencode and grok print no token JSON and MUST degrade to null. Tokens only — the
// harness's total_cost_usd is deliberately dropped (D3).

// A representative compact claude `--output-format json` result line.
const claudeResult = JSON.stringify({
  type: "result",
  subtype: "success",
  total_cost_usd: 0.4748, // present in the harness output — must be DROPPED
  usage: {
    input_tokens: 4049,
    cache_creation_input_tokens: 26712,
    cache_read_input_tokens: 840768,
    output_tokens: 3264,
  },
  modelUsage: {
    "claude-haiku-4-5-20251001": { inputTokens: 1120, outputTokens: 16 },
    "claude-sonnet-5": { inputTokens: 4049, outputTokens: 3264 },
  },
});

describe("parseUsage — the per-family token parser", () => {
  it("extracts tokens (input/output/cache) from a claude result line", () => {
    const u = parseUsage(claudeResult, "claude-code+sonnet");
    expect(u).not.toBeNull();
    expect(u!.tokens).toEqual({
      input: 4049,
      output: 3264,
      cache_read: 840768,
      cache_creation: 26712,
    });
  });

  it("labels the dominant model (by tokens), not the incidental title-gen model", () => {
    const u = parseUsage(claudeResult, "claude-code+opus");
    expect(u!.model).toBe("claude-sonnet-5"); // 7313 tokens ≫ haiku's 1136
  });

  it("drops total_cost_usd entirely (tokens, never USD — D3)", () => {
    const u = parseUsage(claudeResult, "claude-code+sonnet");
    expect(JSON.stringify(u)).not.toContain("cost");
    expect(JSON.stringify(u)).not.toContain("usd");
  });

  it("takes the LAST result object when a log carries several", () => {
    const earlier = JSON.stringify({ type: "result", usage: { input_tokens: 1, output_tokens: 1 } });
    const log = `${earlier}\nsome interleaved text\n${claudeResult}`;
    const u = parseUsage(log, "claude-code+sonnet");
    expect(u!.tokens.input).toBe(4049); // the final sweep total, not the earlier turn
  });

  it("returns null for opencode — its plain-text log has no token JSON (unknown ≠ free)", () => {
    // Even a usage-shaped line must not be read for a non-claude family: the family
    // gate is what keeps an unparseable tier honestly UNKNOWN rather than zero.
    expect(parseUsage(claudeResult, "opencode+big-pickle")).toBeNull();
    expect(parseUsage("commit only bin/lib/x.mjs\nrun the loop until empty\n", "opencode+big-pickle")).toBeNull();
  });

  it("returns null for grok — its JSON carries no usage (unknown ≠ free)", () => {
    const grok = JSON.stringify({ text: "Loop completed: no more work on the dev lane." });
    expect(parseUsage(grok, "grok+grok-build")).toBeNull();
  });

  it("returns null for an absent/unknown family", () => {
    expect(parseUsage(claudeResult, undefined as unknown as string)).toBeNull();
    expect(parseUsage(claudeResult, "loop+driver")).toBeNull();
  });

  it("returns null for a claude log with no usage line", () => {
    expect(parseUsage('{"text":"no usage here"}\nplain log tail\n', "claude-code+sonnet")).toBeNull();
  });

  it("still yields tokens when modelUsage is absent (model → null)", () => {
    const noModel = JSON.stringify({ type: "result", usage: { input_tokens: 10, output_tokens: 5 } });
    const u = parseUsage(noModel, "claude-code+opus");
    expect(u!.tokens).toEqual({ input: 10, output: 5, cache_read: null, cache_creation: null });
    expect(u!.model).toBeNull();
  });
});
