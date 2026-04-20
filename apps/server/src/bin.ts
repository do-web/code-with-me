import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/unstable/cli";

import { NetService } from "@codewithme/shared/Net";
import * as ChildProcessRegistry from "./childProcessRegistry";
import * as ClaudeCleanupHooks from "./claudeCleanupHooks";
import { cli } from "./cli";
import { version } from "../package.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Shutdown handlers
//
// Long-lived child processes (codex app-server, PTY shells) leak on hard
// exits unless we kill them synchronously before the event loop goes down.
// The Effect runtime's own shutdown path is not reliable under crash
// conditions (uncaught exceptions, corrupted scopes, abrupt signals), so we
// guarantee cleanup via plain `process.on` handlers that call directly into
// `ChildProcessRegistry.killAllSync`.
//
// All logging is wrapped in try/catch because stderr may already be closed
// during a crash shutdown — a throw from `console.error` would mask the
// original cause.
// ---------------------------------------------------------------------------
let shutdownRan = false;

const safeLog = (message: string): void => {
  try {
    console.error(message);
  } catch {
    /* stderr closed, swallow */
  }
};

const shutdownOnce = (reason: string, exitCode: number): void => {
  if (shutdownRan) return;
  shutdownRan = true;
  safeLog(
    `[codewithme] shutting down (${reason}), killing ${ChildProcessRegistry.size()} child processes...`,
  );
  try {
    ClaudeCleanupHooks.runAllSync();
  } catch {
    /* hooks must not block kill path */
  }
  try {
    ChildProcessRegistry.killAllSync("SIGKILL");
  } catch {
    /* best-effort */
  }
  process.exit(exitCode);
};

process.on("SIGINT", () => shutdownOnce("SIGINT", 130));
process.on("SIGTERM", () => shutdownOnce("SIGTERM", 143));
process.on("SIGHUP", () => shutdownOnce("SIGHUP", 129));
process.on("uncaughtException", (error) => {
  safeLog(`[codewithme] uncaughtException: ${error?.stack ?? String(error)}`);
  shutdownOnce("uncaughtException", 1);
});
process.on("unhandledRejection", (reason) => {
  safeLog(`[codewithme] unhandledRejection: ${String(reason)}`);
  shutdownOnce("unhandledRejection", 1);
});

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

Command.run(cli, { version }).pipe(
  Effect.scoped,
  Effect.provide(CliRuntimeLayer),
  NodeRuntime.runMain,
);
