# Quick Start Guide

## 1. Install the extension

```bash
pi install https://github.com/ashlineldridge/pi-vertex
```

## 2. Set up authentication

```bash
# Login to Google Cloud
gcloud auth application-default login

# Set your environment variables
export GOOGLE_CLOUD_PROJECT=your-project-id
export GOOGLE_CLOUD_LOCATION=us-east5  # or your preferred region
```

## 3. Configure Pi

Create or edit `~/.pi/agent/settings.json`:

```json
{
  "defaultProvider": "vertex-anthropic",
  "defaultModel": "claude-opus-4-7[1m]",
  "defaultThinkingLevel": "high"
}
```

## 4. Test it works

```bash
# List available models
pi --list-models | grep vertex-anthropic

# Run a test prompt
pi "Hello! Please confirm you're Claude via Vertex AI."
```

## Common Model Choices

- **Best performance**: `claude-opus-4-7[1m]` (1M context, latest)
- **Balanced**: `claude-sonnet-4-6[1m]` (1M context, faster)
- **Cost-effective**: `claude-haiku-4-5` (200K context, fastest)

## Need Help?

See the full [README](README.md) for detailed documentation and troubleshooting.
