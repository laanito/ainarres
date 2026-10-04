import { describe, expect, it } from "vitest";
import { parseUsage, segmentUsage } from "../bin/ainarres.mjs";

// M20 Slice A (design/track-record.md D1/D3). The driver-side per-family token parser
// — pure, no I/O. The load-bearing property: an UNKNOWN harness shape returns null,
// never zeroes, so a family we cannot measure reads as "unknown" (the view LEFT JOINs
// → NULL), never as "free". claude, opencode, cursor-agent, and grok all have
// parseable shapes; an unrecognised family still degrades to null. Tokens only — the
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

  it("returns null for grok when log has no _meta/inputTokens (unknown ≠ free)", () => {
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

  // ---------------------------------------------------------------------------
  // grok family — debug log lines with embedded JSON containing _meta.
  // inputTokens INCLUDES cachedReadTokens; fresh input = inputTokens - cachedRead.
  // ---------------------------------------------------------------------------

  // A representative grok debug log line (from the grok harness).
  const grokLine =
    '2026-07-07T17:16:30Z DEBUG xai_acp_lib::gateway: received "session/prompt" response: ' +
    JSON.stringify({
      stopReason: "end_turn",
      _meta: {
        totalTokens: 58050,
        modelId: "grok-build",
        inputTokens: 57574,
        outputTokens: 475,
        cachedReadTokens: 57344,
        reasoningTokens: 49,
      },
    });

  it("extracts grok tokens from a debug log line, computing fresh input = inputTokens - cachedReadTokens", () => {
    const u = parseUsage(grokLine, "grok+grok-build");
    expect(u).not.toBeNull();
    expect(u!.tokens).toEqual({
      input: 230,       // 57574 - 57344
      output: 475,
      cache_read: 57344,
      cache_creation: 0,
    });
    expect(u!.model).toBe("grok-build");
  });

  it("takes the LAST grok _meta line when multiple exist (reviewer sweep then integrator sweep)", () => {
    const earlierMeta = {
      _meta: { totalTokens: 100, modelId: "grok-build", inputTokens: 80, outputTokens: 20, cachedReadTokens: 50 },
    };
    const laterMeta = {
      _meta: {
        totalTokens: 58050, modelId: "grok-build", inputTokens: 57574, outputTokens: 475,
        cachedReadTokens: 57344, reasoningTokens: 49,
      },
    };
    const log = [
      `2026 DEBUG some noise: ${JSON.stringify(earlierMeta)}`,
      "some interleaved non-JSON text",
      `2026 DEBUG response: ${JSON.stringify(laterMeta)}`,
    ].join("\n");
    const u = parseUsage(log, "grok+grok-build");
    expect(u).not.toBeNull();
    expect(u!.tokens).toEqual({
      input: 230,       // 57574 - 57344
      output: 475,
      cache_read: 57344,
      cache_creation: 0,
    });
  });

  it("returns null for a plain log with no JSON for grok family", () => {
    expect(parseUsage("2026 DEBUG some other line\nnot json\n", "grok+grok-build")).toBeNull();
  });

  it("returns null for a claude-shaped log with grok family (no _meta)", () => {
    // claudeResult has snake_case usage, not _meta — must not be recognized as grok
    expect(parseUsage(claudeResult, "grok+grok-build")).toBeNull();
  });

  it("returns null for an opencode-shaped log with grok family (no _meta)", () => {
    // opencode has step_finish events with part.tokens — must not be recognized as grok
    expect(parseUsage(opencodeLog, "grok+grok-build")).toBeNull();
  });

  it("returns null for a cursor-shaped log with grok family (no _meta)", () => {
    // cursor has top-level usage with inputTokens but no _meta — must not be recognized
    expect(parseUsage(cursorLog, "grok+grok-build")).toBeNull();
  });
});

// v9 Slice 0 (design/customer-seat.md D7) — the writer cuts a STREAMED sweep log at each
// transition the sweep made. Pure; the CLI records one anchored usage row per segment.
describe("segmentUsage — one sweep's spend, cut per transition", () => {
  // The CLI envelope an `advance` prints; the transition event is what anchors a segment.
  const env = (id: string, task = "task-1") => ({ ok: true, code: "ok", task: { id: task }, event: { id, task_id: task, type: "transition", data: { kind: "advance" } } });
  const lines = (...xs: object[]) => xs.map((x) => JSON.stringify(x)).join("\n");

  // claude `stream-json --include-partial-messages`: the per-message usage that is final is
  // the message_delta; the whole-message `assistant` lines carry a PLACEHOLDER output count
  // (measured: 5 vs 463 for the same run) and must not be summed.
  const delta = (input: number, output: number, cr = 0, cc = 0) => ({ type: "stream_event", event: { type: "message_delta", usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cr, cache_creation_input_tokens: cc } } });
  const placeholder = { type: "assistant", message: { id: "m", usage: { input_tokens: 999, output_tokens: 5 } } };
  const toolResult = (e: object) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: JSON.stringify(e) }] } });

  it("claude: charges each turn to the transition its tool call made, sign-off joins the last", () => {
    const log = lines(
      { type: "stream_event", event: { type: "message_start", message: { model: "claude-sonnet-5" } } },
      placeholder, delta(10, 100, 1000, 50), toolResult(env("ev-merge")),
      placeholder, delta(8, 40, 2000, 0), toolResult(env("ev-green")),
      delta(8, 7, 2100, 0), // "nothing claimable" → stop
      { type: "result", usage: { input_tokens: 26, output_tokens: 147 } },
    );
    expect(segmentUsage(log, "claude-code+sonnet")).toEqual({
      model: "claude-sonnet-5",
      segments: [
        { transition: "ev-merge", task: "task-1", tokens: { input: 10, output: 100, cache_read: 1000, cache_creation: 50 } },
        { transition: "ev-green", task: "task-1", tokens: { input: 16, output: 47, cache_read: 4100, cache_creation: 0 } },
      ],
    });
  });

  it("opencode: step_finish comes AFTER the step's tool output, so the cut waits for it", () => {
    const step = (input: number) => ({ type: "step_finish", part: { tokens: { input, output: 1, reasoning: 1, cache: { read: 0, write: 0 } } } });
    const tool = (e: object) => ({ type: "tool_use", part: { tool: "bash", state: { status: "completed", output: JSON.stringify(e) } } });
    const log = lines(step(100), tool(env("ev-1")), step(20), step(3));
    const seg = segmentUsage(log, "opencode+big-pickle");
    // The advancing step (20) belongs to ev-1, not to whatever comes next.
    expect(seg!.segments).toEqual([
      { transition: "ev-1", task: "task-1", tokens: { input: 123, output: 6, cache_read: 0, cache_creation: 0 } },
    ]);
  });

  it("grok: a tool result re-sent per status update, and quoted later by the model, cuts ONCE", () => {
    const usage = (input: number) => ({ type: "usage", usage: { input_tokens: input, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
    const upd = (e: object) => ({ type: "tool_call_update", rawOutput: JSON.stringify({ type: "Bash", output_for_prompt: `exit: 0\n${JSON.stringify(e)}\n` }) });
    const log = lines(usage(50), upd(env("ev-a")), upd(env("ev-a")), usage(5), { type: "text", data: JSON.stringify(env("ev-a")) }, usage(1));
    const seg = segmentUsage(log, "grok+grok-4.7");
    expect(seg!.segments).toHaveLength(1);
    expect(seg!.segments[0]).toMatchObject({ transition: "ev-a", tokens: { input: 56, output: 3 } });
  });

  it("splits across tasks: each segment carries its own transition's task", () => {
    const usage = (input: number) => ({ type: "usage", usage: { input_tokens: input, output_tokens: 0 } });
    const upd = (e: object) => ({ type: "tool_call_update", rawOutput: JSON.stringify({ output_for_prompt: JSON.stringify(e) }) });
    const seg = segmentUsage(lines(usage(1), upd(env("e1", "A")), usage(2), upd(env("e2", "B"))), "grok+x");
    expect(seg!.segments.map((s: any) => [s.transition, s.task, s.tokens.input])).toEqual([["e1", "A", 1], ["e2", "B", 2]]);
  });

  it("a sweep that moved nothing is ONE unanchored segment — the empty-sweep path is unchanged", () => {
    const claim = { ok: true, code: "empty", task: null, event: null };
    const seg = segmentUsage(lines(delta(9, 3), toolResult(claim)), "claude-code+sonnet");
    expect(seg!.segments).toEqual([{ transition: null, task: null, tokens: { input: 9, output: 3, cache_read: 0, cache_creation: 0 } }]);
  });

  it("ignores ok envelopes that are not transitions, and failed advances", () => {
    const claimed = { ok: true, code: "ok", task: { id: "t" }, event: { id: "c1", task_id: "t", type: "claim" } };
    const refused = { ok: false, code: "forbidden", event: { id: "x", task_id: "t", type: "transition" } };
    const seg = segmentUsage(lines(delta(4, 1), toolResult(claimed), toolResult(refused)), "claude-code+sonnet");
    expect(seg!.segments).toHaveLength(1);
    expect(seg!.segments[0].transition).toBeNull();
  });

  it("returns null — never zeroes — when the log has no per-turn usage, so the caller falls back", () => {
    expect(segmentUsage(claudeResult, "claude-code+sonnet")).toBeNull(); // json-mode log
    expect(segmentUsage(lines(toolResult(env("e"))), "grok+x")).toBeNull();
    expect(segmentUsage("not json\n{oops", "opencode+x")).toBeNull();
    expect(segmentUsage(lines(delta(1, 1)), "cursor-agent+composer-2.5")).toBeNull(); // unverified shape
    expect(segmentUsage(lines(delta(1, 1)), undefined as any)).toBeNull();
  });

  it("conserves the total: the segments sum to the sweep's usage", () => {
    const log = lines(delta(3, 30, 300, 3), toolResult(env("a")), delta(4, 40, 400, 4), toolResult(env("b")), delta(5, 50, 500, 5));
    const seg = segmentUsage(log, "claude-code+opus")!;
    const sum = seg.segments.reduce((n: number, s: any) => n + s.tokens.input + s.tokens.output + s.tokens.cache_read + s.tokens.cache_creation, 0);
    expect(sum).toBe(3 + 30 + 300 + 3 + 4 + 40 + 400 + 4 + 5 + 50 + 500 + 5);
  });
});
