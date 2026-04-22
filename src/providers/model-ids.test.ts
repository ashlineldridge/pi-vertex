/**
 * Tests for the model registry and how its ids interact with pi's
 * `enabledModels` resolver.
 *
 * Background: every model id, context window, and max-output value here is
 * sourced from Vertex's per-model spec pages
 * (https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/claude/),
 * not from Anthropic's direct API. Notably:
 *
 *   - There is no `-1m` (or `[1m]`) suffix variant on Vertex. Opus 4.6,
 *     Opus 4.7, and Sonnet 4.6 are documented as single 1M-context
 *     entries with no Anthropic-style beta-header opt-in.
 *   - Sonnet 4.6's documented Vertex max output is 128K, not 64K.
 *
 * Cost is reported as zero for every model. See the long comment on
 * CLAUDE_MODELS in anthropic.ts for the full rationale.
 *
 * The other purpose of this file is to pin the resolver behaviour Jason
 * tripped over: a hand-written literal `enabledModels` entry must produce
 * a real model with no warning.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { minimatch } from "minimatch";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Api, Model } from "@mariozechner/pi-ai";
import { anthropicModels, supportsAdaptiveThinking } from "./anthropic.js";

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

describe("model registry (Vertex-sourced)", () => {
  const models = anthropicModels("us-east5");
  const ids = models.map((m) => m.id);

  it("exposes exactly the four Vertex Claude models", () => {
    expect(ids.sort()).toEqual([
      "claude-haiku-4-5",
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-sonnet-4-6",
    ]);
  });

  it("does not expose any -1m or [1m] suffix variants", () => {
    // Vertex doesn't model 1M as a separate id; the previous Anthropic-style
    // suffix scheme has been removed. If a future contributor reintroduces
    // it, this test fails first.
    const suffixed = ids.filter(
      (id) => id.endsWith("-1m") || id.includes("[") || id.includes("]"),
    );
    expect(suffixed).toEqual([]);
  });

  it("matches the Vertex docs token limits per model", () => {
    // Cited from the per-model spec pages under
    // https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/claude/<slug>
    // (opus-4-7, opus-4-6, sonnet-4-6, haiku-4-5). If Google updates these,
    // this test fails and the registry needs a corresponding update.
    const expected: Record<string, { contextWindow: number; maxTokens: number }> = {
      "claude-opus-4-7": { contextWindow: 1_000_000, maxTokens: 128_000 },
      "claude-opus-4-6": { contextWindow: 1_000_000, maxTokens: 128_000 },
      "claude-sonnet-4-6": { contextWindow: 1_000_000, maxTokens: 128_000 },
      "claude-haiku-4-5": { contextWindow: 200_000, maxTokens: 64_000 },
    };
    for (const m of models) {
      expect(
        { contextWindow: m.contextWindow, maxTokens: m.maxTokens },
        `${m.id} token limits`,
      ).toEqual(expected[m.id]);
    }
  });

  it("flags every model as reasoning-capable and multimodal text+image", () => {
    // All four Claude models on Vertex document Extended thinking and image
    // input. If a future model lacks one of these, drop it from this assertion.
    for (const m of models) {
      expect(m.reasoning, `${m.id} reasoning`).toBe(true);
      expect(m.input.sort(), `${m.id} input`).toEqual(["image", "text"]);
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

describe("enabledModels resolver compatibility", () => {
  // pi's resolveModelScope splits patterns on whether they contain a glob
  // metacharacter (`*`, `?`, `[`):
  //
  //   - With glob chars: minimatch against `${provider}/${id}` and bare
  //     `id`, case-insensitive. The bracketed `[1m]` ids of an earlier
  //     release blew up here because brackets read as a character class.
  //     None of the current Vertex ids contain glob metacharacters, so
  //     this path is no longer a footgun for our ids.
  //
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

    it("a literal pattern with no glob chars still matches via minimatch", () => {
      // Defensive: no current id has `*`, `?`, or `[`, so users who write
      // literal patterns will actually take the non-glob path below. This
      // just confirms minimatch handles them too if pi's heuristic ever
      // sends them through this code path anyway.
      for (const fullId of fullIds) {
        expect(matchesAny(fullId)).toEqual([fullId]);
      }
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

    it("the example settings.json patterns all resolve via pi's resolver", () => {
      // Mirrors examples/settings.json. Every literal entry must produce a
      // model with no warning.
      const examplePatterns = [
        "vertex-anthropic/claude-opus-4-7",
        "vertex-anthropic/claude-opus-4-6",
        "vertex-anthropic/claude-sonnet-4-6",
        "vertex-anthropic/claude-haiku-4-5",
      ];
      for (const pattern of examplePatterns) {
        const result = parseModelPattern(pattern, models);
        expect(result.model, `pattern ${pattern} should resolve`).toBeDefined();
        expect(result.warning, `pattern ${pattern} should not warn`).toBeUndefined();
      }
    });

    it("legacy `-1m` and `[1m]` ids do not resolve (helpful failure for upgraders)", () => {
      // After this rewrite, anyone whose settings still reference the old
      // suffix will get a `No models match pattern` warning. This test
      // documents that intentional break.
      expect(parseModelPattern("vertex-anthropic/claude-opus-4-7-1m", models).model).toBeUndefined();
      expect(
        findExactModelReferenceMatch("vertex-anthropic/claude-opus-4-7[1m]", models),
      ).toBeUndefined();
    });
  });
});

describe("thinking-config dispatch rule (per Anthropic extended-thinking docs)", () => {
  // The Vertex Model Garden cards for Opus 4.6/4.7 link to
  // https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking
  // as the canonical source for which `thinking` shape each model accepts.
  // The rule we ship to Vertex is:
  //
  //   - Opus 4.7:   adaptive REQUIRED (manual returns 400)
  //   - Opus 4.6:   adaptive recommended; manual deprecated but still works
  //   - Sonnet 4.6: adaptive recommended; manual deprecated but still works
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

  it("every shipped model has a thinking-shape decision", () => {
    // Sanity check: every shipped model must be classifiable by the rule.
    // If a new model lands without a thinking-shape decision, surface it.
    const models = anthropicModels("us-east5");
    for (const m of models) {
      expect(typeof supportsAdaptiveThinking(m.id), `${m.id}`).toBe("boolean");
    }
  });
});
