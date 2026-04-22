# Changelog

## Unreleased

### Aligned with Vertex docs (breaking)

Every model/API setting in this provider was previously seeded from
Anthropic's direct API docs and pi-ai's stock `anthropic` provider, on the
assumption that Vertex's Anthropic partner integration is a thin shim. That
assumption is broadly true at the URL/auth layer, but several specific
features don't pass through identically. This release re-grounds every
user-visible setting in Vertex's per-model spec pages
(https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/claude/).

User-visible changes:

- **Sonnet 4.6 max output corrected from 64K to 128K.** Vertex's spec page
  for `claude-sonnet-4-6` documents `Maximum output tokens: 128,000`, not
  the 64K Anthropic-direct figure we previously carried.

- **Per-model thinking-mode dispatch.** Anthropic exposes two thinking
  shapes and Vertex forwards both. Newer models are moving toward
  adaptive as the primary mode. The dispatch this release ships:

  | Model        | Manual `{ type: "enabled", budget_tokens }` | Adaptive `{ type: "adaptive" }` + effort | What we send |
  | ------------ | ------------------------------------------- | ----------------------------------------- | ------------ |
  | Opus 4.7     | Returns 400 error                           | Required                                  | adaptive     |
  | Opus 4.6     | Supported                                   | Recommended                               | adaptive     |
  | Sonnet 4.6   | Supported                                   | Recommended                               | adaptive     |
  | Haiku 4.5    | Supported (only mode)                       | Not used                                  | manual       |

  pi's `--thinking <level>` knob is mapped per-model so the full native
  effort range each model supports is reachable, including `max`:

  | pi level | Opus 4.7 *(round up)* | Opus 4.6 / Sonnet 4.6 | Defensive fallback |
  | -------- | --------------------- | --------------------- | ------------------ |
  | `minimal`| `low`                 | `low`                 | `low`              |
  | `low`    | `medium`              | `low`                 | `low`              |
  | `medium` | `high`                | `medium`              | `medium`           |
  | `high`   | `xhigh`               | `high`                | `high`             |
  | `xhigh`  | `max`                 | `max`                 | `high` (clamped)   |

  Per the [effort docs](https://platform.claude.com/docs/en/build-with-claude/effort),
  Opus 4.7 supports 5 effort levels (`low, medium, high, xhigh, max`)
  and Opus 4.6 / Sonnet 4.6 support 4 (no `xhigh`).

  - **Opus 4.7 rounds every pi level up by one tier** so all 5 native
    efforts are reachable from pi's 5 user levels. This preserves
    `xhigh` (the docs' recommended starting point for coding/agentic
    work) on pi `high`, and exposes `max` on pi `xhigh`.
  - **Opus 4.6 / Sonnet 4.6 stay name-faithful** for low/medium/high;
    only pi `xhigh` is remapped (to `max`) so users can still reach the
    top tier. Pi `minimal` collapses with `low` because these models
    have 4 effort levels for our 5 pi levels.
  - **Defensive fallback** clamps `xhigh` to `high` for unrecognized
    future adaptive models so a 400 isn't sent when we don't yet know
    which efforts a new model supports.

  Verified live on the Vertex global endpoint that each effort string in
  this table is accepted by its target model with no 400.

- **Opt-in `-manual` model variants.** `claude-opus-4-6-manual` and
  `claude-sonnet-4-6-manual` send the manual
  `{ type: "enabled", budget_tokens: N }` thinking shape instead of the
  adaptive default. Same wire model id as their bare counterpart — the
  suffix is purely a pi-side switch. Use these for predictable cost or
  reproducible per-turn token spend. No `-manual` variant for Opus 4.7
  (would 400) or Haiku 4.5 (already manual on its bare entry).

- **Models exposed: 6 entries.** `claude-opus-4-7`, `claude-opus-4-6`,
  `claude-opus-4-6-manual`, `claude-sonnet-4-6`,
  `claude-sonnet-4-6-manual`, `claude-haiku-4-5`. All Opus and Sonnet
  entries have 1M context per the Vertex docs.

No wire-format / auth changes; the Vertex SDK still injects
`anthropic_version: "vertex-2023-10-16"` and routes to
`/projects/{p}/locations/{r}/publishers/anthropic/models/{id}:streamRawPredict`
as before.

### Pricing

- **Cost reporting is now suppressed (zeroed out) for every model.**
  Previously each model carried a hand-coded per-million rate copied from
  Anthropic's direct API on the assumption that Google passes those rates
  through unchanged on Vertex. That assumption silently rotted: Opus 4.6
  and 4.7 stayed pinned at the legacy 4.0/4.1 tier ($15 / $75 per million)
  and over-reported costs by 3x until this release. Even with rates kept
  current, pi's single per-model cost field can't express two real
  Vertex behaviours: regional endpoints carry a ~10% premium over the
  global endpoint, and some models have separate >200K-input pricing
  tiers at regional endpoints.

  Rather than ship subtly-wrong numbers, this release reports `$0` for
  every model. Token counts still come straight from the API response, so
  usage tracking, context-window math, and compaction all keep working;
  only the dollar display is suppressed.

  Authoritative pricing lives in Google's official Vertex AI pricing
  documentation. If you want approximate cost tracking back, you can
  override per-model costs in `~/.pi/agent/models.json` via
  `modelOverrides` without forking this extension.

### Reliability

- **Mitigated upstream Anthropic SDK streaming bugs**
  ([anthropic-sdk-typescript#986](https://github.com/anthropics/anthropic-sdk-typescript/issues/986),
  [#996](https://github.com/anthropics/anthropic-sdk-typescript/issues/996),
  surfaced via [pi-mono#3175](https://github.com/badlogic/pi-mono/issues/3175)).
  When a model emits invalid JSON escapes inside a tool argument
  (e.g. PHP namespaces like `App\Http\Middleware`, regex patterns like `\d+`,
  Windows paths), the SDK's `partialParse` helper throws an unhandled
  `SyntaxError` that previously killed the entire turn. We now:
  - Use `client.messages.create({ stream: true })` and iterate raw events
    rather than `client.messages.stream()`, bypassing the buggy
    `MessageStream.partialParse` code path entirely.
  - Do not opt into the `fine-grained-tool-streaming-2025-05-14` beta, which
    is what causes the server to emit malformed partial JSON in the first
    place.
  - Defensively parse all streamed tool input via a `JSON.parse` ->
    `partialParse` -> `{}` fallback ladder.
  - On any streaming failure that looks JSON-related, automatically retry the
    turn in non-streaming mode (`stream: false`), which exercises a different
    SDK code path and recovers the response.

### Provider correctness fixes

The provider had a number of issues that produced silently-wrong behavior or
type errors. Aligned with `@mariozechner/pi-ai`'s reference Anthropic provider:

- Read the system prompt from `Context.systemPrompt` rather than looking for
  a non-existent `"system"` role on `Message`.
- Use `ImageContent.data` instead of the non-existent `block.base64`, and
  filter image blocks for text-only models.
- Send `signature_delta` events into `ThinkingContent.thinkingSignature` so
  thinking blocks survive multi-turn (the API rejects unsigned thinking
  blocks on replay).
- Handle `redacted_thinking` content blocks correctly, including round-trip
  through the opaque payload.
- Capture token usage from `message_start` (not just `message_delta`) so
  input token counts survive early aborts.
- Sanitize unpaired Unicode surrogates before sending to the API, which was
  causing intermittent JSON serialization failures.
- Build tool `input_schema` from the schema's `properties`/`required` rather
  than from the schema object directly.
- Coalesce consecutive `toolResult` messages into a single user message, as
  the Anthropic API requires when multiple tool calls are made in a turn.
- Track Anthropic's stable per-block index rather than the positional
  `event.index`, which is fragile if events arrive out of order.
- Add reasoning / thinking configuration that respects `SimpleStreamOptions.reasoning`
  and the model's adaptive vs. budget-based thinking support.
- Fix `mapStopReason` to handle `pause_turn`, `refusal`, `sensitive`, and
  unknown values gracefully (no more thrown errors on new server-side stop
  reasons).
- Removed references to `topP`, `topK`, and `stopSequences` options that do
  not exist on `SimpleStreamOptions`.
- Set the per-model `baseUrl` correctly, including the special-case `global`
  region URL.

### Dependencies

- `@anthropic-ai/vertex-sdk`: `^0.11.4` → `^0.16.0`
- `@mariozechner/pi-ai` (peer): pulls `0.67.6`
- `@mariozechner/pi-coding-agent` (peer): pulls `0.67.6`
- `typescript`: `^5.7.3` → `^6.0.3`
- `@types/node`: `^22.10.5` → `^25.6.0`
- `vitest`: `^3.2.4` → `^4.1.4`
- `tsconfig.json`: `moduleResolution` switched from the deprecated `node` to
  `bundler`. This unmasked 37 latent type errors that the previous resolution
  was hiding (it could not see the SDK's subpath exports), all of which are
  now fixed.

### Notes

After these fixes the package typechecks cleanly. Test coverage now
includes the model registry, wire-id derivation, the `enabledModels`
resolver path, the thinking-shape dispatch, the per-level effort
mapping, and the message-conversion / interrupted-tool-call repair
behaviour. Live verification against the Vertex global endpoint
confirmed every model + thinking-level combination this release ships.
