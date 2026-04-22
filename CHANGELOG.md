# Changelog

## Unreleased

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

### Breaking changes

- **1M context model ids renamed from `[1m]` to `-1m` suffix.** Old:
  `claude-opus-4-7[1m]`. New: `claude-opus-4-7-1m`. Same for `opus-4-6` and
  `sonnet-4-6`. The brackets in the previous spelling collided with
  [minimatch](https://github.com/isaacs/minimatch) character-class syntax
  used by pi's `enabledModels` glob matcher: a literal pattern like
  `"vertex-anthropic/claude-opus-4-7[1m]"` was parsed as "match a single
  character that is `1` or `m`" and silently failed to match the actual
  model id. Update your `~/.pi/agent/settings.json` accordingly.

  On the wire nothing changes — both the `200K` and `1M` registry entries
  send the same Vertex model id (`claude-opus-4-7`); the `-1m` suffix only
  toggles the `context-1m-2025-08-07` beta header and the context window pi
  tracks client-side.

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
