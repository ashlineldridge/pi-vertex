/**
 * Tests for the `-1m` suffix that distinguishes 1M-context variants from
 * their 200K siblings.
 *
 * Background: this suffix used to be `[1m]` (mirroring Claude Code), but the
 * brackets collided with minimatch's character-class syntax in pi's
 * `enabledModels` glob matcher. A literal pattern like
 * `"vertex-anthropic/claude-opus-4-7[1m]"` was parsed as "match a single
 * character that is `1` or `m`" and silently failed to match the actual
 * model id. See CHANGELOG for the full story.
 *
 * These tests cover the three things that have to keep being true after the
 * rename:
 *
 *   1. The registry exposes the new ids and only the new ids.
 *   2. The runtime suffix-stripping logic produces the correct *wire*
 *      model id (Vertex doesn't know about `-1m` — that's a pi-side fiction
 *      that gets translated into a beta header).
 *   3. The new ids work as literal patterns in minimatch, both directly and
 *      under the recommended `vertex-anthropic/*` wildcard.
 */
import { describe, expect, it } from "vitest";
import { minimatch } from "minimatch";
import { anthropicModels } from "./anthropic.js";

// Mirror of the runtime logic inside streamVertexAnthropic. Kept tiny and
// in-sync intentionally — the production function isn't directly testable
// because it lives inside the streaming closure.
function deriveWireModelId(modelId: string): { wireId: string; is1M: boolean } {
  const is1M = modelId.endsWith("-1m");
  const wireId = is1M ? modelId.slice(0, -"-1m".length) : modelId;
  return { wireId, is1M };
}

describe("1M context variant suffix", () => {
  describe("registry", () => {
    const models = anthropicModels("us-east5");
    const ids = models.map((m) => m.id);

    it("exposes the three documented -1m variants", () => {
      expect(ids).toContain("claude-opus-4-7-1m");
      expect(ids).toContain("claude-opus-4-6-1m");
      expect(ids).toContain("claude-sonnet-4-6-1m");
    });

    it("no longer exposes any `[1m]`-style ids", () => {
      const bracketed = ids.filter((id) => id.includes("[") || id.includes("]"));
      expect(bracketed).toEqual([]);
    });

    it("declares 1M context window on -1m variants and 200K on bare variants", () => {
      const opus47_1m = models.find((m) => m.id === "claude-opus-4-7-1m");
      const opus47 = models.find((m) => m.id === "claude-opus-4-7");
      expect(opus47_1m?.contextWindow).toBe(1_000_000);
      expect(opus47?.contextWindow).toBe(200_000);
    });

    it("haiku has no -1m variant (Vertex doesn't offer 1M for it)", () => {
      expect(ids).toContain("claude-haiku-4-5");
      expect(ids).not.toContain("claude-haiku-4-5-1m");
    });
  });

  describe("pricing", () => {
    // We deliberately report zero cost for every model. The previous
    // approach — hand-mirroring Anthropic's direct per-million rates on the
    // assumption that Vertex passes them through — silently rotted (Opus
    // 4.6/4.7 over-reported by 3x for months) and never accounted for
    // Vertex's separate cache pricing or the >200K-token premium tier.
    // Reporting nothing is more honest than reporting wrong figures with
    // confidence. Token counts still flow through unchanged. See the long
    // comment on CLAUDE_MODELS in anthropic.ts for the full rationale.
    //
    // This test pins the invariant: if anyone reintroduces non-zero costs
    // here without also updating the rationale comment, this fails.
    const models = anthropicModels("us-east5");
    const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

    it("every model reports zero cost", () => {
      for (const model of models) {
        expect(model.cost, `model ${model.id} should report zero cost`).toEqual(ZERO);
      }
    });
  });

  describe("wire model id derivation", () => {
    it("strips the -1m suffix to recover the bare Vertex model id", () => {
      expect(deriveWireModelId("claude-opus-4-7-1m")).toEqual({
        wireId: "claude-opus-4-7",
        is1M: true,
      });
      expect(deriveWireModelId("claude-opus-4-6-1m")).toEqual({
        wireId: "claude-opus-4-6",
        is1M: true,
      });
      expect(deriveWireModelId("claude-sonnet-4-6-1m")).toEqual({
        wireId: "claude-sonnet-4-6",
        is1M: true,
      });
    });

    it("leaves bare ids unchanged and reports is1M=false", () => {
      expect(deriveWireModelId("claude-opus-4-7")).toEqual({
        wireId: "claude-opus-4-7",
        is1M: false,
      });
      expect(deriveWireModelId("claude-haiku-4-5")).toEqual({
        wireId: "claude-haiku-4-5",
        is1M: false,
      });
    });

    it("does not strip an embedded `-1m` that isn't a true suffix", () => {
      // Defensive: if a future model ever has `-1m` mid-id (unlikely, but
      // cheap to guarantee), only the trailing form should trigger stripping.
      expect(deriveWireModelId("claude-1m-test")).toEqual({
        wireId: "claude-1m-test",
        is1M: false,
      });
    });
  });

  describe("enabledModels minimatch compatibility (the whole point of the rename)", () => {
    const models = anthropicModels("us-east5");
    const fullIds = models.map((m) => `vertex-anthropic/${m.id}`);

    function matchesAny(pattern: string): string[] {
      return fullIds.filter((id) => minimatch(id, pattern, { nocase: true }));
    }

    it("matches each new -1m id when listed literally", () => {
      // The bug we just fixed: with `[1m]` ids these literal patterns matched
      // nothing (brackets were read as a character class).
      expect(matchesAny("vertex-anthropic/claude-opus-4-7-1m")).toEqual([
        "vertex-anthropic/claude-opus-4-7-1m",
      ]);
      expect(matchesAny("vertex-anthropic/claude-opus-4-6-1m")).toEqual([
        "vertex-anthropic/claude-opus-4-6-1m",
      ]);
      expect(matchesAny("vertex-anthropic/claude-sonnet-4-6-1m")).toEqual([
        "vertex-anthropic/claude-sonnet-4-6-1m",
      ]);
    });

    it("matches all variants under the recommended wildcard", () => {
      // This is what users should use unless they need to be selective.
      const matched = matchesAny("vertex-anthropic/*");
      expect(matched.sort()).toEqual(fullIds.slice().sort());
    });

    it("the example settings.json patterns all resolve", () => {
      // Mirrors examples/settings.json — every entry must match exactly one
      // model. If anyone reintroduces a bracketed id, this test fails first.
      const examplePatterns = [
        "vertex-anthropic/claude-opus-4-7-1m",
        "vertex-anthropic/claude-opus-4-7",
        "vertex-anthropic/claude-opus-4-6-1m",
        "vertex-anthropic/claude-sonnet-4-6-1m",
        "vertex-anthropic/claude-opus-4-6",
        "vertex-anthropic/claude-sonnet-4-6",
        "vertex-anthropic/claude-haiku-4-5",
      ];
      for (const pattern of examplePatterns) {
        expect(matchesAny(pattern), `pattern ${pattern} should match exactly one model`).toHaveLength(1);
      }
    });
  });
});
