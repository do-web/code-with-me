/**
 * ChildProcessRegistry - Tracks long-lived child processes spawned by the
 * server so they can be killed synchronously during crash/signal shutdown.
 *
 * Design goals:
 * - **Crash-safe shutdown**: Signal handlers must call `killAllSync` without
 *   depending on the Effect runtime (which may be torn down already).
 * - **Orphan cleanup across restarts**: Persist entries to a PID file so a
 *   subsequent startup can kill survivors left behind by a `SIGKILL`/OOM.
 * - **Cheap hot path**: Register/unregister hit an in-memory map; the PID
 *   file write is debounced via `setImmediate` + a small delay to coalesce
 *   bursts (e.g. rapid PTY resizes, reconnect storms).
 *
 * The module is a singleton: signal handlers are process-global and we want a
 * single source of truth. It intentionally avoids Effect services so a
 * collapsed Effect runtime cannot block the kill path.
 *
 * @module ChildProcessRegistry
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const IS_WINDOWS = process.platform === "win32";
const PERSIST_DEBOUNCE_MS = 50;

export interface ChildProcessEntry {
  readonly pid: number;
  readonly pgid?: number;
  readonly label: string;
  readonly startTime: string | null;
}

interface PersistedEntry {
  readonly pid: number;
  readonly pgid?: number;
  readonly label: string;
  readonly startTime: string | null;
}

const entries = new Map<number, ChildProcessEntry>();
let pidFilePath: string | null = null;
let pendingPersist: NodeJS.Timeout | null = null;
let persistWarned = false;

/**
 * Reads a stable start-time marker for the given pid. Used to protect against
 * PID recycling across server restarts: we only kill a process on startup if
 * its current start-time matches what we recorded at spawn.
 *
 * macOS/Linux: `ps -o lstart= -p <pid>` — returns a fixed human-readable
 * timestamp (e.g. "Sun Apr 20 12:34:56 2026").
 * Windows: returns null (we rely on `taskkill /T /F` + short startup windows
 * instead; PID recycling on Windows is less aggressive in practice).
 */
export function readStartTime(pid: number): string | null {
  if (IS_WINDOWS) return null;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
    });
    if (result.status !== 0) return null;
    const value = result.stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Sets the path where registry entries are persisted. Must be called once
 * during server startup (after `ServerConfig` is resolved). Idempotent.
 */
export function setPidFilePath(filePath: string): void {
  pidFilePath = filePath;
  // Write the current in-memory state to disk immediately so a crash before
  // any register-call still leaves a valid (empty) file.
  schedulePersist();
}

/**
 * Registers a child process. `pgid` should be set on non-Windows platforms
 * when the child was spawned with `detached: true` so that kill targets the
 * whole process group (killing the child plus any sub-tools it spawned).
 */
export function register(entry: { pid: number; pgid?: number; label: string }): void {
  if (!Number.isInteger(entry.pid) || entry.pid <= 0) {
    safeWarn(`[ChildProcessRegistry] refusing to register invalid pid=${entry.pid}`);
    return;
  }
  const startTime = readStartTime(entry.pid);
  const record: ChildProcessEntry = {
    pid: entry.pid,
    ...(entry.pgid !== undefined ? { pgid: entry.pgid } : {}),
    label: entry.label,
    startTime,
  };
  entries.set(entry.pid, record);
  schedulePersist();
}

export function unregister(pid: number | undefined): void {
  if (pid === undefined || !Number.isInteger(pid)) return;
  if (entries.delete(pid)) {
    schedulePersist();
  }
}

export function snapshot(): ReadonlyArray<ChildProcessEntry> {
  return Array.from(entries.values());
}

export function size(): number {
  return entries.size;
}

/**
 * Synchronously signals every registered child. Called from crash-path signal
 * handlers; must not throw and must not rely on the Effect runtime.
 *
 * Strategy:
 * - macOS/Linux: if `pgid` is set, `process.kill(-pgid, signal)` kills the
 *   whole group. Fallback to `process.kill(pid, signal)`.
 * - Windows: `taskkill /PID <pid> /T /F` (tree + force).
 */
export function killAllSync(signal: "SIGKILL" | "SIGTERM" = "SIGKILL"): void {
  for (const entry of entries.values()) {
    killEntrySync(entry, signal);
  }
  entries.clear();
  // Best-effort flush so a subsequent startup doesn't try to re-kill entries
  // we just terminated. Errors are swallowed — the signal handler continues.
  flushPersistSync();
}

function killEntrySync(entry: ChildProcessEntry, signal: "SIGKILL" | "SIGTERM"): void {
  if (IS_WINDOWS) {
    try {
      spawnSync("taskkill", ["/PID", String(entry.pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 2_000,
      });
    } catch {
      // Swallow — the process may already be gone.
    }
    return;
  }

  if (entry.pgid !== undefined) {
    try {
      process.kill(-entry.pgid, signal);
      return;
    } catch {
      // Fall through to per-pid kill.
    }
  }
  try {
    process.kill(entry.pid, signal);
  } catch {
    // Already gone — fine.
  }
}

// ---------------------------------------------------------------------------
// Persistence (PID file)
// ---------------------------------------------------------------------------

function schedulePersist(): void {
  if (pidFilePath === null) return;
  if (pendingPersist !== null) return;
  pendingPersist = setTimeout(() => {
    pendingPersist = null;
    flushPersistSync();
  }, PERSIST_DEBOUNCE_MS);
  // Don't keep the event loop alive just for the persist timer.
  pendingPersist.unref?.();
}

function flushPersistSync(): void {
  if (pidFilePath === null) return;
  const filePath = pidFilePath;
  const data: PersistedEntry[] = Array.from(entries.values(), (entry) => ({
    pid: entry.pid,
    ...(entry.pgid !== undefined ? { pgid: entry.pgid } : {}),
    label: entry.label,
    startTime: entry.startTime,
  }));
  const serialized = JSON.stringify(data);
  const tmpPath = `${filePath}.tmp`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmpPath, serialized, "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    if (!persistWarned) {
      persistWarned = true;
      safeWarn(`[ChildProcessRegistry] failed to persist pid file: ${String(error)}`);
    }
  }
}

export function readPidFileSync(filePath: string): ReadonlyArray<PersistedEntry> {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPersistedEntry);
  } catch {
    // File doesn't exist / is corrupt — treat as empty. Startup cleanup is
    // best-effort; a stale/empty file simply means nothing to clean.
    return [];
  }
}

export function clearPidFileSync(filePath: string): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "[]", "utf8");
  } catch {
    // Ignore — worst case we try again at next shutdown.
  }
}

function isPersistedEntry(value: unknown): value is PersistedEntry {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record["pid"] !== "number") return false;
  if (typeof record["label"] !== "string") return false;
  if (record["pgid"] !== undefined && typeof record["pgid"] !== "number") return false;
  if (record["startTime"] !== null && typeof record["startTime"] !== "string") return false;
  return true;
}

function safeWarn(message: string): void {
  try {
    console.warn(message);
  } catch {
    // stderr may be closed during crash — ignore.
  }
}

/**
 * Test-only helper: resets module state. Do NOT call from production code.
 */
export function __resetForTests(): void {
  entries.clear();
  pidFilePath = null;
  if (pendingPersist !== null) {
    clearTimeout(pendingPersist);
    pendingPersist = null;
  }
  persistWarned = false;
}
