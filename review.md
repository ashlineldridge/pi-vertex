  Independent code & docs review of pi-vertex

  Live-verified end to end on Vertex global endpoint (project chronosphere-rc-b). Test artifacts:
  /tmp/pi-matrix-raw.log (35 cells × wire body + stdout), /tmp/pi-headers.log (full headers + URL for one
   cell), curl outputs above.

  Bottom line

  The code's load-bearing claims about Vertex behavior are all empirically correct as of today.
  - 35/35 matrix cells (7 models × 5 thinking levels) returned 200 with the documented wire shape.
  - All 4 negative curl tests behaved exactly as anthropic.ts:589-635 claims (Opus 4.7 rejects manual;
  Haiku 4.5 rejects output_config.effort; Sonnet 4.6 rejects effort: "xhigh"; Opus 4.7 accepts effort:
  "max").
  - --list-models enumerates all 7 expected ids; both glob and explicit enabledModels resolve cleanly.
  - npm test passes 50/50; tsc --noEmit is clean.
  - No PII, secrets, work‑related strings, or sensitive identifiers tracked. Author email is the GitHub
  noreply alias only.

  The findings below are quality-of-implementation issues, not correctness bugs at the wire level.

  ---
  Wire-body verification table

  Every cell returned exit=0 and the model produced the requested "PONG" reply. Captured wire shape per
  cell:

  ┌─────────────────────────┬────────────┬──────────────┬──────────────┬─────────────┬─────────────┐
  │          Model          │  minimal   │     low      │    medium    │    high     │    xhigh    │
  ├─────────────────────────┼────────────┼──────────────┼──────────────┼─────────────┼─────────────┤
  │ claude-opus-4-7         │ effort=low │ effort=low   │ effort=mediu │ effort=high │ effort=xhig │
  │                         │            │              │ m            │             │ h           │
  ├─────────────────────────┼────────────┼──────────────┼──────────────┼─────────────┼─────────────┤
  │ claude-opus-4-7-max     │ effort=low │ effort=mediu │ effort=high  │ effort=xhig │ effort=max  │
  │                         │            │ m            │              │ h           │             │
  ├─────────────────────────┼────────────┼──────────────┼──────────────┼─────────────┼─────────────┤
  │ claude-opus-4-6         │ effort=low │ effort=low   │ effort=mediu │ effort=high │ effort=max  │
  │                         │            │              │ m            │             │             │
  ├─────────────────────────┼────────────┼──────────────┼──────────────┼─────────────┼─────────────┤
  │ claude-opus-4-6-manual  │ budget=102 │ budget=4096  │ budget=10240 │ budget=2048 │ budget=3276 │
  │                         │ 4          │              │              │ 0           │ 8           │
  ├─────────────────────────┼────────────┼──────────────┼──────────────┼─────────────┼─────────────┤
  │ claude-sonnet-4-6       │ effort=low │ effort=low   │ effort=mediu │ effort=high │ effort=high │
  │                         │            │              │ m            │             │  ⓘ          │
  ├─────────────────────────┼────────────┼──────────────┼──────────────┼─────────────┼─────────────┤
  │ claude-sonnet-4-6-manua │ budget=102 │ budget=4096  │ budget=10240 │ budget=2048 │ budget=2048 │
  │ l                       │ 4          │              │              │ 0           │ 0 ⓘ         │
  ├─────────────────────────┼────────────┼──────────────┼──────────────┼─────────────┼─────────────┤
  │ claude-haiku-4-5        │ budget=102 │ budget=4096  │ budget=10240 │ budget=2048 │ budget=2048 │
  │                         │ 4          │              │              │ 0           │ 0 ⓘ         │
  └─────────────────────────┴────────────┴──────────────┴──────────────┴─────────────┴─────────────┘

  ⓘ = pi-ai's supportsXhigh() clamps xhigh → high upstream before pi-vertex sees the level. Matches the
  README's "Known limitation" section. The xhigh row in the README's budget ladder for Sonnet-manual /
  Haiku (32768) is never emitted under CLI use; the level reached is high (20480). Across all 35 cells
  the only emitters of literal effort: "xhigh" are (claude-opus-4-7, xhigh) and (claude-opus-4-7-max,
  high) — exactly matching model-ids.test.ts:362-377.

  Wire shape captured (one representative cell, Opus 4.7 + high):
  POST https://aiplatform.googleapis.com/v1/projects/<P>/locations/global/publishers/anthropic/models/cla
  ude-opus-4-7:streamRawPredict
  headers: anthropic-version: 2023-06-01, authorization: Bearer <…>, user-agent: AnthropicVertex/JS
  0.90.0
  body: { messages, max_tokens: 42666, system, thinking: {type:"adaptive",display:"summarized"},
          output_config: {effort:"high"}, stream: true, anthropic_version: "vertex-2023-10-16" }
  No anthropic-beta header on any cell. anthropic_version body field auto-injected by SDK at
  node_modules/@anthropic-ai/vertex-sdk/client.mjs:87-89. URL template assembled at client.mjs:101-102.

  ---
  Findings, grouped by area

  src/providers/anthropic.ts

  SMELL-1 (medium) — reasoningToEffort defensive fallback is unreachable.
  - Location: src/providers/anthropic.ts:709-719.
  - Observed: The default clamp (xhigh → high for unrecognized model ids) can only run if a model id
  reaches reasoningToEffort whose name does not contain opus-4-7, opus-4-6, or sonnet-4-6.
  - Expected: But streamVertexAnthropic only calls reasoningToEffort when
  supportsAdaptiveThinking(modelId) returns true (anthropic.ts:968-971), and that helper only returns
  true for ids matching exactly those three substrings (anthropic.ts:639-643). So the fallback only fires
   if a future developer adds an id to ADAPTIVE_THINKING_MODELS without adding a per-model branch to
  reasoningToEffort — a partial-edit invariant.
  - The corresponding test (model-ids.test.ts:325-335) exercises the fallback by passing a fake id
  (claude-future-model-x) directly, bypassing the real dispatch — so the test doesn't reflect a reachable
   production path.
  - Suggested action: either (a) drop the fallback and let TypeScript exhaustiveness catch a future
  addition (each branch's switch (level) is already an exhaustive match), or (b) keep the fallback but
  add a console.warn so the partial-edit case is loud rather than silent.

  SMELL-3 (nit) — Dead variable producedAnyEvent.
  - Location: src/providers/anthropic.ts:1027,1043,1312.
  - Observed: declared, written, never read; explicitly suppressed with void producedAnyEvent;. Comment
  claims "kept for future diagnostics".
  - Suggested action: drop it. The error-message it would supposedly differentiate is already produced by
   errorMessage at line 1224.

  SMELL-4 (low) — reasoningToBudget ignores thinkingBudgets.xhigh.
  - Location: src/providers/anthropic.ts:645-658.
  - Observed: if (level === "xhigh") return custom?.high ?? defaults.xhigh; — for the xhigh level, the
  code reads custom?.high rather than custom?.xhigh. If a user sets thinkingBudgets: { xhigh: 65536 } in
  pi settings expecting that to apply at level xhigh, it would be silently ignored.
  - Expected: custom?.xhigh ?? defaults.xhigh. (pi-coding-agent's ReasoningEffortMapSchema does include
  an xhigh slot — node_modules/.../core/model-registry.js:59.)
  - Suggested action: change the lookup to custom?.xhigh ?? defaults.xhigh. Verify that no other call
  site relies on the current "borrow the high key for xhigh" behavior.

  DOC-2 (low) — Missing comment on display: "summarized".
  - Location: src/providers/anthropic.ts:970.
  - Observed: (baseParams as any).thinking = { type: "adaptive", display: "summarized" }; — no comment.
  - Expected: Anthropic's adaptive-thinking docs explicitly state that on Opus 4.7, display defaults to
  "omitted" (silent change from 4.6, where the default was "summarized"). Without the explicit display:
  "summarized", Opus 4.7 thinking blocks would come back with empty thinking text. A future maintainer
  trimming the line for cleanliness would silently break visible thinking on 4.7.
  - Suggested action: add a one-liner: // Required on Opus 4.7 where display defaults to "omitted"
  (silent change from 4.6).

  COVERAGE-1 (medium) — No unit test exercises the wire body.
  - Location: src/providers/anthropic.ts:830-1316 (streamVertexAnthropic).
  - Observed: All thinking dispatch tests (model-ids.test.ts:230-378) cover only the pure helpers
  (reasoningToEffort, supportsAdaptiveThinking, deriveWireModelId). Nothing tests that
  streamVertexAnthropic actually composes them correctly — e.g., !isManualOverride &&
  supportsAdaptiveThinking(modelId) (line 968), the budget-vs-max_tokens bump (line 974), the temperature
   suppression when thinking is on (line 986), or that display: "summarized" is always sent.
  - Suggested action: stub the SDK and assert on the params object passed into client.messages.create.
  The matrix-with-interceptor approach used in this review could become a script and live in examples/ so
   reviewers can re-run it easily.

  COVERAGE-2 (medium) — No test for the streaming-JSON-bug fallback path.
  - Location: src/providers/anthropic.ts:1218-1307.
  - Observed: The retry triggers on a regex over the SDK's error message:
  /JSON|Unexpected|escape|partial[_-]?json|Bad escaped/i.test(errorMessage). If the upstream SDK reword
  its JSON.parse error in a future release, the retry silently never fires.
  - Suggested action: add a test that throws synthetic errors with each of the wording variants (and one
  that doesn't match) and asserts whether the non-streaming retry ran.

  COVERAGE-5 (low) — No test for mapStopReason.
  - Location: src/providers/anthropic.ts:567-585.
  - Observed: 6 explicit cases + fallback to "stop". A new server-side stop-reason addition would
  silently map to "stop" with no warning.
  - Suggested action: add a small unit test pinning the table; consider a console.warn in the default
  branch.

  src/providers/anthropic.test.ts

  SMELL-2 (medium) — Tests re-implement the helpers they claim to verify.
  - Location: src/providers/anthropic.test.ts:35-98 re-declares repairInterruptedToolCalls and
  coalesceSameRoleMessages verbatim, then describe(...) blocks at 100-255 assert against the test-local
  copies, not the production functions at anthropic.ts:315 / anthropic.ts:383.
  - Observed: The file's own header (lines 19-34) explicitly acknowledges this trade-off and chose
  copy-paste over module surgery. The only assertion that actually touches production code is line
  257-260 (expect(typeof anthropicModule.streamVertexAnthropic).toBe("function")).
  - Suggested action: export the two helpers (e.g., export function repairInterruptedToolCalls / export
  function coalesceSameRoleMessages with an @internal JSDoc) so the existing tests now run against
  production. The "private" status was mostly stylistic; both are pure functions.

  COVERAGE-4 (low) — convertMessages only tested for interrupted-tool-call repair.
  - Location: src/providers/anthropic.ts:409-547.
  - Observed: All other branches — text/image conversion (convertContentBlocks), image filtering for
  text-only models (lines 449-451), signature_delta round-trip on thinking blocks (lines 1133-1140),
  redacted thinking handling (lines 469-496) — have no test.
  - Suggested action: add fixtures from real session data; trivial to extend the existing test file.

  index.ts

  (No issues found.)

  README.md

  INCONSISTENCY-1 (low) — Stale "pi-ai 0.68" version reference.
  - Location: README.md:175-180, CHANGELOG.md:51-57.
  - Observed: "As of pi-ai 0.68, Sonnet 4.6 and Haiku 4.5 are not in that list..." The pi installed
  locally and globally is now 0.69.0 (node_modules/.../pi-ai/package.json and
  /opt/homebrew/lib/node_modules/.../pi-ai/package.json). Behavior is identical — supportsXhigh() in
  pi-ai 0.69 still excludes Sonnet 4.6 and Haiku 4.5 — but the version pin is stale.
  - Suggested action: re-word as "as of pi-ai 0.69 (current upstream)" or just "as of upstream pi-ai",
  and bump peerDependencies to ^0.69.0 in package.json (currently ^0.68.0, line 47-48).

  INCONSISTENCY-3 (low/coverage) — Clamp claim is broader than what was verified.
  - Location: README.md:171-180 and CHANGELOG.md:50-57.
  - Observed: "pi clamps xhigh → high before this extension is called." Inspecting
  pi-coding-agent/dist/main.js:459-470, the clamp only fires inside an if (cliThinkingOverride) block at
  session-creation time. Whether mid-session Shift+Tab cycling onto xhigh (Sonnet 4.6 / Haiku 4.5) is
  also clamped — and therefore whether pi-vertex would ever emit effort: "xhigh" to a Sonnet 4.6 turn and
   400 — is not verified. I did not interactively reproduce.
  - Suggested action: either (a) verify Shift+Tab cycling skips xhigh for unsupported models (i.e.,
  confirm app.thinking.cycle filters by supportsXhigh()), or (b) qualify the README's wording to "when
  launching with --thinking xhigh on the CLI". The current wording could mislead a user who hits the gap.

  DOC-2 (low) — README doesn't mention the display: "omitted" default on Opus 4.7.
  - Location: README.md "Thinking modes" section (lines 125-181).
  - Suggested action: add a note that pi-vertex always sends display: "summarized" so thinking is visible
   on Opus 4.7 (where display would otherwise default to "omitted").

  examples/basic-usage.sh

  DOC-4 (low) — Example regions include unsupported values.
  - Location: examples/basic-usage.sh:7.
  - Observed: # e.g., us-east5, us-central1, europe-west4.
  - Expected: per the four Vertex per-model pages, the supported regions for Anthropic models are
  us-east5, europe-west1, asia-southeast1 (Opus 4.6, Sonnet 4.6), asia-east1 (Haiku 4.5), and the us/eu
  multi-regions plus global for Opus 4.7. us-central1 and europe-west4 are not in any of the four
  supported-region lists — picking either would 404.
  - Suggested action: replace the comment with a known-good list, e.g. # e.g., us-east5, europe-west1,
  asia-southeast1, or 'global'.

  examples/settings.json

  (No issues found. Valid JSON, all model ids match the registry, loads cleanly.)

  package.json

  INCONSISTENCY-2 (low) — peerDependencies lag.
  - Location: package.json:47-49.
  - Observed: "@mariozechner/pi-coding-agent": "^0.68.0", "@mariozechner/pi-ai": "^0.68.0". The current
  upstream release is 0.69.0 (which is what pi --version reports and what the matrix actually exercised).
   ^0.68.0 accepts 0.69.0 semver-wise, but for a 0.x ecosystem where minor bumps can change behavior,
  pinning to the version actually tested is safer.
  - Suggested action: bump both peers to ^0.69.0.

  Author / git hygiene

  - Author committer is Ashlin Eldridge <363071+ashlineldridge@users.noreply.github.com> (GitHub-supplied
   noreply alias). No personal email in commit history. ✓
  - package.json has "author": "" empty — intentional. ✓
  - .gitignore excludes .env*, build outputs, editor dirs. ✓
  - .npmignore excludes *.test.ts, tsconfig.json, .git/, examples/, coverage/. ✓
  - No tracked file contains: chronosphere, spacejunk, internal hostnames, IPs, API keys, bearer tokens,
  .pi/ artefacts, or .claude/ artefacts.
  - One mention of chronosphere-rc-b exists only in the temporary /tmp/pi-headers.log artefact captured
  during this review (project ID resolved from your live env). Not in the repo, not staged, not at risk
  of commit.

  ---
  Verifying the "Known design decisions to challenge"

  Decision: cost: 0 for every model
  Verdict: Sound. Vertex pricing's regional 10% premium and >200K-input regional Sonnet tier can't be
    expressed in pi's single cost field. CHANGELOG narrative is honest about the previous 3×
    over-reporting bug. (I did not re-fetch the Vertex pricing page to confirm the 10% claim is still
    current — anchors are unstable; worth a periodic recheck.)
  Evidence: CHANGELOG.md:85-106; anthropic.ts:32-63
  ────────────────────────────────────────
  Decision: -max only for Opus 4.7
  Verdict: Sound. Live test 4 above confirmed effort: "max" on Opus 4.7 returns 200. Matrix shows Opus
  4.6
    + xhigh → effort=max via bare id (no -max needed).
  Evidence: Curl Test 4 above; matrix row claude-opus-4-6 / xhigh
  ────────────────────────────────────────
  Decision: -manual only for Opus 4.6 / Sonnet 4.6
  Verdict: Sound. Live test 1 confirmed Opus 4.7 + manual = 400 ("Manual extended thinking is no longer
    supported on Claude Opus 4.7..."). Live test 2 confirmed Haiku 4.5 + output_config.effort = 400
    ("Extra inputs are not permitted") — Haiku is manual-only on its bare id, so a -manual variant would
    be redundant.
  Evidence: Curl Tests 1, 2 above
  ────────────────────────────────────────
  Decision: reasoningToEffort fallback clamps xhigh → high for unrecognized models
  Verdict: Defensible but unreachable today. See SMELL-1 above. The defense only protects a partial-edit
    invariant.
  Evidence: anthropic.ts:709-719; dispatch at 968-971

  ---
  Severity counts

  - Bugs: 0
  - Inconsistencies (docs vs code, code vs live): 3 (all low) — INCONSISTENCY-1, -2, -3
  - Code-smells: 4 — SMELL-1 (medium), SMELL-2 (medium), SMELL-3 (nit), SMELL-4 (low)
  - Doc: 2 (low) — DOC-2, DOC-4
  - Coverage: 5 — COVERAGE-1 (medium), -2 (medium), -3 (low), -4 (low), -5 (low)

  Top three things I'd fix first

  1. SMELL-2 / COVERAGE-1: Stop testing copies; add a wire-body test. Export repairInterruptedToolCalls
  and coalesceSameRoleMessages so the existing assertions actually exercise production code, and add at
  least one unit test that asserts on the params body passed into client.messages.create (stub the SDK).
  This closes the biggest evidentiary gap — today, only end-to-end live runs catch a wire-shape
  regression.
  2. SMELL-4: Fix reasoningToBudget xhigh → custom.xhigh. The current custom?.high ?? defaults.xhigh
  would silently swallow a user-specified thinkingBudgets.xhigh value. One-line change, no test today
  catches it.
  3. DOC-2 + DOC-4: Two small documentation truth-ups. Add the display: "summarized" rationale comment so
   a future maintainer doesn't strip it, and replace us-central1/europe-west4 in examples/basic-usage.sh
  with regions that are actually in Vertex's supported lists.

  INCONSISTENCY-3 (clamp scope) is also worth investigating but requires a short interactive verification
   first.
