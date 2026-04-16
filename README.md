# Pi Vertex AI Provider

Access Anthropic Claude models through Google Cloud Vertex AI in the Pi coding agent.

## Features

- 🚀 All latest Claude models via Vertex AI (Opus, Sonnet, Haiku)
- 💡 1M context window support with `[1m]` suffix
- 🔧 Easy authentication via Google Cloud SDK
- 🎯 Full support for reasoning, tools, and streaming
- 📦 Matches Claude Code's model naming conventions

## Installation

```bash
# Install from GitHub
pi install https://github.com/ashlineldridge/pi-vertex

# Or if published to npm (not yet published)
pi install npm:@ashlineldridge/pi-vertex
```

### Replacing Other Vertex Extensions

If you have other vertex extensions installed (like `pi-vertex-claude`), remove them first:

```bash
pi remove https://github.com/isaacraja/pi-vertex-claude
pi remove https://github.com/myk-org/pi-vertex-claude
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
# Vertex AI configuration
export GOOGLE_CLOUD_PROJECT=your-project-id
export GOOGLE_CLOUD_LOCATION=your-region  # e.g., us-east5, europe-west4
```

## Available Models

### Claude Models (Anthropic)

| Model ID | Name | Context | Max Output | Reasoning |
|----------|------|---------|------------|-----------|
| `claude-opus-4-6` | Claude Opus 4.6 | 200K | 128K | ✓ |
| `claude-opus-4-6[1m]` | Claude Opus 4.6 [1M] | 1M | 128K | ✓ |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | 200K | 64K | ✓ |
| `claude-sonnet-4-6[1m]` | Claude Sonnet 4.6 [1M] | 1M | 64K | ✓ |
| `claude-haiku-4-5` | Claude Haiku 4.5 | 200K | 64K | ✓ |

**Note**: 1M context models use the `[1m]` suffix (matching Claude Code format) and automatically include the required `context-1m-2025-08-07` beta header.

## Regional Availability

Check the [Vertex AI documentation](https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-anthropic) for model availability in your region.

## Pricing

Pricing follows Google Cloud Vertex AI rates. See [Vertex AI Pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing) for current rates.

## Future Roadmap

- [ ] Add Gemini model support (separate `vertex-gemini` provider)
- [ ] Add other Vertex AI partner models as they become available
- [ ] Add usage tracking and cost estimation

**Note**: This extension currently only supports Anthropic Claude models. Other models will be added in future releases.

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

