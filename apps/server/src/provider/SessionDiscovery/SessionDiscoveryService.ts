import {
  CommandId,
  type DiscoveredSession,
  type ImportExternalSessionInput,
  type ImportExternalSessionResult,
  type ImportedMessageInput,
  type ProviderKind,
  IsoDateTime,
  MessageId,
  ProjectId,
  SessionImportError,
  ThreadId,
  TrimmedNonEmptyString,
} from "@codewithme/contracts";
import { Effect, Option, ServiceMap, type Layer } from "effect";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
} from "../Services/ProviderSessionDirectory.ts";
import { matchProjectByCwd } from "./matchProject.ts";
import { parseSessionMessages } from "./parseSessionMessages.ts";
import { scanClaudeSessions } from "./scanners/claude.ts";
import { scanCodexSessions } from "./scanners/codex.ts";
import { scanGeminiSessions } from "./scanners/gemini.ts";
import type { DiscoveredSessionRecord } from "./types.ts";

const CACHE_TTL_MS = 30_000;

export interface SessionDiscoveryServiceShape {
  readonly listImportable: () => Effect.Effect<ReadonlyArray<DiscoveredSession>>;
  readonly importSession: (
    input: ImportExternalSessionInput,
  ) => Effect.Effect<ImportExternalSessionResult, SessionImportError>;
}

export class SessionDiscoveryService extends ServiceMap.Service<
  SessionDiscoveryService,
  SessionDiscoveryServiceShape
>()("codewithme/provider/SessionDiscovery/SessionDiscoveryService") {}

type DiscoveryCacheEntry = {
  readonly storedAt: number;
  readonly records: ReadonlyArray<DiscoveredSessionRecord>;
};

async function scanAllProviders(): Promise<Array<DiscoveredSessionRecord>> {
  const [codex, claude, gemini] = await Promise.all([
    scanCodexSessions().catch((error) => {
      console.warn("[session-discovery] codex scanner failed:", error);
      return [] as Array<DiscoveredSessionRecord>;
    }),
    scanClaudeSessions().catch((error) => {
      console.warn("[session-discovery] claude scanner failed:", error);
      return [] as Array<DiscoveredSessionRecord>;
    }),
    scanGeminiSessions().catch((error) => {
      console.warn("[session-discovery] gemini scanner failed:", error);
      return [] as Array<DiscoveredSessionRecord>;
    }),
  ]);
  return [...codex, ...claude, ...gemini];
}

function readSessionIdFromBinding(binding: ProviderRuntimeBinding): string | null {
  const payload = binding.runtimePayload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const candidate = (payload as Record<string, unknown>).sessionId;
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
    const imported = (payload as Record<string, unknown>).importedSessionId;
    if (typeof imported === "string" && imported.length > 0) {
      return imported;
    }
  }
  const cursor = binding.resumeCursor;
  if (cursor && typeof cursor === "object" && !Array.isArray(cursor)) {
    const rec = cursor as Record<string, unknown>;
    if (typeof rec.resume === "string" && rec.resume.length > 0) return rec.resume;
    if (typeof rec.sessionId === "string" && rec.sessionId.length > 0) return rec.sessionId;
    if (typeof rec.threadId === "string" && rec.threadId.length > 0 && binding.provider === "codex")
      return rec.threadId;
  }
  return null;
}

function buildResumeCursor(input: {
  readonly provider: ProviderKind;
  readonly sessionId: string;
  readonly threadId: ThreadId;
  readonly filePath: string;
}): Record<string, unknown> {
  switch (input.provider) {
    case "codex":
      return { threadId: input.sessionId };
    case "claudeAgent":
      return {
        threadId: input.threadId,
        resume: input.sessionId,
        turnCount: 0,
      };
    case "gemini":
      return { sessionId: input.sessionId, filePath: input.filePath };
  }
}

function deriveTitle(title: string | null | undefined, sessionId: string, cwd: string): string {
  if (title && title.trim().length > 0) return title.trim().slice(0, 80);
  const cwdLabel = cwd.split("/").pop() ?? cwd;
  return `Imported ${cwdLabel} · ${sessionId.slice(0, 8)}`;
}

function makeImportError(
  code: SessionImportError["code"],
  message: string,
  extra?: {
    readonly suggestedProjectCwd?: string;
    readonly cause?: unknown;
  },
): SessionImportError {
  return new SessionImportError({
    code,
    message: TrimmedNonEmptyString.makeUnsafe(message),
    ...(extra?.suggestedProjectCwd
      ? { suggestedProjectCwd: TrimmedNonEmptyString.makeUnsafe(extra.suggestedProjectCwd) }
      : {}),
    ...(extra?.cause !== undefined ? { cause: extra.cause } : {}),
  });
}

function buildDefaultModelSelection(provider: ProviderKind) {
  switch (provider) {
    case "codex":
      return {
        provider: "codex" as const,
        model: TrimmedNonEmptyString.makeUnsafe("gpt-5.4"),
      };
    case "claudeAgent":
      return {
        provider: "claudeAgent" as const,
        model: TrimmedNonEmptyString.makeUnsafe("claude-sonnet-4-6"),
      };
    case "gemini":
      return {
        provider: "gemini" as const,
        model: TrimmedNonEmptyString.makeUnsafe("gemini-2.5-pro"),
      };
  }
}

export const makeSessionDiscoveryService = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const directory = yield* ProviderSessionDirectory;

  let cache: DiscoveryCacheEntry | null = null;

  const getCachedRecords = () =>
    Effect.gen(function* () {
      if (cache && Date.now() - cache.storedAt < CACHE_TTL_MS) {
        return cache.records;
      }
      const records = yield* Effect.promise(() => scanAllProviders());
      cache = { storedAt: Date.now(), records };
      return records;
    });

  const collectImportedSessionIds = Effect.gen(function* () {
    const ids = yield* directory.listThreadIds().pipe(Effect.orElseSucceed(() => [] as const));
    const bindings = yield* Effect.forEach(
      ids,
      (threadId) =>
        directory
          .getBinding(threadId)
          .pipe(Effect.orElseSucceed(() => Option.none<ProviderRuntimeBinding>())),
      { concurrency: "unbounded" },
    );
    // Re-allow imports for sessions whose CodeWithMe thread was archived or
    // deleted; otherwise the user could never re-attach a session after
    // cleaning up a mistaken import.
    const readModel = yield* engine.getReadModel();
    const threadStatusById = new Map<string, { archived: boolean; deleted: boolean }>();
    for (const thread of readModel.threads) {
      threadStatusById.set(thread.id, {
        archived: thread.archivedAt !== null,
        deleted: thread.deletedAt !== null,
      });
    }
    const seen = new Set<string>();
    for (const opt of bindings) {
      const binding = Option.getOrUndefined(opt);
      if (!binding) continue;
      const status = threadStatusById.get(binding.threadId);
      if (status && (status.archived || status.deleted)) continue;
      const sessionId = readSessionIdFromBinding(binding);
      if (sessionId) seen.add(`${binding.provider}:${sessionId}`);
    }
    return seen;
  });

  const listImportable: SessionDiscoveryServiceShape["listImportable"] = () =>
    Effect.gen(function* () {
      const [records, importedKeys] = yield* Effect.all([
        getCachedRecords(),
        collectImportedSessionIds,
      ]);
      return records
        .filter((record) => !importedKeys.has(`${record.provider}:${record.sessionId}`))
        .map(
          (record): DiscoveredSession => ({
            provider: record.provider,
            sessionId: TrimmedNonEmptyString.makeUnsafe(record.sessionId),
            cwd: TrimmedNonEmptyString.makeUnsafe(record.cwd),
            title: record.title,
            messageCount: record.messageCount,
            firstActiveAt: IsoDateTime.makeUnsafe(record.firstActiveAt),
            lastActiveAt: IsoDateTime.makeUnsafe(record.lastActiveAt),
            fileSize: record.fileSize,
            filePath: TrimmedNonEmptyString.makeUnsafe(record.filePath),
          }),
        );
    });

  const importSession: SessionDiscoveryServiceShape["importSession"] = (input) =>
    Effect.gen(function* () {
      const readModel = yield* engine.getReadModel();
      const matchedProjectId = input.projectId ?? matchProjectByCwd(input.cwd, readModel.projects);

      // Invalidate cache up-front — the imported session will be filtered out
      // from the next list regardless of which branch we take below.
      cache = null;

      const createdAt = new Date().toISOString();
      let targetProjectId: ProjectId;

      if (matchedProjectId) {
        const matchedProject = readModel.projects.find((p) => p.id === matchedProjectId);
        if (!matchedProject) {
          return yield* makeImportError(
            "NO_PROJECT_MATCH",
            `Project '${matchedProjectId}' not found in read model.`,
          );
        }
        targetProjectId = matchedProject.id;
      } else {
        // Auto-create a project rooted at the session cwd so the user doesn't
        // have to leave the import dialog. Title defaults to the last path
        // segment of the cwd.
        const autoProjectId = ProjectId.makeUnsafe(crypto.randomUUID());
        const autoTitle =
          input.cwd
            .split("/")
            .filter((segment) => segment.length > 0)
            .at(-1) ?? input.cwd;
        yield* engine
          .dispatch({
            type: "project.create",
            commandId: CommandId.makeUnsafe(`import-session-project:${crypto.randomUUID()}`),
            projectId: autoProjectId,
            title: TrimmedNonEmptyString.makeUnsafe(autoTitle),
            workspaceRoot: TrimmedNonEmptyString.makeUnsafe(input.cwd),
            createdAt: IsoDateTime.makeUnsafe(createdAt),
          })
          .pipe(
            Effect.mapError((cause) =>
              makeImportError(
                "BINDING_FAILED",
                `Failed to auto-create project at '${input.cwd}'.`,
                { cause },
              ),
            ),
          );
        targetProjectId = autoProjectId;
      }

      const newThreadId = ThreadId.makeUnsafe(crypto.randomUUID());
      const title = deriveTitle(input.title ?? null, input.sessionId, input.cwd);

      yield* engine
        .dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(`import-session:${crypto.randomUUID()}`),
          threadId: newThreadId,
          projectId: targetProjectId,
          title: TrimmedNonEmptyString.makeUnsafe(title),
          modelSelection: buildDefaultModelSelection(input.provider),
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: IsoDateTime.makeUnsafe(createdAt),
        })
        .pipe(
          Effect.mapError((cause) =>
            makeImportError("BINDING_FAILED", "Failed to create thread for imported session.", {
              cause,
            }),
          ),
        );

      // Replay prior conversation messages from the on-disk session file into
      // the thread's event stream so users see the context they had in the
      // external CLI. Parsing failures are non-fatal — worst case the thread
      // starts empty and the provider still has the full history via
      // resumeCursor.
      const parsedMessages = yield* Effect.promise(() =>
        parseSessionMessages({
          provider: input.provider,
          filePath: input.filePath,
        }),
      );
      if (parsedMessages.length > 0) {
        const importedMessages: Array<ImportedMessageInput> = parsedMessages.map((message) => ({
          messageId: MessageId.makeUnsafe(crypto.randomUUID()),
          role: message.role,
          text: message.text,
          createdAt: IsoDateTime.makeUnsafe(message.createdAt),
        }));
        yield* engine
          .dispatch({
            type: "thread.messages.import",
            commandId: CommandId.makeUnsafe(`import-messages:${crypto.randomUUID()}`),
            threadId: newThreadId,
            messages: importedMessages,
            createdAt: IsoDateTime.makeUnsafe(createdAt),
          })
          .pipe(Effect.ignoreCause({ log: true }));
      }

      const resumeCursor = buildResumeCursor({
        provider: input.provider,
        sessionId: input.sessionId,
        threadId: newThreadId,
        filePath: input.filePath,
      });

      yield* directory
        .upsert({
          threadId: newThreadId,
          provider: input.provider,
          adapterKey: input.provider,
          runtimeMode: "full-access",
          status: "stopped",
          resumeCursor,
          runtimePayload: {
            cwd: input.cwd,
            sessionId: input.sessionId,
            importedSessionId: input.sessionId,
            importedFilePath: input.filePath,
            importedAt: createdAt,
          },
        })
        .pipe(
          Effect.mapError((cause) =>
            makeImportError(
              "BINDING_FAILED",
              "Failed to persist provider binding for imported session.",
              { cause },
            ),
          ),
        );

      return {
        threadId: newThreadId,
        projectId: targetProjectId,
      } satisfies ImportExternalSessionResult;
    });

  return {
    listImportable,
    importSession,
  } satisfies SessionDiscoveryServiceShape;
});

export type SessionDiscoveryServiceLayer = Layer.Layer<
  SessionDiscoveryService,
  never,
  OrchestrationEngineService | ProviderSessionDirectory
>;
