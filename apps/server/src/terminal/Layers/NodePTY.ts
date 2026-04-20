import { createRequire } from "node:module";

import { Effect, FileSystem, Layer, Path } from "effect";

import * as ChildProcessRegistry from "../../childProcessRegistry";
import { PtyAdapter, PtyAdapterShape, PtyExitEvent, PtyProcess } from "../Services/PTY";

let didEnsureSpawnHelperExecutable = false;

const resolveNodePtySpawnHelperPath = Effect.gen(function* () {
  const requireForNodePty = createRequire(import.meta.url);
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  const packageJsonPath = requireForNodePty.resolve("node-pty/package.json");
  const packageDir = path.dirname(packageJsonPath);
  const candidates = [
    path.join(packageDir, "build", "Release", "spawn-helper"),
    path.join(packageDir, "build", "Debug", "spawn-helper"),
    path.join(packageDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
  ];

  for (const candidate of candidates) {
    if (yield* fs.exists(candidate)) {
      return candidate;
    }
  }
  return null;
}).pipe(Effect.orElseSucceed(() => null));

export const ensureNodePtySpawnHelperExecutable = Effect.fn(function* (explicitPath?: string) {
  const fs = yield* FileSystem.FileSystem;
  if (process.platform === "win32") return;
  if (!explicitPath && didEnsureSpawnHelperExecutable) return;

  const helperPath = explicitPath ?? (yield* resolveNodePtySpawnHelperPath);
  if (!helperPath) return;
  if (!explicitPath) {
    didEnsureSpawnHelperExecutable = true;
  }

  if (!(yield* fs.exists(helperPath))) {
    return;
  }

  // Best-effort: avoid FileSystem.stat in packaged mode where some fs metadata can be missing.
  yield* fs.chmod(helperPath, 0o755).pipe(Effect.orElseSucceed(() => undefined));
});

class NodePtyProcess implements PtyProcess {
  private unregistered = false;

  constructor(private readonly process: import("node-pty").IPty) {
    // Auto-unregister from the child-process registry when the PTY exits on
    // its own (user typed `exit`, shell crashed, killed via manager). Without
    // this the PID file would keep growing.
    this.process.onExit(() => {
      this.unregisterOnce();
    });
  }

  get pid(): number {
    return this.process.pid;
  }

  write(data: string): void {
    this.process.write(data);
  }

  resize(cols: number, rows: number): void {
    this.process.resize(cols, rows);
  }

  kill(signal?: string): void {
    this.process.kill(signal);
    // Best-effort unregister so repeated kills don't leave stale entries.
    this.unregisterOnce();
  }

  onData(callback: (data: string) => void): () => void {
    const disposable = this.process.onData(callback);
    return () => {
      disposable.dispose();
    };
  }

  onExit(callback: (event: PtyExitEvent) => void): () => void {
    const disposable = this.process.onExit((event) => {
      callback({
        exitCode: event.exitCode,
        signal: event.signal ?? null,
      });
    });
    return () => {
      disposable.dispose();
    };
  }

  private unregisterOnce(): void {
    if (this.unregistered) return;
    this.unregistered = true;
    ChildProcessRegistry.unregister(this.process.pid);
  }
}

export const layer = Layer.effect(
  PtyAdapter,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const nodePty = yield* Effect.promise(() => import("node-pty"));

    const ensureNodePtySpawnHelperExecutableCached = yield* Effect.cached(
      ensureNodePtySpawnHelperExecutable().pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.orElseSucceed(() => undefined),
      ),
    );

    return {
      spawn: Effect.fn(function* (input) {
        yield* ensureNodePtySpawnHelperExecutableCached;
        const ptyProcess = nodePty.spawn(input.shell, input.args ?? [], {
          cwd: input.cwd,
          cols: input.cols,
          rows: input.rows,
          env: input.env,
          name: globalThis.process.platform === "win32" ? "xterm-color" : "xterm-256color",
        });
        if (typeof ptyProcess.pid === "number") {
          ChildProcessRegistry.register({
            pid: ptyProcess.pid,
            label: input.label,
          });
        }
        return new NodePtyProcess(ptyProcess);
      }),
    } satisfies PtyAdapterShape;
  }),
);
