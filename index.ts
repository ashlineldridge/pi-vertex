/**
 * Google Cloud Vertex AI provider for the Pi coding agent. Registers the
 * `vertex-anthropic` provider with Anthropic Claude models exposed through
 * Vertex's partner-models API.
 *
 * Prerequisites:
 *   1. Authenticate: gcloud auth application-default login
 *   2. Set environment variables:
 *      - GOOGLE_CLOUD_PROJECT (or GCLOUD_PROJECT, ANTHROPIC_VERTEX_PROJECT_ID,
 *        VERTEX_PROJECT_ID)
 *      - GOOGLE_CLOUD_LOCATION (or CLOUD_ML_REGION, VERTEX_REGION)
 *
 * See README.md for full setup and supported models.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Api } from "@mariozechner/pi-ai";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { anthropicModels, streamVertexAnthropic } from "./src/providers/anthropic.js";

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

  // The provider-level baseUrl is informational — each model carries its
  // own baseUrl built by anthropicModels(location), and that is what the
  // streaming entry point actually uses. We mirror the same regional /
  // global URL shape here so the two stay consistent.
  const providerBaseUrl =
    location === "global"
      ? "https://aiplatform.googleapis.com"
      : `https://${location}-aiplatform.googleapis.com`;

  pi.registerProvider("vertex-anthropic", {
    baseUrl: providerBaseUrl,
    // pi uses this string to detect provider availability via env var
    // presence; it is not an actual API key. Auth is via Google ADC.
    apiKey: "GOOGLE_CLOUD_PROJECT",
    api: "vertex-anthropic" as Api,
    models: anthropicModels(location),
    // Pi's `streamSimple` signature is generic over Api; we know the runtime
    // only ever hands us our own models, so widen the type here.
    streamSimple: streamVertexAnthropic as unknown as Parameters<typeof pi.registerProvider>[1]["streamSimple"],
  });
}
