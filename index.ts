/**
 * Google Cloud Vertex AI Provider for Pi
 *
 * Currently supports Anthropic Claude models via Vertex AI.
 * Gemini and other Vertex AI models coming soon.
 *
 * Prerequisites:
 *   1. Authenticate: gcloud auth application-default login
 *   2. Set environment variables:
 *      - GOOGLE_CLOUD_PROJECT or GCLOUD_PROJECT: Your GCP project ID
 *      - GOOGLE_CLOUD_LOCATION: Region (required)
 *
 * Usage:
 *   pi --provider vertex-anthropic --model claude-opus-4-7
 *   pi --provider vertex-anthropic --model claude-opus-4-7-1m
 */

import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type {
  Api,
  Model,
  SimpleStreamOptions,
  AssistantMessageEventStream
} from "@mariozechner/pi-ai";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  anthropicModels,
  streamVertexAnthropic,
  type AnthropicVertexModel
} from "./src/providers/anthropic.js";

// Check for Google Cloud ADC credentials
function hasAdcCredentials(): boolean {
  const gacPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (gacPath && existsSync(gacPath)) {
    return true;
  }
  return existsSync(join(homedir(), ".config", "gcloud", "application_default_credentials.json"));
}

// Get project ID from environment
function getProjectId(): string | undefined {
  return process.env.GOOGLE_CLOUD_PROJECT ||
         process.env.GCLOUD_PROJECT ||
         process.env.ANTHROPIC_VERTEX_PROJECT_ID ||
         process.env.VERTEX_PROJECT_ID;
}

// Get location from environment
function getLocation(): string | undefined {
  return process.env.GOOGLE_CLOUD_LOCATION ||
         process.env.CLOUD_ML_REGION ||
         process.env.VERTEX_REGION;
}

export default function (pi: ExtensionAPI) {
  const projectId = getProjectId();
  const location = getLocation();

  if (!projectId || !location || !hasAdcCredentials()) {
    console.warn("Vertex AI: Missing configuration. Required:");
    console.warn("  - GOOGLE_CLOUD_PROJECT or GCLOUD_PROJECT");
    console.warn("  - GOOGLE_CLOUD_LOCATION");
    console.warn("  - Run 'gcloud auth application-default login'");
    return;
  }

  // Register Anthropic models via Vertex AI
  pi.registerProvider("vertex-anthropic", {
    baseUrl: `https://${location}-aiplatform.googleapis.com`,
    apiKey: "GOOGLE_CLOUD_PROJECT", // For detection
    api: "vertex-anthropic" as Api,
    models: anthropicModels(location),
    // Pi's `streamSimple` signature is generic over Api; we know the runtime
    // only ever hands us our own models, so widen the type here.
    streamSimple: streamVertexAnthropic as unknown as Parameters<typeof pi.registerProvider>[1]["streamSimple"],
  });

  // Coming soon: vertex-gemini provider for Gemini models
  // Coming soon: Other Vertex AI partner models (OpenAI, Mistral, etc.)
}
