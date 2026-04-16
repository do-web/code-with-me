# CodeWithMe

A minimal web GUI for coding agents. Currently supports **Codex**, **Claude**, and **Gemini**, with more providers coming soon.

Available as **desktop app** (Electron) and **web interface**.

## Features

### Multi-Provider AI Integration

- **Codex** — JSON-RPC over stdio via app-server
- **Claude** — Full streaming via Claude Agent SDK
- **Gemini** — Experimental support via Gemini CLI
- Per-provider model selection with custom model names
- Runtime mode selection (read-only, restricted, full-access)
- Provider account stats, quota display with reset countdown
- Context window meter showing token usage

### Chat & Conversation

- Multi-threaded conversations with persistent history
- Real-time message streaming via WebSocket
- Markdown and GitHub-flavored markdown rendering
- Image attachment support (up to 8 per message)
- Timeline search within conversations
- Auto-saved draft messages
- Drag-and-drop thread reordering

### Orchestration & Workflow

- AI-generated action plans with implementation tracking
- Turn-based interaction with automatic checkpoints
- Diff computation between checkpoints (per-turn and full-thread)
- Command and file change approval system before execution
- Activity timeline with event filtering

### Terminal Integration

- Multi-terminal support (up to 4 per project)
- PTY-based terminal sessions with xterm.js rendering
- Terminal persistence across reconnects
- Working directory tracking per terminal
- Inline terminal context embedding in messages

### Git & Version Control

- Repository status, branch info, and switching
- Pull request detection, preparation, and submission
- Worktree creation and management
- Commit composition assistance
- Git action progress reporting

### Workspace & Project Management

- Project-based workspace organization
- File system operations with path validation
- Automatic setup script detection and execution
- Package.json script discovery
- Workspace file search with caching

### File Explorer & Code Editor

- Integrated file explorer panel with resizable sidebar
- Lazy-loading directory tree with project file browsing
- Code editing with CodeMirror 6 (syntax highlighting, bracket matching, folding)
- Multi-tab file editing with unsaved change indicators
- Inline git diff decorations (added/deleted lines highlighted directly in editor)
- Markdown preview with GFM support (tables, task lists, strikethrough)
- Uncommitted file highlighting in explorer tree with insertion/deletion stats
- File save via Cmd/Ctrl+S with workspace write-back
- Binary file and large file detection (5MB limit)

### Diff & Code Review

- Unified diff rendering with syntax highlighting
- File change statistics (additions/deletions)
- File tree view of changed files
- Checkpoint-based history navigation

### Desktop App

- Native Electron application with auto-updater
- Window state persistence (size, position)
- Native file picker and context menus
- System theme detection and sync
- Protocol handler (`codewithme://`)

### Settings & Customization

- Light/dark/system theme support
- Customizable keyboard shortcuts with command palette
- Provider configuration (binary paths, home directories)
- Timestamp format preferences
- Editor integration (VSCode, vim, etc.)

### Observability

- Client and server-side tracing
- OTLP metrics and trace export
- Structured logging with configurable log levels
- RPC method instrumentation

## Quick Start

```bash
npx codewithme
```

## Desktop App

Download the latest release from [GitHub Releases](https://github.com/do-web/code-with-me/releases).

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
- **Gemini**: Install [Gemini CLI](https://github.com/google-gemini/gemini-cli), then run `gemini auth login`

## Development

```bash
bun install
bun dev
```

## Tech Stack

| Category         | Technologies                                                         |
| ---------------- | -------------------------------------------------------------------- |
| **Frontend**     | React 19, Vite, Tailwind CSS, TanStack Router/Query, Zustand, Effect |
| **Backend**      | Node.js, Effect, SQLite, WebSocket/RPC                               |
| **Desktop**      | Electron, electron-updater                                           |
| **Build**        | Bun, Turbo, TypeScript, tsdown                                       |
| **Code Quality** | oxlint, oxfmt, Vitest, Playwright                                    |

### Architecture

- **apps/server** — Node.js WebSocket server, wraps provider CLIs, manages sessions
- **apps/web** — React/Vite UI, session UX, conversation rendering, client-side state
- **packages/contracts** — Shared Effect/Schema contracts (schema-only, no runtime logic)
- **packages/shared** — Shared runtime utilities with explicit subpath exports

Key patterns: Event sourcing, CQRS, stream-based event handling, service-based DI.

## License

MIT — see [LICENSE](./LICENSE)

## Author

Dominik Weber ([@do-web](https://github.com/do-web))
