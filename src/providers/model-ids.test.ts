/**
 * Tests for the model registry, the wire-id derivation, and how registered
 * ids interact with pi's `enabledModels` resolver.
 *
 * Every model id, context window, and max-output value here is sourced from
 * Vertex's per-model spec pages
 * (https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/claude/).
 * Cost is reported as zero for every model; see the long comment on
 * CLAUDE_MODELS in anthropic.ts for the rationale.
 *
 * The other purpose of this file is to pin the resolver behaviour: a
 * hand-written literal `enabledModels` entry must produce a real model
 * with no warning.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { minimatch } from "minimatch";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Api, Model } from "@mariozechner/pi-ai";
import {
  anthropicModels,
  deriveWireModelId,
  reasoningToEffort,
  supportsAdaptiveThinking,
} from "./anthropic.js";

// pi-coding-agent's `exports` map only lists `.` and `./hooks`, so we can't
// import the resolver by package name. Walk up from this file's URL to the
// project root and dynamic-import the deep dist path as a file URL. If
// pi-coding-agent restructures its dist layout, this path lookup fails
// loudly at test time.
let findExactModelReferenceMatch: (
  ref: string,
  models: Model<Api>[],
) => Model<Api> | undefined;
let parseModelPattern: (
  pattern: string,
  models: Model<Api>[],
) => { model: Model<Api> | undefined; warning: string | undefined };

beforeAll(async () => {
  const here = fileURLToPath(import.meta.url);
  const projectRoot = here.replace(/[\/]src[\/].*$/, "");
  const resolverPath = `${projectRoot}/node_modules/@mariozechner/pi-coding-agent/dist/core/model-resolver.js`;
  const mod = await import(pathToFileURL(resolverPath).href);
  findExactModelReferenceMatch = mod.findExactModelReferenceMatch;
  parseModelPattern = mod.parseModelPattern;
});

describe("model registry", () => {
  const models = anthropicModels("us-east5");
  const ids = models.map((m) => m.id);

  it("exposes the expected Vertex Claude models plus -manual variants", () => {
    // Bare ids: the four Vertex publisher models we ship.
    // -manual ids: opt-in to manual `{ type: "enabled", budget_tokens }`
    //              thinking on the two models that support both adaptive
    //              and manual.
    expect(ids.slice().sort()).toEqual([
      "claude-haiku-4-5",
      "claude-opus-4-6",
      "claude-opus-4-6-manual",
      "claude-opus-4-7",
      "claude-sonnet-4-6",
      "claude-sonnet-4-6-manual",
    ]);
  });

  it("matches the Vertex docs token limits per wire model", () => {
    // Cited from the per-model spec pages under
    // https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/claude/<slug>.
    // -manual variants share the wire model id (and therefore the same
    // limits) with their bare counterpart.
    const expected: Record<string, { contextWindow: number; maxTokens: number }> = {
      "claude-opus-4-7": { contextWindow: 1_000_000, maxTokens: 128_000 },
      "claude-opus-4-6": { contextWindow: 1_000_000, maxTokens: 128_000 },
      "claude-opus-4-6-manual": { contextWindow: 1_000_000, maxTokens: 128_000 },
      "claude-sonnet-4-6": { contextWindow: 1_000_000, maxTokens: 128_000 },
      "claude-sonnet-4-6-manual": { contextWindow: 1_000_000, maxTokens: 128_000 },
      "claude-haiku-4-5": { contextWindow: 200_000, maxTokens: 64_000 },
    };
    for (const m of models) {
      expect(
        { contextWindow: m.contextWindow, maxTokens: m.maxTokens },
        `${m.id} token limits`,
      ).toEqual(expected[m.id]);
    }
  });

  it("flags every model as reasoning-capable and accepts text+image input", () => {
    for (const m of models) {
      expect(m.reasoning, `${m.id} reasoning`).toBe(true);
      expect(m.input.slice().sort(), `${m.id} input`).toEqual(["image", "text"]);
    }
  });

  it("reports zero cost for every model (display suppressed; see anthropic.ts)", () => {
    const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const m of models) {
      expect(m.cost, `${m.id} cost`).toEqual(ZERO);
    }
  });

  it("uses the regional aiplatform baseUrl for non-global locations", () => {
    const m = anthropicModels("us-east5")[0];
    expect(m.baseUrl).toBe("https://us-east5-aiplatform.googleapis.com");
  });

  it("uses the regionless aiplatform baseUrl for `global`", () => {
    const m = anthropicModels("global")[0];
    expect(m.baseUrl).toBe("https://aiplatform.googleapis.com");
  });
});

describe("deriveWireModelId", () => {
  // The wire model id is what pi-vertex sends to Vertex. The `-manual`
  // suffix is a pi-side fiction that flips thinking dispatch from adaptive
  // to manual; both variants of a model share the same wire id.

  it("strips the -manual suffix and reports the override", () => {
    expect(deriveWireModelId("claude-opus-4-6-manual")).toEqual({
      wireId: "claude-opus-4-6",
      isManualOverride: true,
    });
    expect(deriveWireModelId("claude-sonnet-4-6-manual")).toEqual({
      wireId: "claude-sonnet-4-6",
      isManualOverride: true,
    });
  });

  it("leaves bare ids unchanged and reports no override", () => {
    for (const id of ["claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"]) {
      expect(deriveWireModelId(id)).toEqual({ wireId: id, isManualOverride: false });
    }
  });

  it("doesn't strip an embedded `manual` substring", () => {
    // Defensive: only the trailing `-manual` triggers stripping.
    expect(deriveWireModelId("claude-manual-test")).toEqual({
      wireId: "claude-manual-test",
      isManualOverride: false,
    });
  });
});

describe("enabledModels resolver compatibility", () => {
  // pi's resolveModelScope splits patterns on whether they contain a glob
  // metacharacter (`*`, `?`, `[`):
  //
  //   - With glob chars: minimatch against `${provider}/${id}` and bare
  //     `id`, case-insensitive.
  //   - Without glob chars: parseModelPattern -> tryMatchModel ->
  //     findExactModelReferenceMatch, which is plain case-insensitive
  //     equality on `provider/id`, falling back to canonical / bare-id
  //     forms. This is what most users will hit if they enumerate ids
  //     explicitly. Both paths are exercised below.
  const models = anthropicModels("us-east5") as unknown as Model<Api>[];
  const allIds = models.map((m) => m.id);
  const fullIds = allIds.map((id) => `vertex-anthropic/${id}`);

  describe("glob path (minimatch)", () => {
    function matchesAny(pattern: string): string[] {
      return fullIds.filter((id) => minimatch(id, pattern, { nocase: true }));
    }

    it("the recommended `vertex-anthropic/*` wildcard matches every model", () => {
      const matched = matchesAny("vertex-anthropic/*");
      expect(matched.sort()).toEqual(fullIds.slice().sort());
    });
  });

  describe("literal path (pi's actual resolver)", () => {
    it("resolves every canonical `vertex-anthropic/<id>` pattern", () => {
      for (const id of allIds) {
        const pattern = `vertex-anthropic/${id}`;
        const result = parseModelPattern(pattern, models);
        expect(
          result.model,
          `literal pattern ${pattern} must resolve to a model`,
        ).toBeDefined();
        expect(result.model?.id).toBe(id);
        expect(result.model?.provider).toBe("vertex-anthropic");
        expect(result.warning).toBeUndefined();
      }
    });

    it("resolves every bare `<id>` pattern (no provider prefix) when unambiguous", () => {
      // findExactModelReferenceMatch falls back to bare-id matching when
      // exactly one provider registers that id. With only pi-vertex loaded,
      // every id is unique, so bare patterns must resolve too.
      for (const id of allIds) {
        const result = findExactModelReferenceMatch(id, models);
        expect(result, `bare id ${id} should resolve unambiguously`).toBeDefined();
        expect(result?.id).toBe(id);
      }
    });

    it("is case-insensitive on the canonical form", () => {
      const result = parseModelPattern(
        "VERTEX-ANTHROPIC/Claude-Opus-4-7",
        models,
      );
      expect(result.model?.id).toBe("claude-opus-4-7");
    });
  });
});

describe("thinking-config dispatch rule", () => {
  // The Vertex Model Garden cards for Opus 4.6/4.7 link to Anthropic's
  // adaptive-thinking and extended-thinking pages
  // (https://docs.anthropic.com/en/docs/build-with-claude/adaptive-thinking,
  //  .../extended-thinking) as canonical. The rule we ship is:
  //
  //   - Opus 4.7:   adaptive REQUIRED (manual returns 400)
  //   - Opus 4.6:   adaptive recommended; manual still functional
  //   - Sonnet 4.6: adaptive recommended; manual still functional
  //   - Haiku 4.5:  manual only
  //
  // We pin the predicate the production code uses so a regression on
  // ADAPTIVE_THINKING_MODELS fails this test instead of silently sending
  // a 400 to Vertex on the next Opus 4.7 turn.

  it("dispatches adaptive for Opus 4.6 / 4.7 / Sonnet 4.6", () => {
    expect(supportsAdaptiveThinking("claude-opus-4-7")).toBe(true);
    expect(supportsAdaptiveThinking("claude-opus-4-6")).toBe(true);
    expect(supportsAdaptiveThinking("claude-sonnet-4-6")).toBe(true);
  });

  it("dispatches manual for Haiku 4.5", () => {
    expect(supportsAdaptiveThinking("claude-haiku-4-5")).toBe(false);
  });

  it("every shipped wire model has a thinking-shape decision", () => {
    // Sanity check: every wire-id in the registry must be classifiable.
    // -manual variants share their wire id with their bare counterpart, so
    // we test the wire ids rather than the registry ids directly.
    const wireIds = new Set(
      anthropicModels("us-east5").map((m) => deriveWireModelId(m.id).wireId),
    );
    for (const id of wireIds) {
      expect(typeof supportsAdaptiveThinking(id), `${id}`).toBe("boolean");
    }
  });
});

describe("reasoningToEffort: pi thinking level -> Anthropic effort string", () => {
  // Per the Anthropic adaptive-thinking docs, `effort` availability differs:
  //
  //   - `max`:   Opus 4.7, Opus 4.6, Sonnet 4.6
  //   - `xhigh`: Opus 4.7 ONLY
  //   - `high` / `medium` / `low`: every adaptive-supporting model
  //
  // pi's `xhigh` is the user's semantic top tier. We send `xhigh` on the
  // model that actually accepts it (Opus 4.7, name-faithful) and fall back
  // to `max` on the others (Opus 4.6, Sonnet 4.6) so we don't 400 by
  // sending `xhigh` to a model that doesn't take it.
  //
  // Verified live on 2026-04-23 against Vertex global endpoint: `xhigh`
  // accepted on Opus 4.7; `max` accepted on Opus 4.7, Opus 4.6, Sonnet 4.6.

  it("low / minimal -> 'low' on every model", () => {
    for (const m of ["claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"]) {
      expect(reasoningToEffort("low", m)).toBe("low");
      expect(reasoningToEffort("minimal", m)).toBe("low");
    }
  });

  it("medium -> 'medium' on every model", () => {
    for (const m of ["claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"]) {
      expect(reasoningToEffort("medium", m)).toBe("medium");
    }
  });

  it("high -> 'high' on every model", () => {
    for (const m of ["claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"]) {
      expect(reasoningToEffort("high", m)).toBe("high");
    }
  });

  it("xhigh -> 'xhigh' on Opus 4.7 (name-faithful; model supports it)", () => {
    expect(reasoningToEffort("xhigh", "claude-opus-4-7")).toBe("xhigh");
  });

  it("xhigh -> 'max' on Opus 4.6 and Sonnet 4.6 (xhigh unsupported; max is the documented substitute)", () => {
    expect(reasoningToEffort("xhigh", "claude-opus-4-6")).toBe("max");
    expect(reasoningToEffort("xhigh", "claude-sonnet-4-6")).toBe("max");
  });

  it("xhigh -> 'high' as defensive fallback on unrecognized adaptive models", () => {
    // A future adaptive-capable model id we haven't pinned a rule for yet
    // shouldn't get a 400. `high` is the documented default that every
    // adaptive model accepts.
    expect(reasoningToEffort("xhigh", "claude-future-model-x")).toBe("high");
  });
});
