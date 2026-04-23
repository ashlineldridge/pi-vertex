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

  it("exposes the expected Vertex Claude models plus -manual / -max variants", () => {
    // Bare ids: the four Vertex publisher models we ship.
    // -manual: opt-in to manual `{ type: "enabled", budget_tokens }` thinking
    //          on Opus 4.6 and Sonnet 4.6 (manual not supported on Opus 4.7).
    // -max:    opt-in to Anthropic effort `max` on Opus 4.7. The bare
    //          `claude-opus-4-7` keeps name-faithful pi xhigh -> effort xhigh,
    //          so this variant is the only path to effort max on 4.7.
    expect(ids.slice().sort()).toEqual([
      "claude-haiku-4-5",
      "claude-opus-4-6",
      "claude-opus-4-6-manual",
      "claude-opus-4-7",
      "claude-opus-4-7-max",
      "claude-sonnet-4-6",
      "claude-sonnet-4-6-manual",
    ]);
  });

  it("matches the Vertex docs token limits per wire model", () => {
    // Cited from the per-model spec pages under
    // https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/claude/<slug>.
    // Variant ids share the wire model id (and therefore the same limits)
    // with their bare counterpart.
    const expected: Record<string, { contextWindow: number; maxTokens: number }> = {
      "claude-opus-4-7": { contextWindow: 1_000_000, maxTokens: 128_000 },
      "claude-opus-4-7-max": { contextWindow: 1_000_000, maxTokens: 128_000 },
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
  // The wire model id is what pi-vertex sends to Vertex. The `-manual` and
  // `-max` suffixes are pi-side fictions that flip per-model behaviour.
  // All variants share the wire id of their bare counterpart.

  it("strips the -manual suffix and reports isManualOverride", () => {
    expect(deriveWireModelId("claude-opus-4-6-manual")).toEqual({
      wireId: "claude-opus-4-6",
      isManualOverride: true,
      isMaxOverride: false,
    });
    expect(deriveWireModelId("claude-sonnet-4-6-manual")).toEqual({
      wireId: "claude-sonnet-4-6",
      isManualOverride: true,
      isMaxOverride: false,
    });
  });

  it("strips the -max suffix and reports isMaxOverride", () => {
    expect(deriveWireModelId("claude-opus-4-7-max")).toEqual({
      wireId: "claude-opus-4-7",
      isManualOverride: false,
      isMaxOverride: true,
    });
  });

  it("leaves bare ids unchanged and reports no overrides", () => {
    for (const id of ["claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"]) {
      expect(deriveWireModelId(id)).toEqual({
        wireId: id,
        isManualOverride: false,
        isMaxOverride: false,
      });
    }
  });

  it("doesn't strip an embedded substring (only trailing -manual / -max)", () => {
    expect(deriveWireModelId("claude-manual-test")).toEqual({
      wireId: "claude-manual-test",
      isManualOverride: false,
      isMaxOverride: false,
    });
    expect(deriveWireModelId("claude-max-test")).toEqual({
      wireId: "claude-max-test",
      isManualOverride: false,
      isMaxOverride: false,
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
    // Variant ids share their wire id with their bare counterpart, so we
    // test the wire ids rather than the registry ids directly.
    const wireIds = new Set(
      anthropicModels("us-east5").map((m) => deriveWireModelId(m.id).wireId),
    );
    for (const id of wireIds) {
      expect(typeof supportsAdaptiveThinking(id), `${id}`).toBe("boolean");
    }
  });
});

describe("reasoningToEffort: pi thinking level -> Anthropic effort string", () => {
  // Per https://platform.claude.com/docs/en/build-with-claude/effort:
  //
  //   Opus 4.7:   low, medium, high, xhigh, max  (5 levels)
  //   Opus 4.6:   low, medium, high, max         (no xhigh)
  //   Sonnet 4.6: low, medium, high, max         (no xhigh)
  //
  // Mapping (per-model dispatch + isMaxOverride flag for the -max variant):
  //
  //   pi level | Opus 4.7 (bare) | Opus 4.7 (-max) | Opus 4.6 / Sonnet 4.6
  //   ---------|-----------------|------------------|-----------------------
  //   minimal  | low             | low              | low
  //   low      | low             | low              | low
  //   medium   | medium          | medium           | medium
  //   high     | high            | high             | high
  //   xhigh    | xhigh           | max              | max
  //
  // Bare Opus 4.7 is name-faithful: pi xhigh -> Anthropic effort xhigh
  // (the docs' recommended starting point for coding/agentic work).
  // The `-max` variant is the only path to Anthropic effort `max` on
  // Opus 4.7. Other adaptive models have no native `xhigh` tier so their
  // bare ids already map pi xhigh -> max.

  describe("Opus 4.7 bare (name-faithful: pi xhigh -> effort xhigh)", () => {
    const M = "claude-opus-4-7";
    it("minimal -> low", () => expect(reasoningToEffort("minimal", M)).toBe("low"));
    it("low     -> low", () => expect(reasoningToEffort("low", M)).toBe("low"));
    it("medium  -> medium", () => expect(reasoningToEffort("medium", M)).toBe("medium"));
    it("high    -> high", () => expect(reasoningToEffort("high", M)).toBe("high"));
    it("xhigh   -> xhigh", () => expect(reasoningToEffort("xhigh", M)).toBe("xhigh"));
  });

  describe("Opus 4.7 -max variant (pi xhigh -> effort max)", () => {
    // The streaming entry point passes isMaxOverride=true when the user
    // picked the -max variant. wireModelId is the bare 'claude-opus-4-7'.
    const M = "claude-opus-4-7";
    it("minimal -> low", () => expect(reasoningToEffort("minimal", M, true)).toBe("low"));
    it("low     -> low", () => expect(reasoningToEffort("low", M, true)).toBe("low"));
    it("medium  -> medium", () => expect(reasoningToEffort("medium", M, true)).toBe("medium"));
    it("high    -> high", () => expect(reasoningToEffort("high", M, true)).toBe("high"));
    it("xhigh   -> max", () => expect(reasoningToEffort("xhigh", M, true)).toBe("max"));
  });

  describe("Opus 4.6 (no xhigh; name-faithful + xhigh->max)", () => {
    const M = "claude-opus-4-6";
    it("minimal -> low", () => expect(reasoningToEffort("minimal", M)).toBe("low"));
    it("low     -> low", () => expect(reasoningToEffort("low", M)).toBe("low"));
    it("medium  -> medium", () => expect(reasoningToEffort("medium", M)).toBe("medium"));
    it("high    -> high", () => expect(reasoningToEffort("high", M)).toBe("high"));
    it("xhigh   -> max", () => expect(reasoningToEffort("xhigh", M)).toBe("max"));
  });

  describe("Sonnet 4.6 (no xhigh; name-faithful + xhigh->max)", () => {
    const M = "claude-sonnet-4-6";
    it("minimal -> low", () => expect(reasoningToEffort("minimal", M)).toBe("low"));
    it("low     -> low", () => expect(reasoningToEffort("low", M)).toBe("low"));
    it("medium  -> medium", () => expect(reasoningToEffort("medium", M)).toBe("medium"));
    it("high    -> high", () => expect(reasoningToEffort("high", M)).toBe("high"));
    it("xhigh   -> max", () => expect(reasoningToEffort("xhigh", M)).toBe("max"));
  });

  describe("defensive fallback for unrecognized adaptive models", () => {
    // A future adaptive-capable model id we haven't pinned a rule for yet
    // shouldn't get a 400. Clamp xhigh to high (the documented universal
    // default) until we add a per-model branch.
    const M = "claude-future-model-x";
    it("minimal -> low", () => expect(reasoningToEffort("minimal", M)).toBe("low"));
    it("low     -> low", () => expect(reasoningToEffort("low", M)).toBe("low"));
    it("medium  -> medium", () => expect(reasoningToEffort("medium", M)).toBe("medium"));
    it("high    -> high", () => expect(reasoningToEffort("high", M)).toBe("high"));
    it("xhigh   -> high (clamped, defensive)", () => expect(reasoningToEffort("xhigh", M)).toBe("high"));
  });

  describe("invariant: literal 'xhigh' effort string only emitted via bare Opus 4.7", () => {
    // Per the effort docs, the `xhigh` effort string is only accepted by
    // Opus 4.7. Sending it to any other model would 400. Within Opus 4.7,
    // the bare id emits xhigh on pi xhigh; the -max variant intentionally
    // does NOT emit xhigh (it sends max instead). Locks the invariant.

    it("never emits 'xhigh' for any non-Opus-4.7 wire model id", () => {
      const nonOpus47Wire = [
        "claude-opus-4-6",
        "claude-sonnet-4-6",
        "claude-haiku-4-5",
        "claude-future-model-x",
      ];
      for (const wireId of nonOpus47Wire) {
        for (const level of ["minimal", "low", "medium", "high", "xhigh"] as const) {
          for (const isMax of [false, true]) {
            expect(
              reasoningToEffort(level, wireId, isMax),
              `reasoningToEffort("${level}", "${wireId}", ${isMax})`,
            ).not.toBe("xhigh");
          }
        }
      }
    });

    it("emits 'xhigh' for exactly one cell: bare Opus 4.7 (isMaxOverride=false) + pi 'xhigh'", () => {
      const cells: Array<[string, string, boolean]> = [];
      for (const wireId of ["claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"]) {
        for (const level of ["minimal", "low", "medium", "high", "xhigh"] as const) {
          for (const isMax of [false, true]) {
            if (reasoningToEffort(level, wireId, isMax) === "xhigh") {
              cells.push([wireId, level, isMax]);
            }
          }
        }
      }
      expect(cells).toEqual([["claude-opus-4-7", "xhigh", false]]);
    });
  });
});
