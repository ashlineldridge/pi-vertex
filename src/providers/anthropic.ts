import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import type {
  ContentBlockParam,
  MessageCreateParamsBase,
  MessageCreateParamsStreaming,
  MessageParam,
  Message as AnthropicMessage,
  TextBlockParam,
  ToolUnion,
} from "@anthropic-ai/sdk/resources/messages.js";
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  calculateCost,
  type Context,
  createAssistantMessageEventStream,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
  type TextContent,
  type ThinkingContent,
  type ImageContent,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
} from "@mariozechner/pi-ai";
import { parse as partialParse } from "partial-json";

export type AnthropicVertexModel = Model<"vertex-anthropic">;

// Model registry. Every value here is sourced from Vertex's per-model spec
// pages under https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/claude/
// PDF/Documents is listed as a separate input modality on those pages,
// but pi's `Model.input` enum only has `text` and `image`, so we can't
// surface that capability through this provider yet (would need a pi-ai
// type extension to express).
//
// Cost is intentionally zero. Vertex's published rates are now known and
// for the global endpoint match Anthropic-direct ($5/$25 input/output per
// million for Opus 4.6/4.7, $3/$15 for Sonnet 4.6, $1/$5 for Haiku 4.5).
// We still report zero because pi's single `cost` field can't express
// either of two real Vertex behaviours that affect the displayed total:
//
//   1. Regional endpoints carry a 10% premium over global (e.g. Opus 4.6
//      on us-east5 is $5.50/$27.50 vs $5/$25 on global).
//   2. At regional endpoints Sonnet has a >200K input premium tier
//      ($3.30/$16.50 below 200K, $6.60/$24.75 above). Global currently
//      doesn't apply this premium for the four models we ship, but the
//      tiering shape exists in Google's pricing docs.
//
// A previous release shipped hand-coded Anthropic-direct rates that went
// stale (Opus 4.6/4.7 carried the legacy 4.0/4.1 $15/$75 tier and
// over-reported by 3x). Zeroing out is the safest baseline given the
// regional/tier complexity. Token counts still flow through unchanged.
// Override per-model in `~/.pi/agent/models.json` via `modelOverrides` if
// you want a fixed approximate cost (the global rates above are a good
// starting point if your `GOOGLE_CLOUD_LOCATION` is `global`).
//
// Pricing source: https://cloud.google.com/vertex-ai/generative-ai/pricing
// (search "Anthropic's Claude models" — the page anchors are unstable).
// Per-model spec pages also link to /pricing#claude-models from their
// "Pricing" sections.
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

const CLAUDE_MODELS: Omit<AnthropicVertexModel, "api" | "provider" | "baseUrl">[] = [
  {
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    reasoning: true,
    input: ["text", "image"],
    cost: { ...ZERO_COST },
    contextWindow: 1000000,
    maxTokens: 128000,
  },
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    reasoning: true,
    input: ["text", "image"],
    cost: { ...ZERO_COST },
    contextWindow: 1000000,
    maxTokens: 128000,
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    reasoning: true,
    input: ["text", "image"],
    cost: { ...ZERO_COST },
    contextWindow: 1000000,
    maxTokens: 128000,
  },
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    reasoning: true,
    input: ["text", "image"],
    cost: { ...ZERO_COST },
    contextWindow: 200000,
    maxTokens: 64000,
  },

  // -manual variants: opt-in to manual `{ type: "enabled", budget_tokens }`
  // thinking instead of the default adaptive shape. Use for hard ceilings
  // on thinking spend or reproducible per-turn token usage. Same wire id
  // as the bare entry. Not exposed for Opus 4.7 (manual returns 400) or
  // Haiku 4.5 (already manual-only on its bare entry).
  {
    id: "claude-opus-4-6-manual",
    name: "Claude Opus 4.6 (manual thinking)",
    reasoning: true,
    input: ["text", "image"],
    cost: { ...ZERO_COST },
    contextWindow: 1000000,
    maxTokens: 128000,
  },
  {
    id: "claude-sonnet-4-6-manual",
    name: "Claude Sonnet 4.6 (manual thinking)",
    reasoning: true,
    input: ["text", "image"],
    cost: { ...ZERO_COST },
    contextWindow: 1000000,
    maxTokens: 128000,
  },

  // -max variant for Opus 4.7 only: pi `xhigh` maps to Anthropic effort
  // `max` instead of effort `xhigh`. Bare `claude-opus-4-7` is
  // name-faithful (pi xhigh -> effort xhigh, the docs' recommended
  // starting point for coding/agentic work). Pick this variant when you
  // want the docs' "no constraints on thinking depth" behaviour. Other
  // adaptive models don't need a -max variant: they have no `xhigh`
  // effort tier, so their bare ids already map pi xhigh -> max.
  {
    id: "claude-opus-4-7-max",
    name: "Claude Opus 4.7 (max effort)",
    reasoning: true,
    input: ["text", "image"],
    cost: { ...ZERO_COST },
    contextWindow: 1000000,
    maxTokens: 128000,
  },
];

// Exported for tests and for the streaming entry point. Strips pi-side
// suffix flags (`-manual`, `-max`) from a registry id to recover the bare
// Vertex publisher model id, and reports which flags were present. The
// two flags are mutually exclusive in the registry today.
export function deriveWireModelId(modelId: string): {
  wireId: string;
  isManualOverride: boolean;
  isMaxOverride: boolean;
} {
  if (modelId.endsWith("-manual")) {
    return {
      wireId: modelId.slice(0, -"-manual".length),
      isManualOverride: true,
      isMaxOverride: false,
    };
  }
  if (modelId.endsWith("-max")) {
    return {
      wireId: modelId.slice(0, -"-max".length),
      isManualOverride: false,
      isMaxOverride: true,
    };
  }
  return { wireId: modelId, isManualOverride: false, isMaxOverride: false };
}

export function anthropicModels(location: string): AnthropicVertexModel[] {
  const baseUrl =
    location === "global"
      ? "https://aiplatform.googleapis.com"
      : `https://${location}-aiplatform.googleapis.com`;

  return CLAUDE_MODELS.map((model) => ({
    ...model,
    provider: "vertex-anthropic",
    api: "vertex-anthropic" as const,
    baseUrl,
  }));
}

// =============================================================================
// Defensive helpers
// =============================================================================

/**
 * Strips characters that are technically valid Unicode but unsafe to ship to
 * the Anthropic API:
 *
 *   - Unpaired UTF-16 surrogate halves: JSON.stringify silently mangles or
 *     throws on these depending on runtime.
 *   - C0 control characters except common whitespace (TAB, LF, CR): some
 *     downstream parsers (proxies, server-side validators) reject these even
 *     though JSON.stringify escapes them.
 *   - DEL (U+007F) and the C1 control range U+0080–U+009F (includes NEL).
 *   - Unicode line/paragraph separators (U+2028, U+2029): valid JSON since
 *     ES2019 but treated as line terminators by Node's `readline` and other
 *     SSE pipelines, splitting payloads mid-string. See
 *     https://github.com/anthropics/anthropic-sdk-typescript/issues/882
 *
 * Properly paired surrogates (real emoji etc.) are preserved.
 */
function sanitizeText(text: string): string {
  return text.replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "",
  );
}

/**
 * Attempts to parse possibly-incomplete tool input JSON streamed from the
 * model. Always returns an object so callers never have to handle exceptions.
 *
 * Anthropic's docs explicitly warn that fine-grained tool streaming can emit
 * invalid or partial JSON, and the SDK's `partialParse` helper is known to
 * throw on certain unescaped sequences (e.g. PHP namespaces like `App\Http\..`,
 * regexes like `\d+`, Windows paths). See:
 *   https://github.com/anthropics/anthropic-sdk-typescript/issues/986
 *   https://github.com/anthropics/anthropic-sdk-typescript/issues/996
 */
function parseStreamingJson(partialJson: string): Record<string, unknown> {
  if (!partialJson || partialJson.trim() === "") {
    return {};
  }
  try {
    const parsed = JSON.parse(partialJson);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    try {
      const parsed = partialParse(partialJson);
      return isPlainObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// =============================================================================
// pi message <-> Anthropic message conversion
// =============================================================================

function convertContentBlocks(
  content: (TextContent | ImageContent)[],
):
  | string
  | Array<
      | { type: "text"; text: string }
      | {
          type: "image";
          source: { type: "base64"; media_type: string; data: string };
        }
    > {
  const hasImages = content.some((c) => c.type === "image");

  if (!hasImages) {
    return sanitizeText(
      content.map((c) => (c as TextContent).text).join("\n"),
    );
  }

  const blocks = content.map((block) => {
    if (block.type === "text") {
      return { type: "text" as const, text: sanitizeText(block.text) };
    }
    return {
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: block.mimeType as
          | "image/jpeg"
          | "image/png"
          | "image/gif"
          | "image/webp",
        data: block.data,
      },
    };
  });

  // Anthropic requires at least one text block when images are present.
  if (!blocks.some((b) => b.type === "text")) {
    blocks.unshift({ type: "text", text: "(see attached image)" });
  }

  return blocks;
}

/**
 * Pre-pass: repair an interrupted-session message history.
 *
 * When pi is stopped while a tool call is in flight (e.g. the user kills the
 * process during a long bash command), the session file persists the
 * assistant message that issued the tool call but never writes a matching
 * `toolResult` message. On resume, the next entry in the history is
 * whatever the user typed next.
 *
 * The Anthropic API hard-rejects this with:
 *   "tool_use ids were found without tool_result blocks immediately after"
 *
 * This pass walks the history and, for every assistant turn with `toolCall`
 * blocks whose ids are missing from the immediately following toolResult
 * messages, appends synthetic error toolResult messages. The result is a
 * pi-format history that satisfies the API contract.
 *
 * The pre-existing assistant -> toolResult* -> assistant flow is unchanged;
 * we only touch the broken case.
 */
// Exported for tests; not part of the package's public API.
export function repairInterruptedToolCalls(messages: Message[]): Message[] {
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

    // Find which ids already have a real result in the following run of
    // toolResult messages. We don't consume them — the main converter still
    // walks the input list normally.
    const seenIds = new Set<string>();
    let j = i + 1;
    while (j < messages.length && messages[j].role === "toolResult") {
      seenIds.add((messages[j] as ToolResultMessage).toolCallId);
      j++;
    }

    // Append the real toolResult messages, then synthetic results for any
    // tool calls that were never answered.
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
      } as ToolResultMessage);
    }

    // Skip past the messages we've just re-emitted in the outer loop.
    i = j - 1;
  }

  return repaired;
}

/**
 * Post-pass: merge consecutive same-role API messages into a single message
 * by concatenating their content blocks.
 *
 * The Anthropic Messages API expects user/assistant turns to alternate. In
 * pathological histories — most notably an interrupted session where we've
 * just injected a synthetic toolResult between an assistant turn and the
 * user's next typed message — we can end up emitting two adjacent user
 * messages (synthetic tool_result, then the user's text). The API accepts
 * mixed content blocks within a single user message (text, image,
 * tool_result), so coalescing them is both safe and the right shape.
 *
 * This is implemented as a defensive post-pass because the same shape can
 * also arise from other corruption patterns (e.g. two consecutive user
 * inputs persisted around an aborted assistant turn with empty content),
 * and handling it once at the boundary covers all of them.
 */
// Exported for tests; not part of the package's public API.
export function coalesceSameRoleMessages(params: MessageParam[]): MessageParam[] {
  const merged: MessageParam[] = [];

  for (const msg of params) {
    const last = merged[merged.length - 1];
    if (last && last.role === msg.role) {
      const lastBlocks =
        typeof last.content === "string"
          ? [{ type: "text" as const, text: last.content }]
          : last.content;
      const msgBlocks =
        typeof msg.content === "string"
          ? [{ type: "text" as const, text: msg.content }]
          : msg.content;
      merged[merged.length - 1] = {
        ...last,
        content: [...lastBlocks, ...msgBlocks],
      } as MessageParam;
    } else {
      merged.push(msg);
    }
  }

  return merged;
}

function convertMessages(
  rawMessages: Message[],
  model: AnthropicVertexModel,
): MessageParam[] {
  // Repair any interrupted tool calls before conversion. This keeps the
  // main loop simple — it can assume every tool_use has a tool_result.
  const messages = repairInterruptedToolCalls(rawMessages);
  const params: MessageParam[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        const sanitized = sanitizeText(msg.content);
        if (sanitized.trim().length > 0) {
          params.push({ role: "user", content: sanitized });
        }
        continue;
      }

      const blocks: ContentBlockParam[] = msg.content.map((item) => {
        if (item.type === "text") {
          return { type: "text", text: sanitizeText(item.text) };
        }
        return {
          type: "image",
          source: {
            type: "base64",
            media_type: item.mimeType as
              | "image/jpeg"
              | "image/png"
              | "image/gif"
              | "image/webp",
            data: item.data,
          },
        };
      });

      // Drop image blocks if the model doesn't accept them.
      let filtered = !model.input.includes("image")
        ? blocks.filter((b) => b.type !== "image")
        : blocks;

      // Drop empty text blocks.
      filtered = filtered.filter((b) => {
        if (b.type === "text") return b.text.trim().length > 0;
        return true;
      });

      if (filtered.length > 0) {
        params.push({ role: "user", content: filtered });
      }
    } else if (msg.role === "assistant") {
      const blocks: ContentBlockParam[] = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          if (block.text.trim().length === 0) continue;
          blocks.push({ type: "text", text: sanitizeText(block.text) });
        } else if (block.type === "thinking") {
          // Redacted thinking: pass the opaque payload back.
          if (block.redacted && block.thinkingSignature) {
            blocks.push({
              type: "redacted_thinking",
              data: block.thinkingSignature,
            });
            continue;
          }
          if (block.thinking.trim().length === 0) continue;
          // No signature -> demote to plain text. The Anthropic API rejects
          // thinking blocks without a valid signature, and a half-streamed
          // thinking block (e.g. from an aborted turn) won't have one.
          if (
            !block.thinkingSignature ||
            block.thinkingSignature.trim().length === 0
          ) {
            blocks.push({
              type: "text",
              text: sanitizeText(block.thinking),
            });
          } else {
            blocks.push({
              type: "thinking",
              thinking: sanitizeText(block.thinking),
              signature: block.thinkingSignature,
            });
          }
        } else if (block.type === "toolCall") {
          blocks.push({
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.arguments ?? {},
          });
        }
      }

      if (blocks.length > 0) {
        params.push({ role: "assistant", content: blocks });
      }
    } else if (msg.role === "toolResult") {
      // Coalesce consecutive tool results into a single user message, which
      // Anthropic requires when multiple tool calls were made in a turn.
      const toolResults: ContentBlockParam[] = [
        {
          type: "tool_result",
          tool_use_id: msg.toolCallId,
          content: convertContentBlocks(msg.content) as
            | string
            | Array<TextBlockParam | { type: "image"; source: any }>,
          is_error: msg.isError,
        },
      ];

      let j = i + 1;
      while (j < messages.length && messages[j].role === "toolResult") {
        const nextMsg = messages[j] as ToolResultMessage;
        toolResults.push({
          type: "tool_result",
          tool_use_id: nextMsg.toolCallId,
          content: convertContentBlocks(nextMsg.content) as
            | string
            | Array<TextBlockParam | { type: "image"; source: any }>,
          is_error: nextMsg.isError,
        });
        j++;
      }
      i = j - 1;

      params.push({ role: "user", content: toolResults });
    }
  }

  // Defensive post-pass: merge any adjacent same-role messages that slipped
  // through (most commonly: synthetic tool_result + user's next typed text
  // after an interrupted session). See coalesceSameRoleMessages docs.
  return coalesceSameRoleMessages(params);
}

function convertTools(tools: Tool[]): ToolUnion[] {
  return tools.map((tool) => {
    const schema = tool.parameters as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    return {
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: "object" as const,
        properties: schema.properties ?? {},
        required: schema.required ?? [],
      },
    };
  });
}

// Exported for tests; not part of the package's public API.
export function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "toolUse";
    case "refusal":
    case "sensitive":
      return "error";
    default:
      // Unknown stop reasons are treated as a normal stop rather than
      // throwing, so a future API addition doesn't break the turn. The
      // `mapStopReason` test pins the known cases so a regression that
      // accidentally lands in this default branch is easy to spot when
      // the suite drift between Anthropic's documented stop_reasons and
      // ours grows.
      return "stop";
  }
}

// Exported for tests. Heuristic match on the SDK's error message text used
// to decide whether to retry a streaming failure as a non-streaming call.
// Anthropic SDK bugs #986 / #996 surface as JSON.parse / partialParse
// throws; retrying without `stream: true` exercises a different SDK code
// path that doesn't trigger the buggy `partialParse` helper. If upstream
// rewords its JSON-parse errors in a future release, this heuristic must
// be updated or the retry stops firing.
export function looksLikeStreamingJsonBug(errorMessage: string): boolean {
  return /JSON|Unexpected|escape|partial[_-]?json|Bad escaped/i.test(errorMessage);
}

// =============================================================================
// Reasoning / thinking configuration
// =============================================================================
//
// Two thinking-config shapes are in play; per-model rules from
// https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking
// and .../effort:
//
//   1. Manual / budget-based:
//        { type: "enabled", budget_tokens: <number> }
//      Works on every reasoning-capable Claude model EXCEPT Opus 4.7+,
//      where it returns a 400 ("Manual extended thinking is no longer
//      supported on Claude Opus 4.7 or later models").
//
//   2. Adaptive + effort:
//        thinking: { type: "adaptive", display: "summarized" }
//        output_config: { effort: "low" | "medium" | "high" | "xhigh" | "max" }
//      Required on Opus 4.7. Recommended on Opus 4.6 and Sonnet 4.6.
//
// Effort levels per model (from the effort docs):
//   - Opus 4.7:    low, medium, high, xhigh, max  (5 levels)
//   - Opus 4.6:    low, medium, high, max         (no xhigh)
//   - Sonnet 4.6:  low, medium, high, max         (no xhigh)
//   - Haiku 4.5:   effort not supported on Vertex; manual budget ladder
//
// Mapping pi level -> wire shape:
//
//   pi level  | Opus 4.7 (bare)  | Opus 4.7 (-max)  | Opus 4.6 / Sonnet 4.6 | Haiku 4.5
//   ----------|------------------|------------------|------------------------|----------
//   minimal   | low              | low              | low                    | budget 1024
//   low       | low              | medium           | low                    | budget 4096
//   medium    | medium           | high             | medium                 | budget 10240
//   high      | high             | xhigh            | high                   | budget 20480
//   xhigh     | xhigh            | max              | max                    | budget 32768
//
// Bare `claude-opus-4-7` is name-faithful: pi xhigh -> Anthropic effort
// xhigh (the docs' recommended starting point for coding/agentic work).
// `max` is unreachable from this id by design.
//
// `claude-opus-4-7-max` is an opt-in variant that rounds every pi level
// (except minimal) up by one effort tier. All 5 native Opus 4.7 efforts
// are reachable from pi's 5 user levels, and every cell bumps to a more
// aggressive setting than the bare id. Pick when you want consistently
// more thinking, not just `max` at the top tier.
//
// Opus 4.6 / Sonnet 4.6 have no xhigh effort tier, so their bare ids
// already map pi xhigh -> max (no -max variant needed).
//
// Verified live on Vertex global endpoint.

// Exported for tests so a regression in this list fails the suite rather
// than silently sending a 400 to Vertex on the next Opus 4.7 turn.
export const ADAPTIVE_THINKING_MODELS = ["opus-4-6", "opus-4-7", "sonnet-4-6"];

export function supportsAdaptiveThinking(modelId: string): boolean {
  return ADAPTIVE_THINKING_MODELS.some((m) => modelId.includes(m));
}

function reasoningToBudget(
  level: NonNullable<SimpleStreamOptions["reasoning"]>,
  custom?: SimpleStreamOptions["thinkingBudgets"],
): number {
  const defaults: Record<typeof level, number> = {
    minimal: 1024,
    low: 4096,
    medium: 10240,
    high: 20480,
    xhigh: 32768,
  };
  // pi-ai's `ThinkingBudgets` type is `{ minimal?, low?, medium?, high? }`
  // — no `xhigh` slot. When the user picks pi `xhigh` and has supplied
  // a `thinkingBudgets` override, we fall back to their `high` override
  // (the closest available key) before our default. If pi-ai later adds
  // `xhigh` to ThinkingBudgets, prefer that.
  if (level === "xhigh") return custom?.high ?? defaults.xhigh;
  return custom?.[level] ?? defaults[level];
}

// Exported for tests so a regression in this mapping fails the suite
// rather than silently sending an unsupported effort string and 400ing,
// or shipping a less aggressive level than the user picked. See the long
// comment block above for the per-model availability rule and citations.
//
// `wireModelId` is the bare Vertex publisher id (no `-max`/`-manual`
// suffix). `isMaxOverride` is true when the user picked the `-max`
// variant on Opus 4.7 and means "map pi xhigh to effort max instead of
// xhigh."
export function reasoningToEffort(
  level: NonNullable<SimpleStreamOptions["reasoning"]>,
  wireModelId: string,
  isMaxOverride = false,
): "low" | "medium" | "high" | "xhigh" | "max" {
  // Opus 4.7: name-faithful by default. The -max variant rounds every
  // pi level (except minimal) up by one effort tier.
  if (wireModelId.includes("opus-4-7")) {
    if (isMaxOverride) {
      switch (level) {
        case "minimal": return "low";
        case "low":     return "medium";
        case "medium":  return "high";
        case "high":    return "xhigh";
        case "xhigh":   return "max";
      }
    }
    switch (level) {
      case "minimal":
      case "low":     return "low";
      case "medium":  return "medium";
      case "high":    return "high";
      case "xhigh":   return "xhigh";
    }
  }

  // Opus 4.6 / Sonnet 4.6: name-faithful through high; pi xhigh is the
  // only way to reach effort `max` (these models lack `xhigh`). Pi
  // minimal collapses with low. (`isMaxOverride` is irrelevant: these
  // models don't have a -max variant because xhigh already maps to max.)
  if (wireModelId.includes("opus-4-6") || wireModelId.includes("sonnet-4-6")) {
    switch (level) {
      case "minimal":
      case "low":     return "low";
      case "medium":  return "medium";
      case "high":    return "high";
      case "xhigh":   return "max";
    }
  }

  // Partial-edit guard: this fallback is only reachable if a future
  // contributor adds an id to ADAPTIVE_THINKING_MODELS without also
  // adding a per-model branch above. The dispatch in
  // `streamVertexAnthropic` only calls us when supportsAdaptiveThinking
  // returned true, so any unrecognised wireModelId here is a
  // configuration mistake. Warn loudly and return a safe value
  // (high is documented as available on every adaptive Claude model;
  // xhigh is Opus-4.7-only and would 400 elsewhere).
  console.warn(
    `[pi-vertex] reasoningToEffort: unrecognised adaptive wireModelId "${wireModelId}" — ` +
      `add a per-model branch in reasoningToEffort or remove the id from ` +
      `ADAPTIVE_THINKING_MODELS. Falling back to safe effort levels.`,
  );
  switch (level) {
    case "minimal":
    case "low":     return "low";
    case "medium":  return "medium";
    case "high":
    case "xhigh":   return "high";
  }
}

// =============================================================================
// Streaming entry point
// =============================================================================

interface StreamingBlockState {
  index: number;
  partialJson?: string;
}

/**
 * Convert a non-streaming Anthropic Message into the same event sequence we
 * would have emitted from a successful stream. Used by the non-streaming retry
 * fallback when the streaming SDK throws mid-turn (typically on malformed JSON
 * from #986/#996).
 */
function emitMessageAsEvents(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  output: AssistantMessage,
  message: AnthropicMessage,
): void {
  for (const block of message.content) {
    const idx = output.content.length;

    if (block.type === "text") {
      output.content.push({ type: "text", text: block.text });
      stream.push({ type: "text_start", contentIndex: idx, partial: output });
      if (block.text.length > 0) {
        stream.push({
          type: "text_delta",
          contentIndex: idx,
          delta: block.text,
          partial: output,
        });
      }
      stream.push({
        type: "text_end",
        contentIndex: idx,
        content: block.text,
        partial: output,
      });
    } else if (block.type === "thinking") {
      const tc: ThinkingContent = {
        type: "thinking",
        thinking: block.thinking,
        thinkingSignature: block.signature ?? "",
      };
      output.content.push(tc);
      stream.push({
        type: "thinking_start",
        contentIndex: idx,
        partial: output,
      });
      if (block.thinking.length > 0) {
        stream.push({
          type: "thinking_delta",
          contentIndex: idx,
          delta: block.thinking,
          partial: output,
        });
      }
      stream.push({
        type: "thinking_end",
        contentIndex: idx,
        content: block.thinking,
        partial: output,
      });
    } else if (block.type === "redacted_thinking") {
      const tc: ThinkingContent = {
        type: "thinking",
        thinking: "[Reasoning redacted]",
        thinkingSignature: block.data,
        redacted: true,
      };
      output.content.push(tc);
      stream.push({
        type: "thinking_start",
        contentIndex: idx,
        partial: output,
      });
      stream.push({
        type: "thinking_end",
        contentIndex: idx,
        content: tc.thinking,
        partial: output,
      });
    } else if (block.type === "tool_use") {
      const args = isPlainObject(block.input) ? block.input : {};
      const toolCall: ToolCall = {
        type: "toolCall",
        id: block.id,
        name: block.name,
        arguments: args as Record<string, any>,
      };
      output.content.push(toolCall);
      stream.push({
        type: "toolcall_start",
        contentIndex: idx,
        partial: output,
      });
      stream.push({
        type: "toolcall_end",
        contentIndex: idx,
        toolCall,
        partial: output,
      });
    }
  }
}

export function streamVertexAnthropic(
  model: Model<"vertex-anthropic">,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "vertex-anthropic",
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    // Track per-block streaming state by Anthropic's stable block index. The
    // pi `output.content` index can drift if blocks arrive out of order, so we
    // key on Anthropic's `event.index` and look it up.
    const blockStates = new Map<number, StreamingBlockState>();

    const findContentIndex = (anthropicIndex: number): number => {
      for (const [i, block] of output.content.entries()) {
        const state = (block as any).__streamIndex as number | undefined;
        if (state === anthropicIndex) return i;
      }
      return -1;
    };

    const stripScratch = () => {
      for (const block of output.content) {
        delete (block as any).__streamIndex;
      }
    };

    const projectId =
      process.env.GOOGLE_CLOUD_PROJECT ||
      process.env.GCLOUD_PROJECT ||
      process.env.ANTHROPIC_VERTEX_PROJECT_ID ||
      process.env.VERTEX_PROJECT_ID;
    const location =
      process.env.GOOGLE_CLOUD_LOCATION ||
      process.env.CLOUD_ML_REGION ||
      process.env.VERTEX_REGION;

    if (!projectId) {
      const err = new Error(
        "Vertex AI requires a project ID. Set GOOGLE_CLOUD_PROJECT or GCLOUD_PROJECT.",
      );
      output.stopReason = "error";
      output.errorMessage = err.message;
      stream.push({ type: "error", reason: "error", error: output });
      stream.end();
      return;
    }
    if (!location) {
      const err = new Error(
        "Vertex AI requires a region. Set GOOGLE_CLOUD_LOCATION.",
      );
      output.stopReason = "error";
      output.errorMessage = err.message;
      stream.push({ type: "error", reason: "error", error: output });
      stream.end();
      return;
    }

    // -------------------------------------------------------------------------
    // Build client + request params
    // -------------------------------------------------------------------------
    const clientOptions: ConstructorParameters<typeof AnthropicVertex>[0] = {
      region: location,
      projectId,
    };

    // Strip the optional `-manual` / `-max` suffix to recover the bare
    // Vertex publisher model id. Both suffixes are pi-side fictions that
    // flip per-model behaviour:
    //   - `-manual`: use manual `{ type: "enabled", budget_tokens }`
    //     instead of adaptive (only meaningful on Opus 4.6 / Sonnet 4.6).
    //   - `-max`:    pi xhigh maps to Anthropic effort `max` instead of
    //     effort `xhigh` (only meaningful on Opus 4.7).
    // Same wire model id is sent to Vertex either way.
    const { wireId: modelId, isManualOverride, isMaxOverride } = deriveWireModelId(model.id);

    // NB: We deliberately do *not* enable `fine-grained-tool-streaming-2025-05-14`.
    // That beta is what produces the malformed-JSON tool inputs reported in
    // anthropic-sdk-typescript#986 and #996. Without it, the server emits
    // tool input as a single complete JSON document, which the SDK can parse
    // safely. (We don't enable any beta header by default.)

    if (options?.headers) {
      clientOptions.defaultHeaders = {
        ...(clientOptions.defaultHeaders as Record<string, string> | undefined),
        ...options.headers,
      };
    }

    const client = new AnthropicVertex(clientOptions);

    const messages = convertMessages(context.messages, model as AnthropicVertexModel);

    const baseParams: MessageCreateParamsBase = {
      model: modelId,
      messages,
      max_tokens: options?.maxTokens || Math.floor(model.maxTokens / 3),
    };

    if (context.systemPrompt) {
      baseParams.system = [
        { type: "text", text: sanitizeText(context.systemPrompt) },
      ];
    }

    if (context.tools && context.tools.length > 0) {
      baseParams.tools = convertTools(context.tools);
    }

    // Reasoning / thinking config. Temperature is incompatible with thinking,
    // so apply it only when thinking is off. The two-shape rule lives in
    // supportsAdaptiveThinking / reasoningToEffort / reasoningToBudget above
    // (see the long comment block on `ADAPTIVE_THINKING_MODELS`). Opus 4.7
    // will 400 if we send manual config, so this dispatch is not optional.
    //
    // -manual forces the manual branch on models that support both shapes.
    // -max changes only the xhigh effort mapping inside the adaptive branch.
    let thinkingEnabled = false;
    if (model.reasoning && options?.reasoning) {
      thinkingEnabled = true;
      if (!isManualOverride && supportsAdaptiveThinking(modelId)) {
        const effort = reasoningToEffort(options.reasoning, modelId, isMaxOverride);
        // `display: "summarized"` is required so thinking blocks come
        // back populated on Opus 4.7, where Anthropic silently changed
        // the default from "summarized" (4.6) to "omitted" (4.7). Without
        // this, Opus 4.7 thinking blocks would be empty.
        (baseParams as any).thinking = { type: "adaptive", display: "summarized" };
        (baseParams as any).output_config = { effort };
      } else {
        const budget = reasoningToBudget(options.reasoning, options.thinkingBudgets);
        if (baseParams.max_tokens <= budget) {
          baseParams.max_tokens = budget + 1024;
        }
        (baseParams as any).thinking = {
          type: "enabled",
          budget_tokens: budget,
        };
      }
    } else if (model.reasoning && options?.reasoning === undefined) {
      // No-op: omit thinking config entirely so the model uses its default.
    }

    if (!thinkingEnabled && options?.temperature !== undefined) {
      baseParams.temperature = options.temperature;
    }

    if (options?.metadata) {
      const userId = options.metadata.user_id;
      if (typeof userId === "string") {
        baseParams.metadata = { user_id: userId };
      }
    }

    // -------------------------------------------------------------------------
    // Helper: apply usage updates from a Message or message_start event
    // -------------------------------------------------------------------------
    const applyUsage = (usage: {
      input_tokens?: number | null;
      output_tokens?: number | null;
      cache_read_input_tokens?: number | null;
      cache_creation_input_tokens?: number | null;
    }) => {
      if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
      if (usage.output_tokens != null) output.usage.output = usage.output_tokens;
      if (usage.cache_read_input_tokens != null) {
        output.usage.cacheRead = usage.cache_read_input_tokens;
      }
      if (usage.cache_creation_input_tokens != null) {
        output.usage.cacheWrite = usage.cache_creation_input_tokens;
      }
      output.usage.totalTokens =
        output.usage.input +
        output.usage.output +
        output.usage.cacheRead +
        output.usage.cacheWrite;
      calculateCost(model, output.usage);
    };

    // -------------------------------------------------------------------------
    // Attempt 1: streaming
    // -------------------------------------------------------------------------
    let streamingError: unknown = null;
    let startEmitted = false;

    try {
      const streamingParams: MessageCreateParamsStreaming = {
        ...baseParams,
        stream: true,
      };

      const messageStream = await client.messages.create(streamingParams, {
        signal: options?.signal,
      });

      stream.push({ type: "start", partial: output });
      startEmitted = true;

      for await (const event of messageStream) {
        if (event.type === "message_start") {
          output.responseId = event.message.id;
          applyUsage(event.message.usage);
        } else if (event.type === "content_block_start") {
          const cb = event.content_block;
          if (cb.type === "text") {
            const block: TextContent & { __streamIndex?: number } = {
              type: "text",
              text: "",
            };
            (block as any).__streamIndex = event.index;
            output.content.push(block);
            blockStates.set(event.index, { index: event.index });
            stream.push({
              type: "text_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          } else if (cb.type === "thinking") {
            const block: ThinkingContent = {
              type: "thinking",
              thinking: "",
              thinkingSignature: "",
            };
            (block as any).__streamIndex = event.index;
            output.content.push(block);
            blockStates.set(event.index, { index: event.index });
            stream.push({
              type: "thinking_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          } else if (cb.type === "redacted_thinking") {
            const block: ThinkingContent = {
              type: "thinking",
              thinking: "[Reasoning redacted]",
              thinkingSignature: cb.data,
              redacted: true,
            };
            (block as any).__streamIndex = event.index;
            output.content.push(block);
            blockStates.set(event.index, { index: event.index });
            stream.push({
              type: "thinking_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          } else if (cb.type === "tool_use") {
            const block: ToolCall = {
              type: "toolCall",
              id: cb.id,
              name: cb.name,
              arguments: isPlainObject(cb.input) ? (cb.input as Record<string, any>) : {},
            };
            (block as any).__streamIndex = event.index;
            output.content.push(block);
            blockStates.set(event.index, { index: event.index, partialJson: "" });
            stream.push({
              type: "toolcall_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          }
        } else if (event.type === "content_block_delta") {
          const idx = findContentIndex(event.index);
          if (idx < 0) continue;
          const block = output.content[idx];
          const state = blockStates.get(event.index);

          if (event.delta.type === "text_delta" && block.type === "text") {
            block.text += event.delta.text;
            stream.push({
              type: "text_delta",
              contentIndex: idx,
              delta: event.delta.text,
              partial: output,
            });
          } else if (
            event.delta.type === "thinking_delta" &&
            block.type === "thinking"
          ) {
            block.thinking += event.delta.thinking;
            stream.push({
              type: "thinking_delta",
              contentIndex: idx,
              delta: event.delta.thinking,
              partial: output,
            });
          } else if (
            event.delta.type === "signature_delta" &&
            block.type === "thinking"
          ) {
            // Required for multi-turn: thinking blocks must be sent back with
            // their signature, otherwise the API rejects them.
            block.thinkingSignature =
              (block.thinkingSignature ?? "") + event.delta.signature;
          } else if (
            event.delta.type === "input_json_delta" &&
            block.type === "toolCall" &&
            state
          ) {
            state.partialJson = (state.partialJson ?? "") + event.delta.partial_json;
            block.arguments = parseStreamingJson(state.partialJson);
            stream.push({
              type: "toolcall_delta",
              contentIndex: idx,
              delta: event.delta.partial_json,
              partial: output,
            });
          }
        } else if (event.type === "content_block_stop") {
          const idx = findContentIndex(event.index);
          if (idx < 0) continue;
          const block = output.content[idx];
          delete (block as any).__streamIndex;
          const state = blockStates.get(event.index);
          blockStates.delete(event.index);

          if (block.type === "text") {
            stream.push({
              type: "text_end",
              contentIndex: idx,
              content: block.text,
              partial: output,
            });
          } else if (block.type === "thinking") {
            stream.push({
              type: "thinking_end",
              contentIndex: idx,
              content: block.thinking,
              partial: output,
            });
          } else if (block.type === "toolCall") {
            // Final defensive parse of the complete buffer.
            block.arguments = parseStreamingJson(state?.partialJson ?? "");
            stream.push({
              type: "toolcall_end",
              contentIndex: idx,
              toolCall: block,
              partial: output,
            });
          }
        } else if (event.type === "message_delta") {
          if (event.delta.stop_reason) {
            output.stopReason = mapStopReason(event.delta.stop_reason);
          }
          if (event.usage) applyUsage(event.usage);
        }
      }

      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }
    } catch (err) {
      streamingError = err;
    }

    // -------------------------------------------------------------------------
    // If streaming worked, finalize and return
    // -------------------------------------------------------------------------
    if (!streamingError) {
      stripScratch();
      stream.push({
        type: "done",
        reason: output.stopReason as "stop" | "length" | "toolUse",
        message: output,
      });
      stream.end();
      return;
    }

    // -------------------------------------------------------------------------
    // Streaming failed. Decide whether to retry in non-streaming mode.
    //
    // Mitigation B: known SDK bugs (anthropic-sdk-typescript#986, #996) cause
    // `JSON.parse` / `partialParse` to throw mid-stream on malformed tool
    // input or SSE envelope. Re-issuing the same request without streaming
    // bypasses both code paths and usually recovers the turn.
    // -------------------------------------------------------------------------
    const errorMessage =
      streamingError instanceof Error
        ? streamingError.message
        : String(streamingError);

    const isAborted = options?.signal?.aborted;
    const looksLikeJsonParseBug = !isAborted && looksLikeStreamingJsonBug(errorMessage);

    if (isAborted) {
      stripScratch();
      output.stopReason = "aborted";
      output.errorMessage = errorMessage;
      stream.push({ type: "error", reason: "aborted", error: output });
      stream.end();
      return;
    }

    if (!looksLikeJsonParseBug) {
      // Network errors, auth errors, etc. — retry won't help.
      stripScratch();
      output.stopReason = "error";
      output.errorMessage = errorMessage;
      stream.push({ type: "error", reason: "error", error: output });
      stream.end();
      return;
    }

    // Reset partial state from the failed streaming attempt.
    stripScratch();
    output.content = [];
    output.usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    output.stopReason = "stop";
    output.responseId = undefined;

    // We may have already pushed `start`. If we did, downstream consumers
    // expect a matching done/error before the stream ends. We continue with
    // the same stream so the consumer just sees a turn that reset and finished.
    if (!startEmitted) {
      stream.push({ type: "start", partial: output });
    }

    try {
      const nonStreamParams: MessageCreateParamsBase = {
        ...baseParams,
        stream: false,
      };
      const message = (await client.messages.create(nonStreamParams as any, {
        signal: options?.signal,
      })) as AnthropicMessage;

      applyUsage(message.usage);
      output.responseId = message.id;
      output.stopReason = mapStopReason(message.stop_reason);

      emitMessageAsEvents(stream, output, message);

      stream.push({
        type: "done",
        reason: output.stopReason as "stop" | "length" | "toolUse",
        message: output,
      });
      stream.end();
    } catch (retryErr) {
      const retryMessage =
        retryErr instanceof Error ? retryErr.message : String(retryErr);
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      // Surface both errors so users can tell this was a retry that also failed.
      output.errorMessage = `Streaming failed (${errorMessage}); non-streaming retry also failed (${retryMessage})`;
      stream.push({
        type: "error",
        reason: output.stopReason as "error" | "aborted",
        error: output,
      });
      stream.end();
    }

  })();

  return stream;
}
