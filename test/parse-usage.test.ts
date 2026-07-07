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

  // ---------------------------------------------------------------------------
  // opencode family — JSON event stream with step_finish events carrying
  // part.tokens.  Build from three real event lines interleaved with unrelated
  // events and one malformed line to prove they are skipped.
  // ---------------------------------------------------------------------------

  // prettier-ignore
  const opencodeLineA = JSON.stringify({
    type: "step_finish", ts: "2026-07-07T17:07:18Z",
    part: { type: "step-finish", tokens: { total: 7858, input: 7790, output: 44, reasoning: 24, cache: { write: 0, read: 0 } }, cost: 0 },
  });
  // prettier-ignore
  const opencodeLineB = JSON.stringify({
    type: "step_finish", ts: "2026-07-07T17:07:20Z",
    part: { type: "step-finish", tokens: { total: 7925, input: 64, output: 44, reasoning: 9, cache: { write: 0, read: 7808 } }, cost: 0 },
  });
  // prettier-ignore
  const opencodeLineC = JSON.stringify({
    type: "step_finish", ts: "2026-07-07T17:07:22Z",
    part: { type: "step-finish", tokens: { total: 7952, input: 131, output: 3, reasoning: 10, cache: { write: 0, read: 7808 } }, cost: 0 },
  });

  const opencodeLog = [
    opencodeLineA,
    `{"type":"step_start","ts":"2026-07-07T17:07:18Z","step":1}`,
    // malformed JSON — must be skipped without throwing
    '{"type":"step_finish","part":{"tokens":{"total":100}',
    opencodeLineB,
    `{"type":"think","ts":"2026-07-07T17:07:19Z","content":"reasoning..."}`,
    opencodeLineC,
  ].join("\n");

  it("aggregates opencode step_finish token events across the whole log", () => {
    const u = parseUsage(opencodeLog, "opencode+big-pickle");
    expect(u).not.toBeNull();
    expect(u!.tokens).toEqual({
      input: 7985,       // 7790 + 64 + 131
      output: 134,       // (44+44+3) + (24+9+10)
      cache_read: 15616, // 0 + 7808 + 7808
      cache_creation: 0, // 0 + 0 + 0
    });
    expect(u!.model).toBeNull();
  });

  it("returns null for opencode log with no step_finish events", () => {
    expect(parseUsage("not json\n{oops\n", "opencode+qwen3-coder-next")).toBeNull();
  });

  // The two existing opencode-family null tests (line 58-63) still pass:
  // claudeResult has type "result" not "step_finish", and the plain-text log
  // has no JSON at all — both must still return null for opencode families.
  it("still returns null for claude-shaped log with opencode family (no step_finish)", () => {
    expect(parseUsage(claudeResult, "opencode+big-pickle")).toBeNull();
  });

  it("still returns null for plain-text log with opencode family", () => {
    expect(parseUsage("commit only bin/lib/x.mjs\nrun the loop until empty\n", "opencode+big-pickle")).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // cursor-agent family — JSON lines with top-level usage (camelCase tokens).
  // Scan for the LAST usage record with a numeric usage.inputTokens.
  // ---------------------------------------------------------------------------

  // prettier-ignore
  const cursorLog = [
    `{"type":"event","ts":"1","content":"thinking..."}`,
    // malformed JSON — must be skipped without throwing
    '{"type":"result","usage":{"inputTokens":999',
    `{"type":"result","session_id":"s","usage":{"inputTokens":30371,"outputTokens":639,"cacheReadTokens":122566,"cacheWriteTokens":0}}`,
    `{"type":"heartbeat","ts":"2"}`,
  ].join("\n");

  it("extracts cursor usage from a log with interleaved events and a malformed line", () => {
    const u = parseUsage(cursorLog, "cursor-agent+composer-2.5");
    expect(u).not.toBeNull();
    expect(u!.tokens).toEqual({
      input: 30371,
      output: 639,
      cache_read: 122566,
      cache_creation: 0,
    });
    expect(u!.model).toBeNull();
  });

  it("takes the LAST cursor usage line when multiple exist", () => {
    const earlier = JSON.stringify({
      type: "result",
      session_id: "s1",
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5 },
    });
    const later = JSON.stringify({
      type: "result",
      session_id: "s2",
      usage: { inputTokens: 30371, outputTokens: 639, cacheReadTokens: 122566, cacheWriteTokens: 0 },
    });
    const log = `${earlier}\n${later}`;
    const u = parseUsage(log, "cursor-agent+composer-2.5");
    expect(u).not.toBeNull();
    expect(u!.tokens).toEqual({
      input: 30371,
      output: 639,
      cache_read: 122566,
      cache_creation: 0,
    });
    expect(u!.model).toBeNull();
  });

  it("returns null for a cursor log with no usage record", () => {
    expect(parseUsage("not json\n{oops\n", "cursor-agent+composer-2.5")).toBeNull();
  });

  it("returns null for a claude-shaped log with cursor-agent family (wrong shape)", () => {
    // claude uses snake_case input_tokens — must not be recognized as cursor usage
    expect(parseUsage(claudeResult, "cursor-agent+composer-2.5")).toBeNull();
  });

  it("returns null for an opencode-shaped log with cursor-agent family (no top-level usage)", () => {
    // opencode has part.tokens, not top-level usage — must not be recognized
    expect(parseUsage(opencodeLog, "cursor-agent+composer-2.5")).toBeNull();
  });
});
