#!/bin/bash

# Example usage of pi-vertex extension

# Set required environment variables
export GOOGLE_CLOUD_PROJECT=your-project-id
export GOOGLE_CLOUD_LOCATION=us-east5

# Enable 1M context (optional)
export VERTEX_ANTHROPIC_1M=true

# Basic usage with standard context
pi --provider vertex-anthropic --model claude-opus-4-6 "Explain the concept of recursion"

# Usage with 1M context window
pi --provider vertex-anthropic --model claude-opus-4-6-1m "Analyze this large codebase"

# With maximum thinking effort
pi --provider vertex-anthropic --model claude-opus-4-6-1m --thinking xhigh "Solve this complex algorithm problem"