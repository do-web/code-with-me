import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";

import {
  __resetForTests,
  clearPidFileSync,
  killAllSync,
  readPidFileSync,
  register,
  setPidFilePath,
  size,
  snapshot,
  unregister,
} from "./childProcessRegistry.ts";

const PERSIST_WAIT_MS = 80; // > debounce window (50 ms)

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("ChildProcessRegistry", () => {
  let tmpDir: string;
  let pidFile: string;
  let originalKill: typeof process.kill;
  let killCalls: Array<{ pid: number; signal: string | number | undefined }>;

  beforeEach(() => {
    __resetForTests();
    tmpDir = mkdtempSync(path.join(tmpdir(), "cwm-registry-test-"));
    pidFile = path.join(tmpDir, "children.pids");
    originalKill = process.kill;
    killCalls = [];
    // Stub process.kill so the test never signals real processes.
    (process as unknown as { kill: typeof process.kill }).kill = ((
      pid: number,
      signal?: string | number,
    ) => {
      killCalls.push({ pid, signal });
      return true;
    }) as typeof process.kill;
  });

  afterEach(() => {
    (process as unknown as { kill: typeof process.kill }).kill = originalKill;
    __resetForTests();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("register / unregister updates the in-memory set", () => {
    register({ pid: 42, label: "codex:test" });
    assert.equal(size(), 1);
    const entries = snapshot();
    assert.equal(entries[0]?.pid, 42);
    assert.equal(entries[0]?.label, "codex:test");

    unregister(42);
    assert.equal(size(), 0);
  });

  it("refuses invalid pids without throwing", () => {
    register({ pid: 0, label: "bad" });
    register({ pid: -1, label: "bad" });
    register({ pid: Number.NaN, label: "bad" });
    assert.equal(size(), 0);
  });

  it("persists entries to the pid file (debounced)", async () => {
    setPidFilePath(pidFile);
    register({ pid: 101, label: "codex:a" });
    register({ pid: 102, pgid: 102, label: "pty:b" });

    await wait(PERSIST_WAIT_MS);

    const persisted = readPidFileSync(pidFile);
    assert.equal(persisted.length, 2);
    const byPid = new Map(persisted.map((e) => [e.pid, e]));
    assert.equal(byPid.get(101)?.label, "codex:a");
    assert.equal(byPid.get(102)?.pgid, 102);
  });

  it("readPidFileSync tolerates corrupt input", () => {
    writeFileSync(pidFile, "{not-json", "utf8");
    assert.deepEqual(readPidFileSync(pidFile), []);
  });

  it("clearPidFileSync writes an empty array", () => {
    writeFileSync(pidFile, '[{"pid":1,"label":"x","startTime":null}]', "utf8");
    clearPidFileSync(pidFile);
    assert.equal(readFileSync(pidFile, "utf8"), "[]");
  });

  it("killAllSync sends SIGKILL per entry and clears the map", () => {
    register({ pid: 201, label: "codex:a" });
    register({ pid: 202, pgid: 202, label: "pty:b" });

    killAllSync("SIGKILL");

    // POSIX path: pgid entry should be killed via negative pid.
    const pids = killCalls.map((c) => c.pid);
    if (process.platform !== "win32") {
      assert.isTrue(pids.includes(201));
      assert.isTrue(pids.includes(-202));
    }
    assert.equal(size(), 0);
  });

  it("killAllSync swallows errors from individual kills", () => {
    (process as unknown as { kill: typeof process.kill }).kill = ((pid: number) => {
      if (pid === 301) {
        throw new Error("ESRCH");
      }
      killCalls.push({ pid, signal: "SIGKILL" });
      return true;
    }) as typeof process.kill;

    register({ pid: 301, label: "already-dead" });
    register({ pid: 302, label: "still-alive" });

    killAllSync("SIGKILL");

    assert.equal(killCalls.length, 1);
    assert.equal(killCalls[0]?.pid, 302);
    assert.equal(size(), 0);
  });

  it("setPidFilePath flushes the current state on first call", async () => {
    register({ pid: 401, label: "pre" });
    setPidFilePath(pidFile);
    await wait(PERSIST_WAIT_MS);

    const persisted = readPidFileSync(pidFile);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]?.pid, 401);
  });
});
