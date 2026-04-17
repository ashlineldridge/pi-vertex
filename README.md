# Pi Vertex AI Provider

Access Anthropic Claude models through Google Cloud Vertex AI in the Pi coding
agent. Support for Gemini and other Vertex AI models coming soon.

## Features

- 🚀 All latest Claude models via Vertex AI (Opus, Sonnet, Haiku)
- 💡 1M context window support with `[1m]` suffix
- 🔧 Easy authentication via Google Cloud SDK
- 🎯 Full support for reasoning, tools, and streaming
- 📦 Matches Claude Code's model naming conventions

## Prerequisites

- Pi coding agent installed (`npm install -g @mariozechner/pi-coding-agent`)
- Google Cloud SDK installed (`gcloud` CLI)
- A Google Cloud project with billing enabled
- Vertex AI API enabled in your project
- Access to Anthropic models in Vertex AI Model Garden

## Installation

```bash
pi install https://github.com/ashlineldridge/pi-vertex
```

Verify installation:

```bash
pi --list-models | grep vertex-anthropic
# Should show available Claude models
```

## Setup

### 1. Authenticate with Google Cloud

```bash
gcloud auth application-default login
```

### 2. Set Environment Variables

```bash
# Required
export GOOGLE_CLOUD_PROJECT=your-project-id
export GOOGLE_CLOUD_LOCATION=your-region  # e.g., us-east5, us-central1, europe-west4
```

### 3. Enable Models in Vertex AI Model Garden

Visit the
[Model Garden](https://console.cloud.google.com/vertex-ai/model-garden) and
enable the models you want to use.

### 4. Configure Pi Settings

**Provider Name**: This extension uses `vertex-anthropic` as the provider name.

Configure your default provider and model in `~/.pi/agent/settings.json`
(global) or `.pi/settings.json` (project-specific):

```json
{
  "defaultProvider": "vertex-anthropic",
  "defaultModel": "claude-opus-4-7[1m]",
  "defaultThinkingLevel": "high"
}
```

#### Example Configurations

**For maximum performance (1M context, high thinking):**

```json
{
  "defaultProvider": "vertex-anthropic",
  "defaultModel": "claude-opus-4-7[1m]",
  "defaultThinkingLevel": "xhigh"
}
```

**For cost-conscious usage:**

```json
{
  "defaultProvider": "vertex-anthropic",
  "defaultModel": "claude-haiku-4-5",
  "defaultThinkingLevel": "low"
}
```

**With model cycling enabled:**

```json
{
  "defaultProvider": "vertex-anthropic",
  "defaultModel": "claude-opus-4-7[1m]",
  "enabledModels": [
    "vertex-anthropic/claude-opus-4-7[1m]",
    "vertex-anthropic/claude-opus-4-6[1m]",
    "vertex-anthropic/claude-sonnet-4-6[1m]",
    "vertex-anthropic/claude-haiku-4-5"
  ]
}
```

You can then cycle through models with `Ctrl+P`.

**Note**: See `examples/settings.json` for a complete configuration example.

## Usage

### Basic Usage

Once configured in settings.json, simply run:

```bash
pi
```

Or override settings with command-line flags:

```bash
# Use Claude Opus 4.7
pi --provider vertex-anthropic --model claude-opus-4-7

# Use Claude Opus 4.6
pi --provider vertex-anthropic --model claude-opus-4-6

# Use Claude Sonnet 4.6
pi --provider vertex-anthropic --model claude-sonnet-4-6

# Use Claude Haiku 4.5
pi --provider vertex-anthropic --model claude-haiku-4-5
```

### With 1M Context Window

```bash
# Use Claude Opus 4.7 with 1M context
pi --provider vertex-anthropic --model claude-opus-4-7[1m]

# Use Claude Opus 4.6 with 1M context
pi --provider vertex-anthropic --model claude-opus-4-6[1m]

# Use Claude Sonnet 4.6 with 1M context
pi --provider vertex-anthropic --model claude-sonnet-4-6[1m]
```

### Thinking Levels

Thinking levels are set independently from model selection:

```bash
# Set default thinking level
pi --thinking high

# Or use /thinking command during chat
/thinking xhigh
```

### Shell Configuration

Add to your shell config (~/.bashrc, ~/.zshrc, etc.):

```bash
# Required for Vertex AI authentication
export GOOGLE_CLOUD_PROJECT=your-project-id
export GOOGLE_CLOUD_LOCATION=your-region  # e.g., us-east5, us-central1, europe-west4
```

**Alternative environment variable names** (any of these work):

- Project: `GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT`,
  `ANTHROPIC_VERTEX_PROJECT_ID`, `VERTEX_PROJECT_ID`
- Location: `GOOGLE_CLOUD_LOCATION`, `CLOUD_ML_REGION`, `VERTEX_REGION`

## Available Models

### Claude Models (Anthropic)

| Model ID                | Name                   | Context | Max Output | Reasoning |
| ----------------------- | ---------------------- | ------- | ---------- | --------- |
| `claude-opus-4-7`       | Claude Opus 4.7        | 200K    | 128K       | ✓         |
| `claude-opus-4-7[1m]`   | Claude Opus 4.7 [1M]   | 1M      | 128K       | ✓         |
| `claude-opus-4-6`       | Claude Opus 4.6        | 200K    | 128K       | ✓         |
| `claude-opus-4-6[1m]`   | Claude Opus 4.6 [1M]   | 1M      | 128K       | ✓         |
| `claude-sonnet-4-6`     | Claude Sonnet 4.6      | 200K    | 64K        | ✓         |
| `claude-sonnet-4-6[1m]` | Claude Sonnet 4.6 [1M] | 1M      | 64K        | ✓         |
| `claude-haiku-4-5`      | Claude Haiku 4.5       | 200K    | 64K        | ✓         |

**Note**: 1M context models use the `[1m]` suffix (matching Claude Code format)
and automatically include the required `context-1m-2025-08-07` beta header.

## Regional Availability

Check the
[Vertex AI documentation](https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-anthropic)
for model availability in your region.

## Pricing

Pricing follows Google Cloud Vertex AI rates. See
[Vertex AI Pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing)
for current rates.

## Coming Soon

- 🚀 **Gemini models** - Native Vertex AI Gemini support (`vertex-gemini`
  provider)
- 🤖 **OpenAI models** - When available on Vertex AI
- 📊 **Additional partner models** - As they become available on Vertex AI
- 📈 **Usage tracking** - Cost estimation and token usage

**Current Release**: Anthropic Claude models only. Multi-model support coming in
next major release.

## Troubleshooting

### Provider not found

If you get `Unknown provider "vertex-anthropic"`, ensure the extension is
installed:

```bash
pi list  # Should show the pi-vertex package
```

### Authentication errors

Make sure you're authenticated:

```bash
gcloud auth application-default login
gcloud config set project YOUR_PROJECT_ID
```

### Model access errors

1. Visit the
   [Model Garden](https://console.cloud.google.com/vertex-ai/model-garden)
2. Search for "Anthropic" or "Claude"
3. Click on the model and enable it for your project
4. Wait a few minutes for the model to be available

### Missing environment variables

The extension requires these environment variables:

```bash
export GOOGLE_CLOUD_PROJECT=your-project-id
export GOOGLE_CLOUD_LOCATION=your-region
```

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.
