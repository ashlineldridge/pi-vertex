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
  "defaultModel": "claude-opus-4-7-1m",
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
    "vertex-anthropic/claude-opus-4-7-1m",
    "vertex-anthropic/claude-opus-4-6-1m",
    "vertex-anthropic/claude-sonnet-4-6-1m",
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
pi --provider vertex-anthropic --model claude-opus-4-7-1m --thinking xhigh
```

Thinking level can also be changed mid-session with `/thinking <level>`.

## Models

| Model ID               | Context | Max output | Reasoning |
| ---------------------- | ------- | ---------- | --------- |
| `claude-opus-4-7`      | 200K    | 128K       | yes       |
| `claude-opus-4-7-1m`   | 1M      | 128K       | yes       |
| `claude-opus-4-6`      | 200K    | 128K       | yes       |
| `claude-opus-4-6-1m`   | 1M      | 128K       | yes       |
| `claude-sonnet-4-6`    | 200K    | 64K        | yes       |
| `claude-sonnet-4-6-1m` | 1M      | 64K        | yes       |
| `claude-haiku-4-5`     | 200K    | 64K        | yes       |

The `-1m` suffix is a pi-side label only — both variants of a model send the
same model id to Vertex. The suffix toggles the `context-1m-2025-08-07` beta
header and the context window pi uses for client-side bookkeeping
(compaction, status display, etc.).

This extension reports `$0` for token cost on every model. Vertex bills you
separately from Anthropic and the rates drift, so reporting nothing is more
honest than reporting subtly-wrong figures with confidence. Token counts
are unaffected. Consult the official Google Vertex AI pricing
documentation for actual rates, and use `modelOverrides` in
`~/.pi/agent/models.json` if you want to plug your own per-model `cost`
values back in.

## Troubleshooting

**`Unknown provider "vertex-anthropic"`** — extension isn't loaded. Check
`pi list` and reinstall if missing.

**`Warning: No models match pattern "vertex-anthropic/..."`** — your
`enabledModels` pattern doesn't match anything. The matcher is
[minimatch](https://github.com/isaacs/minimatch), so `[`, `]`, `*`, and `?`
are glob metacharacters. The model ids in this extension don't contain any
of those, so plain literal patterns and `vertex-anthropic/*` both work.

**Auth errors** — re-run `gcloud auth application-default login` and confirm
`gcloud config get-value project` matches `GOOGLE_CLOUD_PROJECT`.

**Model access denied** — open the model in
[Model Garden](https://console.cloud.google.com/vertex-ai/model-garden),
enable it for your project, and wait a few minutes for propagation.

**Missing env vars** — the extension logs which of
`GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION` / ADC credentials are
missing on startup.
