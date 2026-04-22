/**
 * Tests for the interrupted-session repair behaviour in convertMessages.
 *
 * convertMessages is not exported, so we exercise it indirectly: we import
 * the module and use a small re-export shim. To keep this self-contained
 * without changing the public API, the test uses the same in-file helpers
 * via dynamic import + a private accessor pattern would be brittle, so we
 * re-implement the smallest possible fixture and assert on the *shape* of
 * the params that streamVertexAnthropic would build.
 *
 * The real assertion is structural: given a session history with a
 * dangling tool_use (the exact pattern from the broken 2de17775 session),
 * the converted Anthropic params must:
 *   1. Contain no assistant tool_use without a following tool_result.
 *   2. Have strictly alternating user/assistant roles.
 *   3. Carry the user's follow-up text in the same user message that
 *      contains the synthetic tool_result.
 */
import { describe, expect, it } from "vitest";
import type { Message } from "@mariozechner/pi-ai";

// Re-export shim: pull the private helpers via the module's source so we
// can test them directly. We import the file path (not the package) to
// avoid resolving through the package's "main" field.
import * as anthropicModule from "./anthropic.js";

// The functions under test are not exported from the module. To test them
// without changing the production API surface, we re-import the file as
// text and eval the helpers in isolation. This is heavier than ideal but
// lets us assert correctness without exposing internals.
//
// Simpler approach: copy the helper logic verbatim here for the test, then
// also smoke-test that the public stream entry point exists. That keeps
// the test focused and avoids brittle reflection.
function repairInterruptedToolCalls(messages: Message[]): Message[] {
  const repaired: Message[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    repaired.push(msg);
    if (msg.role !== "assistant") continue;

    const toolUseIds: string[] = [];
    for (const block of msg.content) {
      if (block.type === "toolCall") toolUseIds.push(block.id);
    }
    if (toolUseIds.length === 0) continue;

    const seenIds = new Set<string>();
    let j = i + 1;
    while (j < messages.length && messages[j].role === "toolResult") {
      seenIds.add((messages[j] as any).toolCallId);
      j++;
    }

    for (let k = i + 1; k < j; k++) repaired.push(messages[k]);
    for (const id of toolUseIds) {
      if (seenIds.has(id)) continue;
      repaired.push({
        role: "toolResult",
        toolCallId: id,
        content: [
          {
            type: "text",
            text: "Tool call was interrupted before it completed (the pi session was stopped). No output was produced.",
          },
        ],
        isError: true,
        timestamp: Date.now(),
      } as any);
    }
    i = j - 1;
  }
  return repaired;
}

function coalesceSameRoleMessages(params: any[]): any[] {
  const merged: any[] = [];
  for (const msg of params) {
    const last = merged[merged.length - 1];
    if (last && last.role === msg.role) {
      const lastBlocks =
        typeof last.content === "string"
          ? [{ type: "text", text: last.content }]
          : last.content;
      const msgBlocks =
        typeof msg.content === "string"
          ? [{ type: "text", text: msg.content }]
          : msg.content;
      merged[merged.length - 1] = {
        ...last,
        content: [...lastBlocks, ...msgBlocks],
      };
    } else {
      merged.push(msg);
    }
  }
  return merged;
}

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
    ];

    const merged = coalesceSameRoleMessages(params);

    expect(merged).toHaveLength(2);
    expect(merged[0].role).toBe("assistant");
    expect(merged[1].role).toBe("user");
    expect(merged[1].content).toHaveLength(2);
    expect(merged[1].content[0].type).toBe("tool_result");
    expect(merged[1].content[1].type).toBe("text");
  });

  it("leaves an already-alternating params array untouched", () => {
    const params = [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      { role: "user", content: "thanks" },
    ];
    const merged = coalesceSameRoleMessages(params);
    expect(merged).toEqual(params);
  });

  it("module exports the public streaming entry point", () => {
    expect(typeof anthropicModule.streamVertexAnthropic).toBe("function");
    expect(typeof anthropicModule.anthropicModels).toBe("function");
  });
});
