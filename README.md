# pi-vertex

A [pi](https://github.com/badlogic/pi-mono) extension that adds a
`vertex-anthropic` provider for calling Anthropic Claude models via Google
Cloud Vertex AI.

Gemini and other Vertex partner models are not supported yet.

## Prerequisites

- pi installed: `npm install -g @mariozechner/pi-coding-agent`
- `gcloud` CLI installed
- A Google Cloud project with billing enabled and the Vertex AI API enabled
- Access to the Anthropic models you want to use, granted in
  [Vertex AI Model Garden](https://console.cloud.google.com/vertex-ai/model-garden)

## Install

```bash
pi install https://github.com/ashlineldridge/pi-vertex
```

Verify the provider is registered:

```bash
pi --list-models | grep vertex-anthropic
```

## Authenticate

```bash
gcloud auth application-default login
```

## Configure environment

Set these in your shell config (`~/.zshrc`, `~/.bashrc`, etc.):

```bash
export GOOGLE_CLOUD_PROJECT=your-project-id
export GOOGLE_CLOUD_LOCATION=us-east5  # or another supported region
```

`GOOGLE_CLOUD_LOCATION=global` is also supported and routes to the regionless
endpoint.

Alternative variable names are accepted if you already use them:

- Project: `GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT`,
  `ANTHROPIC_VERTEX_PROJECT_ID`, `VERTEX_PROJECT_ID`
- Location: `GOOGLE_CLOUD_LOCATION`, `CLOUD_ML_REGION`, `VERTEX_REGION`

For region/model availability see the
[Vertex AI Anthropic docs](https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-anthropic).

## Configure pi

Edit `~/.pi/agent/settings.json` (global) or `.pi/settings.json` (per
project):

```json
{
  "defaultProvider": "vertex-anthropic",
  "defaultModel": "claude-opus-4-7",
  "defaultThinkingLevel": "high",
  "enabledModels": ["vertex-anthropic/*"]
}
```

`enabledModels` controls the list pi cycles through with `Ctrl+P`. The
wildcard above picks up every model this extension exposes. To enumerate
models explicitly:

```json
{
  "enabledModels": [
    "vertex-anthropic/claude-opus-4-7",
    "vertex-anthropic/claude-opus-4-6",
    "vertex-anthropic/claude-sonnet-4-6",
    "vertex-anthropic/claude-haiku-4-5"
  ]
}
```

A more complete config is in [`examples/settings.json`](examples/settings.json).

## Usage

With `defaultProvider` and `defaultModel` set, just run:

```bash
pi
```

Override per invocation:

```bash
pi --provider vertex-anthropic --model claude-sonnet-4-6
pi --provider vertex-anthropic --model claude-opus-4-7 --thinking xhigh
```

Mid-session, **`Shift+Tab`** cycles through thinking levels (`off`,
`minimal`, `low`, `medium`, `high`, `xhigh`). `Ctrl+T` collapses or
expands thinking-block display.

## Models

| Model ID                   | Context | Max output | Thinking mode |
| -------------------------- | ------- | ---------- | ------------- |
| `claude-opus-4-7`          | 1M      | 128K       | adaptive      |
| `claude-opus-4-6`          | 1M      | 128K       | adaptive      |
| `claude-opus-4-6-manual`   | 1M      | 128K       | manual budget |
| `claude-sonnet-4-6`        | 1M      | 128K       | adaptive      |
| `claude-sonnet-4-6-manual` | 1M      | 128K       | manual budget |
| `claude-haiku-4-5`         | 200K    | 64K        | manual budget |

Context window and max output are taken from Vertex's per-model spec
pages under
`cloud.google.com/vertex-ai/generative-ai/docs/partner-models/claude/`.

### Thinking modes

Anthropic exposes two ways to control extended thinking, and Vertex
forwards both. Newer models are moving toward adaptive as the primary
mode; Opus 4.7 only accepts adaptive (manual returns a 400 error).

- **Adaptive** (`{type: "adaptive"}` + an `effort` parameter): Claude
  decides when and how much to think based on prompt complexity. The
  `effort` parameter (`low`/`medium`/`high`/`xhigh`/`max`) is soft
  guidance. This is what we send for the bare `claude-opus-4-7`,
  `claude-opus-4-6`, and `claude-sonnet-4-6` ids.
- **Manual budget** (`{type: "enabled", budget_tokens: N}`): you (or
  pi-ai's defaults derived from the `--thinking` level) supply a fixed
  thinking-token budget and Claude operates within it. This is what we
  send for `claude-haiku-4-5` (which only supports manual) and for the
  `-manual` variants of Opus 4.6 and Sonnet 4.6.

The `-manual` variants exist for cases where you want a hard ceiling on
thinking spend or reproducible per-turn token usage. They send the same
wire model id to Vertex as their bare counterpart — the suffix is purely
a pi-side switch that selects the manual `thinking` shape.

#### Effort mapping

pi's `--thinking <level>` is mapped per-model so the full native effort
range each model supports is reachable, including `max`:

| pi level | Opus 4.7 *(round up)* | Opus 4.6 / Sonnet 4.6 |
| -------- | --------------------- | --------------------- |
| `minimal`| effort `low`          | effort `low`          |
| `low`    | effort `medium`       | effort `low`          |
| `medium` | effort `high`         | effort `medium`       |
| `high`   | effort `xhigh`        | effort `high`         |
| `xhigh`  | effort `max`          | effort `max`          |

Opus 4.7 supports 5 effort levels (`low, medium, high, xhigh, max`) and
the mapping rounds each pi level up by one tier so all five are
reachable. Opus 4.6 and Sonnet 4.6 support 4 effort levels (no `xhigh`)
and keep low/medium/high name-faithful, with pi `xhigh` remapped to
`max` so the top tier is still reachable.

For Haiku 4.5 (manual budget only), pi `--thinking` levels map to
`budget_tokens` values: 1024 / 4096 / 10240 / 20480 / 32768 for
minimal / low / medium / high / xhigh. The `-manual` variants of Opus
4.6 and Sonnet 4.6 use the same budget ladder.

#### Known limitation: pi-ai clamps `xhigh` away from some models

pi-coding-agent uses pi-ai's [`supportsXhigh()`](https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/models.ts)
to decide which thinking levels are available per model. As of
pi-ai 0.68, that function only recognizes Opus 4.6, Opus 4.7, and the
GPT-5.x families. **Sonnet 4.6 and Haiku 4.5 are NOT in the
list**, so when you pick `--thinking xhigh` on those models, pi clamps
to `xhigh → high` *before* this extension is called. Net effect:

- `claude-sonnet-4-6` + `--thinking xhigh` → wire sends `effort: high`
  instead of `max`.
- `claude-haiku-4-5` + `--thinking xhigh` → wire sends
  `budget_tokens: 20480` instead of 32768.
- Same for `claude-sonnet-4-6-manual`.

The extension's per-model mapping above is correct; the clamp happens
upstream and we have no hook to override it. Fix is a one-line
broadening of pi-ai's `supportsXhigh()` to include `sonnet-4-6` and
`haiku-4-5`. Track [pi-mono](https://github.com/badlogic/pi-mono) for
a pi-ai release that includes it.

Workaround in the meantime: use the bare `claude-opus-4-7` or
`claude-opus-4-6` if you specifically need `effort: max`, or set
`thinkingBudgets` overrides in `~/.pi/agent/settings.json` if you want
to bump Haiku's budget.

### Cost

This extension reports `$0` for token cost on every model. Vertex bills
you (not Anthropic) and its pricing varies by region (regional endpoints
carry a ~10% premium over the global endpoint) and by context size on
some models, neither of which pi's single per-model cost field can
express. Reporting nothing is more honest than reporting subtly-wrong
figures with confidence. Token counts are unaffected. Consult the
official Google Vertex AI pricing documentation for actual rates, and
use `modelOverrides` in `~/.pi/agent/models.json` if you want to plug
your own per-model `cost` values back in.

## Troubleshooting

**`Unknown provider "vertex-anthropic"`** — extension isn't loaded. Check
`pi list` and reinstall if missing.

**`Warning: No models match pattern "vertex-anthropic/..."`** — your
`enabledModels` pattern didn't resolve. Verify the spelling against
`pi --list-models | grep vertex-anthropic`; a literal pattern like
`vertex-anthropic/claude-opus-4-7` must equal a row from that listing.

**Auth errors** — re-run `gcloud auth application-default login` and confirm
`gcloud config get-value project` matches `GOOGLE_CLOUD_PROJECT`.

**Model access denied** — open the model in
[Model Garden](https://console.cloud.google.com/vertex-ai/model-garden),
enable it for your project, and wait a few minutes for propagation.

**Missing env vars** — the extension logs which of
`GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION` / ADC credentials are
missing on startup.
