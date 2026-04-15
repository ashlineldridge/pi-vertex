# Pi-Vertex Setup Guide

## Repository Created

Your new Pi extension is ready at `./pi-vertex/`

## Next Steps

### 1. Push to GitHub

```bash
cd pi-vertex
gh repo create ashlineldridge/pi-vertex --public --source=. --remote=origin --push
```

Or manually:

```bash
cd pi-vertex
git remote add origin git@github.com:ashlineldridge/pi-vertex.git
git branch -M main
git push -u origin main
```

### 2. Publish to npm (optional)

```bash
cd pi-vertex
npm login
npm publish --access public
```

### 3. Install from GitHub

Once pushed, you can install it:

```bash
pi install github:ashlineldridge/pi-vertex
```

Or if published to npm:

```bash
pi install npm:@ashlineldridge/pi-vertex
```

## Current Configuration

Your `~/.pi/agent/settings.json` is already configured to use this extension:
- Provider: `vertex-anthropic`
- Default model: `claude-opus-4-6-1m` (1M context)
- Thinking level: `xhigh`

Your shell environment (`~/.zshrc`) has been updated with:
- `VERTEX_CLAUDE_1M=true` (for the old extension)
- `VERTEX_ANTHROPIC_1M=true` (for this new extension)

## Extension Structure

```
pi-vertex/
├── index.ts              # Main extension entry point
├── src/
│   ├── index.ts         # Re-exports
│   └── providers/
│       └── anthropic.ts # Claude models implementation
├── package.json         # Package metadata
├── tsconfig.json        # TypeScript config
├── README.md           # Documentation
├── LICENSE             # MIT License
└── examples/           # Usage examples
```

## Future Enhancements

The extension is structured to easily add:
- Gemini models (`vertex-gemini` provider)
- OpenAI models when available on Vertex AI
- Mistral models
- Other Vertex AI partner models

Simply add new files in `src/providers/` and register them in `index.ts`.