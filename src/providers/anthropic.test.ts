/**
 * Tests for the interrupted-session repair behaviour in convertMessages.
 *
 * Given a session history with a dangling tool_use (the exact pattern
 * from the broken 2de17775 session), the converted Anthropic params must:
 *   1. Contain no assistant tool_use without a following tool_result.
 *   2. Have strictly alternating user/assistant roles.
 *   3. Carry the user's follow-up text in the same user message that
 *      contains the synthetic tool_result.
 *
 * Both helpers are exported from the production module so the assertions
 * below run against real production code, not test-local copies.
 */
import { describe, expect, it } from "vitest";
import type { Message } from "@mariozechner/pi-ai";
import {
  coalesceSameRoleMessages,
  looksLikeStreamingJsonBug,
  mapStopReason,
  repairInterruptedToolCalls,
  streamVertexAnthropic,
  anthropicModels,
} from "./anthropic.js";

describe("interrupted-session repair (mirrors session 2de17775)", () => {
  it("repairs an assistant tool_use that has no following tool_result", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "do something that takes a while" }],
        timestamp: 1,
      } as any,
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "I'll run a long bash command.",
            thinkingSignature: "sig",
          },
          {
            type: "toolCall",
            id: "toolu_vrtx_018zqp",
            name: "bash",
            arguments: { command: "sleep 120" },
          },
        ],
      } as any,
      {
        role: "user",
        content: [
          { type: "text", text: "actually, how do interrupts work in pi?" },
        ],
        timestamp: 2,
      } as any,
    ];

    const repaired = repairInterruptedToolCalls(messages);

    // Synthetic toolResult must have been inserted between the assistant
    // message and the user's follow-up text.
    expect(repaired).toHaveLength(4);
    expect(repaired[0].role).toBe("user");
    expect(repaired[1].role).toBe("assistant");
    expect(repaired[2].role).toBe("toolResult");
    expect((repaired[2] as any).toolCallId).toBe("toolu_vrtx_018zqp");
    expect((repaired[2] as any).isError).toBe(true);
    expect(repaired[3].role).toBe("user");
  });

  it("does not touch a healthy history where every tool_use has a result", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "id1", name: "bash", arguments: {} },
          { type: "toolCall", id: "id2", name: "read", arguments: {} },
        ],
      } as any,
      {
        role: "toolResult",
        toolCallId: "id1",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 1,
      } as any,
      {
        role: "toolResult",
        toolCallId: "id2",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 2,
      } as any,
    ];

    const repaired = repairInterruptedToolCalls(messages);
    expect(repaired).toHaveLength(3);
    expect(repaired.map((m) => m.role)).toEqual([
      "assistant",
      "toolResult",
      "toolResult",
    ]);
  });

  it("only injects synthetic results for the missing ids in a partial result", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "id1", name: "bash", arguments: {} },
          { type: "toolCall", id: "id2", name: "read", arguments: {} },
        ],
      } as any,
      {
        role: "toolResult",
        toolCallId: "id1",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 1,
      } as any,
      // id2 was never answered before user typed again
      {
        role: "user",
        content: [{ type: "text", text: "stop" }],
        timestamp: 2,
      } as any,
    ];

    const repaired = repairInterruptedToolCalls(messages);
    // Expect: assistant, toolResult(id1, real), toolResult(id2, synthetic), user
    expect(repaired.map((m) => m.role)).toEqual([
      "assistant",
      "toolResult",
      "toolResult",
      "user",
    ]);
    expect((repaired[1] as any).toolCallId).toBe("id1");
    expect((repaired[1] as any).isError).toBe(false);
    expect((repaired[2] as any).toolCallId).toBe("id2");
    expect((repaired[2] as any).isError).toBe(true);
  });

  it("coalesces synthetic tool_result + user text into one user message", () => {
    // After repair + the existing convertMessages logic, the API params for
    // the broken session would look like this:
    const params = [
      { role: "assistant", content: [{ type: "tool_use", id: "x" }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "x",
            content: "interrupted",
            is_error: true,
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "follow up" }] },
    ] as any;

    const merged = coalesceSameRoleMessages(params);

    expect(merged).toHaveLength(2);
    expect(merged[0].role).toBe("assistant");
    expect(merged[1].role).toBe("user");
    expect((merged[1].content as any[]).length).toBe(2);
    expect((merged[1].content as any[])[0].type).toBe("tool_result");
    expect((merged[1].content as any[])[1].type).toBe("text");
  });

  it("leaves an already-alternating params array untouched", () => {
    const params = [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      { role: "user", content: "thanks" },
    ] as any;
    const merged = coalesceSameRoleMessages(params);
    expect(merged).toEqual(params);
  });

  it("module exports the public streaming entry point", () => {
    expect(typeof streamVertexAnthropic).toBe("function");
    expect(typeof anthropicModels).toBe("function");
  });
});

describe("mapStopReason: Anthropic stop_reason -> pi StopReason", () => {
  // Pinned so a future Anthropic stop_reason addition that accidentally
  // falls through to the default "stop" branch is visible in test output
  // rather than silent on the wire. If you add a new explicit case in
  // production, add a row here too.
  it("maps end_turn / stop_sequence / pause_turn -> 'stop'", () => {
    expect(mapStopReason("end_turn")).toBe("stop");
    expect(mapStopReason("stop_sequence")).toBe("stop");
    expect(mapStopReason("pause_turn")).toBe("stop");
  });
  it("maps max_tokens -> 'length'", () => {
    expect(mapStopReason("max_tokens")).toBe("length");
  });
  it("maps tool_use -> 'toolUse'", () => {
    expect(mapStopReason("tool_use")).toBe("toolUse");
  });
  it("maps refusal / sensitive -> 'error'", () => {
    expect(mapStopReason("refusal")).toBe("error");
    expect(mapStopReason("sensitive")).toBe("error");
  });
  it("defaults unknown / null / undefined to 'stop' (defensive)", () => {
    expect(mapStopReason(null)).toBe("stop");
    expect(mapStopReason(undefined)).toBe("stop");
    expect(mapStopReason("some_future_value")).toBe("stop");
  });
});

describe("looksLikeStreamingJsonBug: heuristic for retrying streaming failures", () => {
  // The streaming entry point catches errors during the SSE iteration and
  // retries the request as non-streaming if the error message looks like
  // an SDK JSON-parse bug (anthropic-sdk-typescript #986 / #996). If
  // upstream changes the wording of those exceptions, this heuristic
  // stops firing and we silently lose the retry. These tests pin each
  // wording variant we know about; add new ones here when seen.

  it("matches the wording variants from #986 / #996", () => {
    expect(looksLikeStreamingJsonBug("Unexpected token } in JSON at position 42")).toBe(true);
    expect(looksLikeStreamingJsonBug("Bad escaped character")).toBe(true);
    expect(looksLikeStreamingJsonBug("partial-json: bad escape")).toBe(true);
    expect(looksLikeStreamingJsonBug("partial_json: malformed")).toBe(true);
    expect(looksLikeStreamingJsonBug("JSON.parse failed: Unexpected character")).toBe(true);
    expect(looksLikeStreamingJsonBug("Unrecognised escape sequence")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(looksLikeStreamingJsonBug("BAD ESCAPED CHAR")).toBe(true);
    expect(looksLikeStreamingJsonBug("json error")).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(looksLikeStreamingJsonBug("connection reset by peer")).toBe(false);
    expect(looksLikeStreamingJsonBug("401 Unauthorized")).toBe(false);
    expect(looksLikeStreamingJsonBug("context window exceeded")).toBe(false);
    expect(looksLikeStreamingJsonBug("")).toBe(false);
  });
});
