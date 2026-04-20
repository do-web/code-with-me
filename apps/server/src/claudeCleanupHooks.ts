/**
 * ClaudeCleanupHooks - Synchronous shutdown hooks for Claude SDK sessions.
 *
 * Claude runs in-process via `@anthropic-ai/claude-agent-sdk`, so it has no
 * PID we can kill. When the server receives `SIGINT`/`SIGTERM`, we want a
 * best-effort attempt to call `query.close()` on each live Claude session.
 * This is NOT reachable on `SIGKILL` (signal handlers don't fire), but for
 * graceful shutdowns it releases SDK-internal resources (e.g. any future
 * MCP stdio children the SDK might spawn).
 *
 * Hooks are plain synchronous callbacks. They must not throw; the caller
 * already wraps each invocation in try/catch.
 *
 * @module ClaudeCleanupHooks
 */

type Hook = () => void;

const hooks = new Set<Hook>();

export function add(hook: Hook): void {
  hooks.add(hook);
}

export function remove(hook: Hook): void {
  hooks.delete(hook);
}

export function runAllSync(): void {
  for (const hook of hooks) {
    try {
      hook();
    } catch {
      // Best-effort — continue with remaining hooks.
    }
  }
  hooks.clear();
}

export function size(): number {
  return hooks.size;
}

/** Test-only helper: resets module state. */
export function __resetForTests(): void {
  hooks.clear();
}
