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

// Latest Claude models with accurate pricing and limits.
const CLAUDE_MODELS: Omit<AnthropicVertexModel, "api" | "provider" | "baseUrl">[] = [
  // Opus models
  {
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    contextWindow: 200000,
    maxTokens: 128000,
  },
  {
    id: "claude-opus-4-7[1m]",
    name: "Claude Opus 4.7 [1M]",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    contextWindow: 1000000,
    maxTokens: 128000,
  },
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    contextWindow: 200000,
    maxTokens: 128000,
  },
  {
    id: "claude-opus-4-6[1m]",
    name: "Claude Opus 4.6 [1M]",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    contextWindow: 1000000,
    maxTokens: 128000,
  },

  // Sonnet models
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200000,
    maxTokens: 64000,
  },
  {
    id: "claude-sonnet-4-6[1m]",
    name: "Claude Sonnet 4.6 [1M]",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 1000000,
    maxTokens: 64000,
  },

  // Haiku models
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    contextWindow: 200000,
    maxTokens: 64000,
  },
];

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
 * Removes unpaired Unicode surrogate characters that cause JSON serialization
 * failures in many API providers. Properly paired surrogates (valid emoji,
 * etc.) are preserved.
 */
function sanitizeSurrogates(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
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
    return sanitizeSurrogates(
      content.map((c) => (c as TextContent).text).join("\n"),
    );
  }

  const blocks = content.map((block) => {
    if (block.type === "text") {
      return { type: "text" as const, text: sanitizeSurrogates(block.text) };
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

function convertMessages(
  messages: Message[],
  model: AnthropicVertexModel,
): MessageParam[] {
  const params: MessageParam[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        const sanitized = sanitizeSurrogates(msg.content);
        if (sanitized.trim().length > 0) {
          params.push({ role: "user", content: sanitized });
        }
        continue;
      }

      const blocks: ContentBlockParam[] = msg.content.map((item) => {
        if (item.type === "text") {
          return { type: "text", text: sanitizeSurrogates(item.text) };
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
          blocks.push({ type: "text", text: sanitizeSurrogates(block.text) });
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
              text: sanitizeSurrogates(block.thinking),
            });
          } else {
            blocks.push({
              type: "thinking",
              thinking: sanitizeSurrogates(block.thinking),
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

  return params;
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

function mapStopReason(reason: string | null | undefined): StopReason {
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
      // Unknown stop reasons are treated as a normal stop rather than throwing,
      // so a future API addition doesn't break the turn.
      return "stop";
  }
}

// =============================================================================
// Reasoning / thinking configuration
// =============================================================================

const ADAPTIVE_THINKING_MODELS = ["opus-4-6", "opus-4-7", "sonnet-4-6"];

function supportsAdaptiveThinking(modelId: string): boolean {
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
  if (level === "xhigh") return custom?.high ?? defaults.xhigh;
  return custom?.[level] ?? defaults[level];
}

function reasoningToEffort(
  level: NonNullable<SimpleStreamOptions["reasoning"]>,
  modelId: string,
): "low" | "medium" | "high" | "xhigh" | "max" {
  switch (level) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      // Opus 4.6 calls the top tier "max"; Opus 4.7 calls it "xhigh".
      if (modelId.includes("opus-4-6")) return "max";
      if (modelId.includes("opus-4-7")) return "xhigh";
      return "high";
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

    // Vertex requires the bare model id; pi exposes `[1m]` as a suffix to
    // distinguish the 1M context variant.
    const modelId = model.id.replace("[1m]", "");
    const is1M = model.id.endsWith("[1m]");

    const betaFeatures: string[] = [];
    if (is1M) betaFeatures.push("context-1m-2025-08-07");
    // NB: We deliberately do *not* enable `fine-grained-tool-streaming-2025-05-14`.
    // That beta is what produces the malformed-JSON tool inputs reported in
    // anthropic-sdk-typescript#986 and #996. Without it, the server emits
    // tool input as a single complete JSON document, which the SDK can parse
    // safely.
    if (betaFeatures.length > 0) {
      clientOptions.defaultHeaders = {
        ...(clientOptions.defaultHeaders as Record<string, string> | undefined),
        "anthropic-beta": betaFeatures.join(","),
      };
    }

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
        { type: "text", text: sanitizeSurrogates(context.systemPrompt) },
      ];
    }

    if (context.tools && context.tools.length > 0) {
      baseParams.tools = convertTools(context.tools);
    }

    // Reasoning / thinking config. Temperature is incompatible with thinking,
    // so apply it only when thinking is off.
    let thinkingEnabled = false;
    if (model.reasoning && options?.reasoning) {
      thinkingEnabled = true;
      if (supportsAdaptiveThinking(model.id)) {
        const effort = reasoningToEffort(options.reasoning, model.id);
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
    let producedAnyEvent = false;

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
        producedAnyEvent = true;

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
    const looksLikeJsonParseBug =
      !isAborted &&
      /JSON|Unexpected|escape|partial[_-]?json|Bad escaped/i.test(errorMessage);

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

    // Suppress unused-var warning; `producedAnyEvent` is kept for future
    // diagnostics if we want to differentiate "failed before any data" vs
    // "failed mid-stream".
    void producedAnyEvent;
  })();

  return stream;
}
