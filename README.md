# CodeWithMe

A minimal web GUI for coding agents. Currently supports **Codex** and **Claude**, with more providers coming soon.

## Features

- Multi-provider support (Codex, Claude)
- Desktop app (Electron) and web interface
- Real-time session streaming via WebSocket
- Checkpointing and diff viewing
- Terminal integration
- Git workflows (branches, worktrees, PRs)

## Quick Start

```bash
npx codewithme
```

## Desktop App

Download the latest release from [GitHub Releases](https://github.com/do-web/code/releases).

### Package Managers

**macOS (Homebrew)**

```bash
brew install --cask codewithme
```

**Windows (winget)**

```bash
winget install DoWeb.CodeWithMe
```

**Arch Linux (AUR)**

```bash
yay -S codewithme-bin
```

## Prerequisites

Install and authenticate at least one provider:

- **Codex**: Install [Codex CLI](https://github.com/openai/codex), then run `codex login`
- **Claude**: Install [Claude Code](https://docs.anthropic.com/en/docs/claude-code), then run `claude auth login`

## Development

```bash
bun install
bun dev
```

## Tech Stack

- **Server**: Node.js, Effect, WebSocket
- **Web**: React, Vite, Tailwind CSS
- **Desktop**: Electron
- **Shared**: Effect Schema contracts, shared runtime utilities

## License

MIT - see [LICENSE](./LICENSE)

## Author

Dominik Weber ([@do-web](https://github.com/do-web))
