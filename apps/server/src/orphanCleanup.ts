/**
 * Orphan child-process cleanup on server startup.
 *
 * If the previous server instance crashed (SIGKILL, OOM, Cmd+Q), long-lived
 * child processes like `codex app-server` and PTY shells survive as orphans,
 * adopted by init (PID 1), and keep file descriptors / PTY devices open.
 * On macOS this quickly exhausts the system-wide PTY pool.
 *
 * On startup we replay the PID file written by `ChildProcessRegistry`, verify
 * each recorded process is actually still ours (via a `startTime` match to
 * guard against PID recycling), and `SIGKILL` survivors before taking on
 * fresh sessions.
 *
 * This is best-effort: permission errors, platform differences, and a
 * corrupted PID file all cause us to skip rather than abort the server
 * startup.
 *
 * @module OrphanCleanup
 */
import { spawnSync } from "node:child_process";

import { Effect } from "effect";

import {
  clearPidFileSync,
  readPidFileSync,
  readStartTime,
  setPidFilePath,
} from "./childProcessRegistry";

const IS_WINDOWS = process.platform === "win32";

interface CleanupReport {
  readonly scanned: number;
  readonly killed: number;
  readonly skippedRecycled: number;
  readonly skippedAlreadyExited: number;
  readonly errors: number;
}

/**
 * Cleans up child processes recorded by a previous server run. Safe to call
 * before the new server starts producing its own children.
 */
export const cleanupOrphanedChildren = Effect.fn("orphan.cleanupOrphanedChildren")(function* (
  pidFilePath: string,
) {
  const entries = readPidFileSync(pidFilePath);
  const report: CleanupReport = {
    scanned: entries.length,
    killed: 0,
    skippedRecycled: 0,
    skippedAlreadyExited: 0,
    errors: 0,
  };

  if (entries.length === 0) {
    // Ensure the file exists + is registered so the active run starts clean.
    clearPidFileSync(pidFilePath);
    setPidFilePath(pidFilePath);
    return report;
  }

  const finalReport = killOrphanEntries(entries);

  clearPidFileSync(pidFilePath);
  setPidFilePath(pidFilePath);

  if (finalReport.killed > 0 || finalReport.errors > 0 || finalReport.skippedRecycled > 0) {
    yield* Effect.logInfo("orphan cleanup complete", finalReport);
  } else {
    yield* Effect.logDebug("orphan cleanup complete", finalReport);
  }

  return finalReport;
});

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs no action but throws ESRCH if the process is gone.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Synchronous orphan-kill loop, lifted out of the Effect generator so the
 * required try/catch around per-entry signalling doesn't trip the
 * `tryCatchInEffectGen` diagnostic. Pure side-effect function; returns a
 * structured report for the caller to log.
 */
function killOrphanEntries(
  entries: ReadonlyArray<{
    readonly pid: number;
    readonly pgid?: number;
    readonly startTime: string | null;
  }>,
): CleanupReport {
  let killed = 0;
  let skippedRecycled = 0;
  let skippedAlreadyExited = 0;
  let errors = 0;

  for (const entry of entries) {
    if (!isAlive(entry.pid)) {
      skippedAlreadyExited += 1;
      continue;
    }
    if (!IS_WINDOWS && entry.startTime) {
      const currentStartTime = readStartTime(entry.pid);
      if (currentStartTime !== null && currentStartTime !== entry.startTime) {
        // PID was recycled by the OS — don't kill a stranger's process.
        skippedRecycled += 1;
        continue;
      }
    }
    try {
      if (IS_WINDOWS) {
        spawnSync("taskkill", ["/PID", String(entry.pid), "/T", "/F"], {
          stdio: "ignore",
          timeout: 2_000,
        });
      } else if (entry.pgid !== undefined) {
        try {
          process.kill(-entry.pgid, "SIGKILL");
        } catch {
          process.kill(entry.pid, "SIGKILL");
        }
      } else {
        process.kill(entry.pid, "SIGKILL");
      }
      killed += 1;
    } catch {
      errors += 1;
    }
  }

  return {
    scanned: entries.length,
    killed,
    skippedRecycled,
    skippedAlreadyExited,
    errors,
  };
}
