# Pi Vertex AI Provider

Access Google Cloud Vertex AI models (Claude, Gemini, and more) through the Pi coding agent.

## Features

- 🚀 Support for latest Claude models via Vertex AI
- 💡 1M context window support for Claude Opus & Sonnet 4.6
- 🔧 Easy authentication via Google Cloud SDK
- 📦 Clean, extensible architecture for adding more Vertex AI models
- 🎯 Full support for reasoning, tools, and streaming

## Installation

```bash
pi install github:ashlineldridge/pi-vertex
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
export GOOGLE_CLOUD_LOCATION=your-region

# Enable 1M context for Claude models (optional)
export VERTEX_ANTHROPIC_1M=true
```

### 3. Enable Models in Vertex AI Model Garden

Visit the [Model Garden](https://console.cloud.google.com/vertex-ai/model-garden) and enable the models you want to use.

## Usage

### Basic Usage

```bash
# Use Claude Opus 4.6
pi --provider vertex-anthropic --model claude-opus-4-6

# Use Claude Sonnet 4.6
pi --provider vertex-anthropic --model claude-sonnet-4-6

# Use Claude Haiku 4.5
pi --provider vertex-anthropic --model claude-haiku-4-5
```

### With 1M Context Window

```bash
# Enable 1M context models
export VERTEX_ANTHROPIC_1M=true

# Use Claude Opus 4.6 with 1M context
pi --provider vertex-anthropic --model claude-opus-4-6-1m

# Use Claude Sonnet 4.6 with 1M context
pi --provider vertex-anthropic --model claude-sonnet-4-6-1m
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
# Vertex AI configuration
export GOOGLE_CLOUD_PROJECT=your-project-id
export GOOGLE_CLOUD_LOCATION=your-region  # e.g., us-east5, europe-west4
export VERTEX_ANTHROPIC_1M=true  # Optional: Enable 1M context
```

## Available Models

### Claude Models (Anthropic)

| Model ID | Name | Context | Max Output | Reasoning |
|----------|------|---------|------------|-----------|
| `claude-opus-4-6` | Claude Opus 4.6 | 200K | 128K | ✓ |
| `claude-opus-4-6-1m` | Claude Opus 4.6 [1M] | 1M | 128K | ✓ |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | 200K | 64K | ✓ |
| `claude-sonnet-4-6-1m` | Claude Sonnet 4.6 [1M] | 1M | 64K | ✓ |
| `claude-haiku-4-5` | Claude Haiku 4.5 | 200K | 64K | ✓ |

**Note**: 1M context models require `VERTEX_ANTHROPIC_1M=true` and are suffixed with `-1m`.

## Regional Availability

Check the [Vertex AI documentation](https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-anthropic) for model availability in your region.

## Pricing

Pricing follows Google Cloud Vertex AI rates. See [Vertex AI Pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing) for current rates.

## Roadmap

- [ ] Add Gemini model support (`vertex-gemini` provider)
- [ ] Add OpenAI model support when available on Vertex AI
- [ ] Add Mistral model support
- [ ] Add model-specific configuration options
- [ ] Add usage tracking and cost estimation

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## Acknowledgments

Inspired by [pi-vertex-claude](https://github.com/isaacraja/pi-vertex-claude).