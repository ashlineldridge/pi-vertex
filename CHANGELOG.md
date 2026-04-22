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

- **No more 1M-context suffix variants.** Earlier unreleased work in
  this cycle introduced an Anthropic-Code-style `[1m]` suffix and then
  renamed it to `-1m` after the brackets collided with minimatch glob
  syntax in pi's `enabledModels`. Both are now gone: Vertex doesn't
  model 1M context as a separate id or a beta-header opt-in. Opus 4.6,
  Opus 4.7, and Sonnet 4.6 are documented as single 1M-context entries
  on Vertex; we expose them as such and no longer send the
  `context-1m-2025-08-07` Anthropic beta header (which isn't documented
  as required, or mentioned, on Vertex). Any settings.json referencing
  `claude-*-1m` or `claude-*[1m]` needs renaming to the bare id
  (`claude-opus-4-7`, etc.).

- **Sonnet 4.6 max output corrected from 64K to 128K.** Vertex's spec page
  for `claude-sonnet-4-6` documents `Maximum output tokens: 128,000`, not
  the 64K Anthropic-direct figure we previously carried.

- **Adaptive thinking dispatch corrected.** The Vertex Model Garden cards
  for Opus 4.6 and Opus 4.7 link to
  https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking
  as the canonical source for thinking semantics on Vertex, and that page
  prescribes a per-model rule:

  | Model        | Manual `{ type: "enabled", budget_tokens }` | Adaptive `{ type: "adaptive" }` + effort |
  | ------------ | -------------------------------------------- | ----------------------------------------- |
  | Opus 4.7     | **Returns 400 error**                        | **Required**                              |
  | Opus 4.6     | Deprecated, still functional                 | Recommended                               |
  | Sonnet 4.6   | Deprecated, still functional                 | Recommended                               |
  | Haiku 4.5    | Supported                                    | Not used                                  |

  We dispatch accordingly: adaptive for Opus 4.6 / 4.7 / Sonnet 4.6,
  manual for Haiku. The `xhigh` thinking level maps to effort `"xhigh"`
  on Opus 4.7, `"max"` on Opus 4.6, and `"high"` elsewhere (per the
  effort levels the docs accept on each model).

- **Models exposed: 4 entries (down from 7).** `claude-opus-4-7`,
  `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`. All except
  Haiku have 1M context per the Vertex docs.

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
  current, the figures wouldn't account for Vertex's separate cache
  pricing or the >200K-token premium tier on the 1M-context models.

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

After these fixes the package typechecks cleanly. There are still no unit
tests; adding coverage for the message-conversion and stream-event handling
paths is recommended follow-up.
