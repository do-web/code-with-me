import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { readCodexAccountSnapshot, type CodexAccountSnapshot } from "./codexAccount";

interface JsonRpcProbeResponse {
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: {
    readonly message?: unknown;
  };
}

function readErrorMessage(response: JsonRpcProbeResponse): string | undefined {
  return typeof response.error?.message === "string" ? response.error.message : undefined;
}

export function buildCodexInitializeParams() {
  return {
    clientInfo: {
      name: "codewithme_desktop",
      title: "CodeWithMe Desktop",
      version: "0.1.0",
    },
    capabilities: {
      experimentalApi: true,
    },
  } as const;
}

const KILL_GRACE_MS = 3_000;

/**
 * Terminates a codex app-server child, preferring a process-group kill on
 * POSIX when the child was spawned with `detached: true`. That way any
 * sub-tools spawned by codex itself get the signal too, instead of becoming
 * grandchild-orphans.
 *
 * Escalation: SIGTERM → 3 s grace → SIGKILL. The grace timer is `unref`'d so
 * it doesn't keep the event loop alive, but it also means a crash-path exit
 * may skip the SIGKILL — that's why `ChildProcessRegistry.killAllSync` +
 * startup orphan-cleanup exist as backstops.
 */
export function killCodexChildProcess(child: ChildProcessWithoutNullStreams): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
      // Fall through to direct kill when taskkill is unavailable.
    }
  }

  const pid = child.pid;
  const killGroup = (signal: NodeJS.Signals): boolean => {
    if (process.platform === "win32" || pid === undefined) return false;
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      return false;
    }
  };

  if (!killGroup("SIGTERM")) {
    child.kill("SIGTERM");
  }

  // Escalate to SIGKILL if the process doesn't exit within the grace period.
  // This prevents zombie processes from holding PTY file descriptors open.
  const killTimer = setTimeout(() => {
    if (child.killed) return;
    if (!killGroup("SIGKILL")) {
      child.kill("SIGKILL");
    }
  }, KILL_GRACE_MS);
  killTimer.unref();
}

interface CodexAppServerProbeInput {
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly signal?: AbortSignal;
}

async function probeCodexAppServerRequest<T>(
  input: CodexAppServerProbeInput,
  request: {
    readonly method: string;
    readonly params: unknown;
    readonly errorLabel: string;
    readonly parseResult: (result: unknown) => T;
  },
): Promise<T> {
  return await new Promise((resolve, reject) => {
    const child = spawn(input.binaryPath, ["app-server"], {
      env: {
        ...process.env,
        ...(input.homePath ? { CODEX_HOME: input.homePath } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    const output = readline.createInterface({ input: child.stdout });

    let completed = false;

    const cleanup = () => {
      output.removeAllListeners();
      output.close();
      child.removeAllListeners();
      if (!child.killed) {
        killCodexChildProcess(child);
      }
    };

    const finish = (callback: () => void) => {
      if (completed) return;
      completed = true;
      cleanup();
      callback();
    };

    const fail = (error: unknown) =>
      finish(() =>
        reject(
          error instanceof Error
            ? error
            : new Error(`Codex account probe failed: ${String(error)}.`),
        ),
      );

    if (input.signal?.aborted) {
      fail(new Error("Codex account probe aborted."));
      return;
    }
    input.signal?.addEventListener("abort", () => fail(new Error("Codex account probe aborted.")));

    const writeMessage = (message: unknown) => {
      if (!child.stdin.writable) {
        fail(new Error("Cannot write to codex app-server stdin."));
        return;
      }

      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    output.on("line", (line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        fail(
          new Error(`Received invalid JSON from codex app-server during ${request.errorLabel}.`),
        );
        return;
      }

      if (!parsed || typeof parsed !== "object") {
        return;
      }

      const response = parsed as JsonRpcProbeResponse;
      if (response.id === 1) {
        const errorMessage = readErrorMessage(response);
        if (errorMessage) {
          fail(new Error(`initialize failed: ${errorMessage}`));
          return;
        }

        writeMessage({ method: "initialized" });
        writeMessage({ id: 2, method: request.method, params: request.params });
        return;
      }

      if (response.id === 2) {
        const errorMessage = readErrorMessage(response);
        if (errorMessage) {
          fail(new Error(`${request.errorLabel} failed: ${errorMessage}`));
          return;
        }

        finish(() => resolve(request.parseResult(response.result)));
      }
    });

    child.once("error", fail);
    child.once("exit", (code, signal) => {
      if (completed) return;
      fail(
        new Error(
          `codex app-server exited before probe completed (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
        ),
      );
    });

    writeMessage({
      id: 1,
      method: "initialize",
      params: buildCodexInitializeParams(),
    });
  });
}

export async function probeCodexAccount(
  input: CodexAppServerProbeInput,
): Promise<CodexAccountSnapshot> {
  return await probeCodexAppServerRequest(input, {
    method: "account/read",
    params: {},
    errorLabel: "account/read",
    parseResult: readCodexAccountSnapshot,
  });
}

export async function probeCodexRateLimits(input: CodexAppServerProbeInput): Promise<unknown> {
  return await probeCodexAppServerRequest(input, {
    method: "account/rateLimits/read",
    params: null,
    errorLabel: "account/rateLimits/read",
    parseResult: (result) => result,
  });
}
