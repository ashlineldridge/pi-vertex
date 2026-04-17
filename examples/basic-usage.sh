#!/bin/bash

# Example usage of pi-vertex extension

# Set required environment variables
export GOOGLE_CLOUD_PROJECT=your-project-id
export GOOGLE_CLOUD_LOCATION=your-region  # e.g., us-east5, us-central1, europe-west4

# Method 1: Using command-line flags
# Basic usage with standard context
pi --provider vertex-anthropic --model claude-opus-4-7 "Explain the concept of recursion"

# Usage with 1M context window
pi --provider vertex-anthropic --model claude-opus-4-7[1m] "Analyze this large codebase"

# With maximum thinking effort
pi --provider vertex-anthropic --model claude-opus-4-7[1m] --thinking xhigh "Solve this complex algorithm problem"

# Method 2: Configure defaults in ~/.pi/agent/settings.json
# Then simply run:
# pi "Your prompt here"
#
# Example settings.json:
# {
#   "defaultProvider": "vertex-anthropic",
#   "defaultModel": "claude-opus-4-7[1m]",
#   "defaultThinkingLevel": "high"
# }