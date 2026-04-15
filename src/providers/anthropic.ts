import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import type { ContentBlockParam, MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages.js";
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  calculateCost,
  type Context,
  createAssistantMessageEventStream,
  type ImageContent,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
  type TextContent,
  type ThinkingContent,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
} from "@mariozechner/pi-ai";
import { parse as partialParse } from "partial-json";

export interface AnthropicVertexModel extends Model<"vertex-anthropic"> {
  vertexModelId?: string; // Actual model ID to send to Vertex (without suffixes)
  anthropicBeta?: string[]; // Beta headers to include
}

// Latest Claude models with accurate pricing and limits
const CLAUDE_MODELS: AnthropicVertexModel[] = [
  // Opus models
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
    id: "claude-opus-4-6-1m",
    name: "Claude Opus 4.6 [1M]",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    contextWindow: 1000000,
    maxTokens: 128000,
    vertexModelId: "claude-opus-4-6",
    anthropicBeta: ["context-1m-2025-08-07"],
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
    id: "claude-sonnet-4-6-1m",
    name: "Claude Sonnet 4.6 [1M]",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 1000000,
    maxTokens: 64000,
    vertexModelId: "claude-sonnet-4-6",
    anthropicBeta: ["context-1m-2025-08-07"],
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

export function anthropicModels(location: string, enable1M: boolean): AnthropicVertexModel[] {
  const models = CLAUDE_MODELS.map(model => ({
    ...model,
    provider: "vertex-anthropic" as const,
    api: "vertex-anthropic" as const,
  }));
  
  // Filter models based on whether 1M context is enabled
  if (!enable1M) {
    return models.filter(m => !m.id.endsWith("-1m"));
  }
  
  return models;
}

// Convert pi messages to Anthropic format
function convertMessages(messages: Message[]): { system: string | ContentBlockParam[]; messages: any[] } {
  let system: string | ContentBlockParam[] = "";
  const convertedMessages: any[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      system = msg.content;
    } else if (msg.role === "user") {
      const content: ContentBlockParam[] = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          content.push({ type: "text", text: block.text });
        } else if (block.type === "image") {
          content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: block.mimeType,
              data: block.base64,
            },
          });
        }
      }
      convertedMessages.push({ role: "user", content });
    } else if (msg.role === "assistant") {
      const content: ContentBlockParam[] = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          content.push({ type: "text", text: block.text });
        } else if (block.type === "thinking") {
          content.push({ type: "thinking" as any, thinking: block.thinking });
        } else if (block.type === "toolCall") {
          content.push({
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.arguments,
          } as any);
        }
      }
      convertedMessages.push({ role: "assistant", content });
    } else if (msg.role === "toolResult") {
      const content: ContentBlockParam[] = [];
      
      const toolMsg = msg as ToolResultMessage;
      if (Array.isArray(toolMsg.content)) {
        content.push({
          type: "tool_result",
          tool_use_id: toolMsg.toolCallId,
          content: toolMsg.content as any,
        } as any);
      } else {
        content.push({
          type: "tool_result",
          tool_use_id: toolMsg.toolCallId,
          content: String(toolMsg.content),
        } as any);
      }
      
      convertedMessages.push({ role: "user", content });
    }
  }

  return { system, messages: convertedMessages };
}

// Convert pi tools to Anthropic format
function convertTools(tools: Tool[]): any[] {
  return tools.map((tool) => ({
    type: "custom" as const,
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

// Map Anthropic stop reason to pi stop reason
function mapStopReason(reason: string): StopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "toolUse";
    default:
      return "stop";
  }
}

// Parse streaming JSON safely
function parseStreamingJson(json: string): any {
  try {
    return partialParse(json) || {};
  } catch {
    return {};
  }
}

// Stream handler for Vertex Anthropic
export function streamVertexAnthropic(
  model: Model<"vertex-anthropic">,
  context: Context,
  options?: SimpleStreamOptions
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

    try {
      const vertexModel = model as AnthropicVertexModel;
      const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
      const location = process.env.GOOGLE_CLOUD_LOCATION || process.env.CLOUD_ML_REGION || process.env.VERTEX_REGION;

      if (!projectId) {
        throw new Error("Google Cloud project ID not set");
      }

      const client = new AnthropicVertex({
        region: location,
        projectId: projectId,
        // The SDK handles authentication via ADC
      });

      const { system, messages } = convertMessages(context.messages);

      // Build request parameters
      const modelId = vertexModel.vertexModelId || model.id;
      const params: MessageCreateParamsStreaming = {
        model: modelId,
        messages,
        max_tokens: options?.maxTokens || model.maxTokens || 8192,
        stream: true,
      };

      if (system) {
        params.system = system;
      }

      if (context.tools && context.tools.length > 0) {
        (params as any).tools = convertTools(context.tools);
      }

      if (options?.temperature !== undefined) {
        params.temperature = options.temperature;
      }

      if (options?.topP !== undefined) {
        params.top_p = options.topP;
      }

      if (options?.topK !== undefined) {
        params.top_k = options.topK;
      }

      if (options?.stopSequences) {
        params.stop_sequences = options.stopSequences;
      }

      // Add beta headers if specified
      if (vertexModel.anthropicBeta && vertexModel.anthropicBeta.length > 0) {
        (params as any).headers = {
          "anthropic-beta": vertexModel.anthropicBeta.join(","),
        };
      }

      const messageStream = await client.messages.create(params);
      
      stream.push({ type: "start", partial: output });

      for await (const event of messageStream) {
        if (event.type === "content_block_start") {
          if (event.content_block.type === "text") {
            output.content.push({ type: "text", text: "" });
            stream.push({ 
              type: "text_start", 
              contentIndex: output.content.length - 1, 
              partial: output 
            });
          } else if ((event.content_block as any).type === "thinking") {
            output.content.push({ type: "thinking", thinking: "" });
            stream.push({ 
              type: "thinking_start", 
              contentIndex: output.content.length - 1, 
              partial: output 
            });
          } else if (event.content_block.type === "tool_use") {
            output.content.push({
              type: "toolCall",
              id: event.content_block.id,
              name: event.content_block.name,
              arguments: {},
            });
            stream.push({ 
              type: "toolcall_start", 
              contentIndex: output.content.length - 1, 
              partial: output 
            });
          }
        } else if (event.type === "content_block_delta") {
          const index = event.index;
          const block = output.content[index];
          
          if (event.delta.type === "text_delta" && block.type === "text") {
            block.text += event.delta.text;
            stream.push({ 
              type: "text_delta", 
              contentIndex: index, 
              delta: event.delta.text, 
              partial: output 
            });
          } else if ((event.delta as any).type === "thinking_delta" && block.type === "thinking") {
            block.thinking += (event.delta as any).thinking;
            stream.push({
              type: "thinking_delta",
              contentIndex: index,
              delta: (event.delta as any).thinking,
              partial: output,
            });
          } else if (event.delta.type === "input_json_delta" && block.type === "toolCall") {
            const partialJson = (event.delta.partial_json || "");
            block.arguments = parseStreamingJson(partialJson);
            stream.push({
              type: "toolcall_delta",
              contentIndex: index,
              delta: event.delta.partial_json,
              partial: output,
            });
          }
        } else if (event.type === "content_block_stop") {
          const index = event.index;
          const block = output.content[index];
          
          if (block.type === "text") {
            stream.push({ 
              type: "text_end", 
              contentIndex: index, 
              content: block.text, 
              partial: output 
            });
          } else if (block.type === "thinking") {
            stream.push({ 
              type: "thinking_end", 
              contentIndex: index, 
              content: block.thinking, 
              partial: output 
            });
          } else if (block.type === "toolCall") {
            stream.push({ 
              type: "toolcall_end", 
              contentIndex: index, 
              toolCall: block, 
              partial: output 
            });
          }
        } else if (event.type === "message_delta") {
          if ((event.delta as any).stop_reason) {
            output.stopReason = mapStopReason((event.delta as any).stop_reason);
          }
          
          // Update usage
          if (event.usage) {
            output.usage.input = event.usage.input_tokens || 0;
            output.usage.output = event.usage.output_tokens || 0;
            output.usage.cacheRead = (event.usage as any).cache_read_input_tokens || 0;
            output.usage.cacheWrite = (event.usage as any).cache_creation_input_tokens || 0;
            output.usage.totalTokens = 
              output.usage.input + output.usage.output + 
              output.usage.cacheRead + output.usage.cacheWrite;
            calculateCost(model, output.usage);
          }
        }
      }

      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }

      stream.push({ 
        type: "done", 
        reason: output.stopReason as "stop" | "length" | "toolUse", 
        message: output 
      });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}