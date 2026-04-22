#!/bin/bash

# Example usage of pi-vertex extension

# Set required environment variables
export GOOGLE_CLOUD_PROJECT=your-project-id
export GOOGLE_CLOUD_LOCATION=your-region  # e.g., us-east5, us-central1, europe-west4

# Method 1: Using command-line flags
pi --provider vertex-anthropic --model claude-opus-4-7 "Explain the concept of recursion"
pi --provider vertex-anthropic --model claude-opus-4-7 --thinking xhigh "Solve this complex algorithm problem"
pi --provider vertex-anthropic --model claude-haiku-4-5 "Quick question"

# Method 2: Configure defaults in ~/.pi/agent/settings.json
# Then simply run:
# pi "Your prompt here"
#
# Example settings.json:
# {
#   "defaultProvider": "vertex-anthropic",
#   "defaultModel": "claude-opus-4-7",
#   "defaultThinkingLevel": "high"
# }