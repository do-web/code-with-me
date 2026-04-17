/**
 * GeminiAdapterLive - Gemini CLI provider adapter.
 *
 * Each turn spawns `gemini -p "..." -o stream-json` and parses NDJSON output.
 * Multi-turn sessions leverage `--resume latest`.
 *
 * @module GeminiAdapterLive
 */
import {
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderSendTurnInput,
  type ThreadTokenUsageSnapshot,
  EventId,
  RuntimeItemId,
  ThreadId,
  TurnId,
} from "@codewithme/contracts";
import { Cause, Duration, Effect, Fiber, Layer, Option, PubSub, Ref, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ProviderAdapterProcessError, ProviderAdapterSessionNotFoundError } from "../Errors.ts";
import { GeminiAdapter, type GeminiAdapterShape } from "../Services/GeminiAdapter.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { collectStreamAsString } from "../providerSnapshot.ts";

const PROVIDER = "gemini" as const;

/** Maximum time to wait for a single Gemini CLI turn before timing out. */
const TURN_TIMEOUT = Duration.minutes(2);

// ── Gemini stream-json types ───────────────────────────────────────

interface GeminiStreamInit {
  type: "init";
  session_id: string;
}

interface GeminiStreamMessage {
  type: "message";
  role: "user" | "assistant";
  content: string;
  delta?: boolean;
}

interface GeminiStreamToolUse {
  type: "tool_use";
  tool_name: string;
  tool_id: string;
  parameters: Record<string, unknown>;
}

interface GeminiStreamToolResult {
  type: "tool_result";
  tool_id: string;
  status: "success" | "error";
  output: string;
}

interface GeminiStreamResult {
  type: "result";
  status: "success" | "error";
  error?: unknown;
  stats: {
    total_tokens: number;
    input_tokens: number;
    output_tokens: number;
    cached: number;
    duration_ms: number;
    tool_calls: number;
  };
}

type GeminiStreamEvent =
  | GeminiStreamInit
  | GeminiStreamMessage
  | GeminiStreamToolUse
  | GeminiStreamToolResult
  | GeminiStreamResult;

// ── Stderr error extraction ───────────────────────────────────────

/** Known Gemini CLI error patterns surfaced on stderr. */
const STDERR_ERROR_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  {
    pattern: /exhausted your capacity/i,
    message: "Rate limit reached for this model. Try again later or switch to a different model.",
  },
  { pattern: /quota exceeded/i, message: "API quota exceeded. Try again later." },
  {
    pattern: /permission denied|unauthorized|unauthenticated/i,
    message: "Authentication failed. Run `gemini` interactively to re-authenticate.",
  },
  { pattern: /model .* not found|invalid model/i, message: "Model not found or not available." },
];

function extractStderrError(stderr: string): string | null {
  for (const { pattern, message } of STDERR_ERROR_PATTERNS) {
    if (pattern.test(stderr)) return message;
  }
  return null;
}

class GeminiFatalStderrError {
  readonly _tag = "GeminiFatalStderrError";
  constructor(readonly message: string) {}
}

/**
 * Spawn the Gemini CLI and collect output, but abort early if stderr contains
 * a fatal error (e.g. rate limits). This avoids waiting for the CLI's infinite
 * retry loop to complete.
 */
const spawnGeminiTurn = (binaryPath: string, command: ChildProcess.Command) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(command);

    // Stream stderr line-by-line — fails on fatal patterns, otherwise never resolves.
    // This ensures it can only win the race by failing, not by completing normally.
    const stderrWatcher = child.stderr.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => {
        const error = extractStderrError(line);
        return error ? Effect.fail(new GeminiFatalStderrError(error)) : Effect.void;
      }),
      Effect.andThen(Effect.never),
    );

    // Collect stdout and wait for exit
    const outputCollector = Effect.all(
      [collectStreamAsString(child.stdout), child.exitCode.pipe(Effect.map(Number))],
      { concurrency: "unbounded" },
    ).pipe(Effect.map(([stdout, code]) => ({ stdout, code })));

    // Race: outputCollector succeeds normally, stderrWatcher can only fail.
    // If stderr detects a fatal error, it fails the race immediately.
    const result = yield* Effect.raceFirst(outputCollector, stderrWatcher);
    return result;
  }).pipe(Effect.scoped);

// ── Session state ──────────────────────────────────────────────────

interface GeminiSessionState {
  session: ProviderSession;
  geminiSessionId: string | undefined;
  turnCount: number;
  currentTurnId: TurnId | undefined;
  currentFiber: Fiber.Fiber<void, never> | undefined;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  stopped: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────

export interface GeminiAdapterLiveOptions {
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function stamp(threadId: ThreadId, turnId?: TurnId) {
  return {
    eventId: EventId.makeUnsafe(crypto.randomUUID()),
    provider: "gemini" as const,
    threadId,
    createdAt: new Date().toISOString(),
    ...(turnId ? { turnId } : {}),
  };
}

export function makeGeminiAdapterLive(_options?: GeminiAdapterLiveOptions) {
  return Layer.effect(
    GeminiAdapter,
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const eventPubSub = yield* Effect.acquireRelease(
        PubSub.unbounded<ProviderRuntimeEvent>(),
        PubSub.shutdown,
      );
      const sessions = yield* Ref.make<Map<string, GeminiSessionState>>(new Map());
      const services = yield* Effect.services();
      const runFork = Effect.runForkWith(services);

      const emit = (event: ProviderRuntimeEvent) =>
        PubSub.publish(eventPubSub, event).pipe(Effect.asVoid);

      const getSession = (threadId: ThreadId) =>
        Ref.get(sessions).pipe(
          Effect.flatMap((map) => {
            const s = map.get(threadId);
            return s
              ? Effect.succeed(s)
              : Effect.fail(
                  new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
                );
          }),
        );

      const updateSession = (
        threadId: ThreadId,
        fn: (s: GeminiSessionState) => GeminiSessionState,
      ) =>
        Ref.update(sessions, (map) => {
          const s = map.get(threadId);
          if (!s) return map;
          const next = new Map(map);
          next.set(threadId, fn(s));
          return next;
        });

      const removeSession = (threadId: ThreadId) =>
        Ref.update(sessions, (map) => {
          const next = new Map(map);
          next.delete(threadId);
          return next;
        });

      // ── Run a single Gemini CLI turn ─────────────────────────────

      const runGeminiTurn = (
        threadId: ThreadId,
        turnId: TurnId,
        prompt: string,
        model: string,
        geminiSessionId: string | undefined,
      ) =>
        Effect.gen(function* () {
          const settings = yield* serverSettings.getSettings;
          const binaryPath = settings.providers.gemini.binaryPath || "gemini";

          const args = ["-p", prompt, "-o", "stream-json", "-m", model, "--approval-mode", "yolo"];
          if (geminiSessionId) {
            args.push("--resume", "latest");
          }

          const command = ChildProcess.make(binaryPath, args, {
            shell: process.platform === "win32",
          });
          const maybeResult = yield* spawnGeminiTurn(binaryPath, command).pipe(
            Effect.catchTag("GeminiFatalStderrError", (err) =>
              Effect.succeed({ stdout: "", code: 1, fatalError: err.message }),
            ),
            Effect.timeoutOption(TURN_TIMEOUT),
          );

          if (Option.isNone(maybeResult)) {
            yield* emit({
              ...stamp(threadId, turnId),
              type: "turn.completed",
              payload: {
                state: "failed",
                errorMessage:
                  "Gemini CLI timed out. The model may be overloaded — try again later or switch models.",
              },
            });
            return;
          }

          const result = maybeResult.value;

          // Fatal stderr error detected (e.g. rate limit) — fail immediately
          if ("fatalError" in result && result.fatalError) {
            yield* emit({
              ...stamp(threadId, turnId),
              type: "turn.completed",
              payload: { state: "failed", errorMessage: result.fatalError as string },
            });
            return;
          }

          const exitCode = result.code;

          // Parse NDJSON lines from stdout
          const lines = result.stdout.split("\n").filter((l: string) => l.trim().length > 0);
          let fullText = "";
          let textItemStarted = false;
          let hasResultEvent = false;
          const assistantItemId = RuntimeItemId.makeUnsafe(`gemini-msg-${turnId}`);

          for (const line of lines) {
            let ev: GeminiStreamEvent;
            try {
              ev = JSON.parse(line) as GeminiStreamEvent;
            } catch {
              continue;
            }

            switch (ev.type) {
              case "init": {
                yield* updateSession(threadId, (s) => ({
                  ...s,
                  geminiSessionId: (ev as GeminiStreamInit).session_id,
                }));
                break;
              }

              case "message": {
                const msg = ev as GeminiStreamMessage;
                if (msg.role !== "assistant" || !msg.delta) break;

                if (!textItemStarted) {
                  textItemStarted = true;
                  yield* emit({
                    ...stamp(threadId, turnId),
                    type: "item.started",
                    itemId: assistantItemId,
                    payload: { itemType: "assistant_message" },
                  });
                }
                fullText += msg.content;
                yield* emit({
                  ...stamp(threadId, turnId),
                  type: "content.delta",
                  itemId: assistantItemId,
                  payload: { streamKind: "assistant_text" as const, delta: msg.content },
                });
                break;
              }

              case "tool_use": {
                const tu = ev as GeminiStreamToolUse;
                const toolId = RuntimeItemId.makeUnsafe(`gemini-tool-${tu.tool_id}`);
                yield* emit({
                  ...stamp(threadId, turnId),
                  type: "item.started",
                  itemId: toolId,
                  payload: {
                    itemType: "command_execution",
                    title: tu.tool_name,
                    detail: JSON.stringify(tu.parameters),
                  },
                });
                break;
              }

              case "tool_result": {
                const tr = ev as GeminiStreamToolResult;
                const toolId = RuntimeItemId.makeUnsafe(`gemini-tool-${tr.tool_id}`);
                yield* emit({
                  ...stamp(threadId, turnId),
                  type: "item.completed",
                  itemId: toolId,
                  payload: {
                    itemType: "command_execution",
                    status: tr.status === "success" ? "completed" : "failed",
                    detail: tr.output,
                  },
                });
                break;
              }

              case "result": {
                hasResultEvent = true;
                const res = ev as GeminiStreamResult;

                if (textItemStarted) {
                  yield* emit({
                    ...stamp(threadId, turnId),
                    type: "item.completed",
                    itemId: assistantItemId,
                    payload: {
                      itemType: "assistant_message",
                      status: "completed",
                      data: { text: fullText },
                    },
                  });
                }

                const usage: ThreadTokenUsageSnapshot = {
                  usedTokens: res.stats.total_tokens,
                  inputTokens: res.stats.input_tokens,
                  outputTokens: res.stats.output_tokens,
                  cachedInputTokens: res.stats.cached,
                  durationMs: res.stats.duration_ms,
                  toolUses: res.stats.tool_calls,
                };

                yield* emit({
                  ...stamp(threadId, turnId),
                  type: "thread.token-usage.updated",
                  payload: { usage },
                });

                yield* emit({
                  ...stamp(threadId, turnId),
                  type: "turn.completed",
                  payload: {
                    state: res.status === "success" ? "completed" : "failed",
                    ...(res.error
                      ? {
                          errorMessage:
                            typeof res.error === "string"
                              ? res.error
                              : typeof res.error === "object" &&
                                  res.error !== null &&
                                  "message" in res.error
                                ? String((res.error as Record<string, unknown>).message)
                                : JSON.stringify(res.error),
                        }
                      : {}),
                  },
                });
                break;
              }
            }
          }

          // CLI exited without a result event — surface exit code
          if (!hasResultEvent) {
            const errorMessage =
              exitCode !== 0
                ? `Gemini CLI exited with code ${exitCode}`
                : "Gemini CLI exited without producing a response.";
            yield* emit({
              ...stamp(threadId, turnId),
              type: "turn.completed",
              payload: { state: "failed", errorMessage },
            });
          }
        });

      // ── Adapter shape ────────────────────────────────────────────

      const adapter: GeminiAdapterShape = {
        provider: PROVIDER,
        capabilities: { sessionModelSwitch: "restart-session" },

        startSession: (input: ProviderSessionStartInput) =>
          Effect.gen(function* () {
            const now = new Date().toISOString();
            const model = input.modelSelection?.model;
            const session: ProviderSession = {
              provider: PROVIDER,
              status: "ready",
              runtimeMode: input.runtimeMode,
              threadId: input.threadId,
              createdAt: now,
              updatedAt: now,
              ...(model ? { model } : {}),
              ...(input.cwd ? { cwd: input.cwd } : {}),
            };

            yield* Ref.update(sessions, (map) => {
              const next = new Map(map);
              next.set(input.threadId, {
                session,
                geminiSessionId: undefined,
                turnCount: 0,
                currentTurnId: undefined,
                currentFiber: undefined,
                turns: [],
                stopped: false,
              });
              return next;
            });

            yield* emit({ ...stamp(input.threadId), type: "session.started", payload: {} });
            yield* emit({
              ...stamp(input.threadId),
              type: "session.state.changed",
              payload: { state: "ready" },
            });

            return session;
          }),

        sendTurn: (input: ProviderSendTurnInput) =>
          Effect.gen(function* () {
            const state = yield* getSession(input.threadId);
            if (state.stopped) {
              return yield* new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: "Gemini session has been stopped.",
              });
            }

            const prompt = input.input ?? "";
            const model = input.modelSelection?.model ?? state.session.model ?? "gemini-2.5-pro";
            const turnId = TurnId.makeUnsafe(crypto.randomUUID());
            const now = new Date().toISOString();

            yield* updateSession(input.threadId, (s) => ({
              ...s,
              turnCount: s.turnCount + 1,
              currentTurnId: turnId,
              session: { ...s.session, status: "running" as const, updatedAt: now },
            }));

            yield* emit({
              ...stamp(input.threadId, turnId),
              type: "turn.started",
              payload: { model },
            });

            // Run CLI in background via runFork — store fiber for interrupt support
            const fiber = runFork(
              runGeminiTurn(input.threadId, turnId, prompt, model, state.geminiSessionId).pipe(
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                Effect.catchCause((cause) => {
                  // Fiber interruption (user cancel) — don't emit a failed turn
                  if (Cause.hasInterruptsOnly(cause)) return Effect.void;
                  return emit({
                    ...stamp(input.threadId, turnId),
                    type: "turn.completed",
                    payload: {
                      state: "failed",
                      errorMessage:
                        Cause.squash(cause) instanceof Error
                          ? (Cause.squash(cause) as Error).message
                          : "Gemini CLI process failed",
                    },
                  });
                }),
                Effect.ensuring(
                  updateSession(input.threadId, (s) => ({
                    ...s,
                    currentTurnId: undefined,
                    currentFiber: undefined,
                    session: {
                      ...s.session,
                      status: "ready" as const,
                      updatedAt: new Date().toISOString(),
                    },
                  })),
                ),
              ),
            );

            yield* updateSession(input.threadId, (s) => ({ ...s, currentFiber: fiber }));

            return { threadId: input.threadId, turnId };
          }),

        interruptTurn: (threadId: ThreadId) =>
          Effect.gen(function* () {
            const state = yield* getSession(threadId);
            if (state.currentTurnId) {
              // Interrupt the running fiber (kills the CLI process via Effect.scoped cleanup)
              if (state.currentFiber) {
                yield* Fiber.interrupt(state.currentFiber);
              }
              yield* emit({
                ...stamp(threadId, state.currentTurnId),
                type: "turn.aborted",
                payload: { reason: "User interrupted the turn." },
              });
            }
          }),

        respondToRequest: () => Effect.void,
        respondToUserInput: () => Effect.void,

        stopSession: (threadId: ThreadId) =>
          Effect.gen(function* () {
            yield* removeSession(threadId);
            yield* emit({
              ...stamp(threadId),
              type: "session.exited",
              payload: { exitKind: "graceful" },
            });
          }),

        listSessions: () =>
          Ref.get(sessions).pipe(
            Effect.map((map) => Array.from(map.values()).map((s) => s.session)),
          ),

        hasSession: (threadId: ThreadId) =>
          Ref.get(sessions).pipe(Effect.map((map) => map.has(threadId))),

        readThread: (threadId: ThreadId) =>
          getSession(threadId).pipe(Effect.map((state) => ({ threadId, turns: state.turns }))),

        rollbackThread: (threadId: ThreadId, numTurns: number) =>
          getSession(threadId).pipe(
            Effect.map((state) => ({
              threadId,
              turns: state.turns.slice(0, Math.max(0, state.turns.length - numTurns)),
            })),
          ),

        stopAll: () =>
          Ref.get(sessions).pipe(
            Effect.flatMap((map) =>
              Effect.all(
                Array.from(map.keys()).map((id) => adapter.stopSession(ThreadId.makeUnsafe(id))),
                { concurrency: "unbounded" },
              ),
            ),
            Effect.asVoid,
          ),

        get streamEvents() {
          return Stream.fromPubSub(eventPubSub);
        },
      };

      return adapter;
    }),
  );
}
