import { Schema } from "effect";
import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";
import { ProviderKind } from "./orchestration";

/**
 * A session that was discovered on disk (from an external CLI run like
 * `codex`, `claude`, or `gemini`) and is available for import into
 * CodeWithMe as a new thread.
 */
export const DiscoveredSession = Schema.Struct({
  provider: ProviderKind,
  sessionId: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
  title: Schema.NullOr(Schema.String),
  messageCount: Schema.Number,
  firstActiveAt: IsoDateTime,
  lastActiveAt: IsoDateTime,
  fileSize: Schema.Number,
  filePath: TrimmedNonEmptyString,
});
export type DiscoveredSession = typeof DiscoveredSession.Type;

export const ListImportableSessionsInput = Schema.Struct({});
export type ListImportableSessionsInput = typeof ListImportableSessionsInput.Type;

export const ListImportableSessionsResult = Schema.Struct({
  sessions: Schema.Array(DiscoveredSession),
});
export type ListImportableSessionsResult = typeof ListImportableSessionsResult.Type;

export const ImportExternalSessionInput = Schema.Struct({
  provider: ProviderKind,
  sessionId: TrimmedNonEmptyString,
  filePath: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
  projectId: Schema.optional(ProjectId),
  /** Pre-seeded title (from first user message, truncated). */
  title: Schema.optional(TrimmedNonEmptyString),
});
export type ImportExternalSessionInput = typeof ImportExternalSessionInput.Type;

export const ImportExternalSessionResult = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
});
export type ImportExternalSessionResult = typeof ImportExternalSessionResult.Type;

export class SessionImportError extends Schema.TaggedErrorClass<SessionImportError>()(
  "SessionImportError",
  {
    message: TrimmedNonEmptyString,
    code: Schema.Literals([
      "NO_PROJECT_MATCH",
      "SESSION_NOT_FOUND",
      "ALREADY_IMPORTED",
      "BINDING_FAILED",
      "UNKNOWN",
    ]),
    suggestedProjectCwd: Schema.optional(TrimmedNonEmptyString),
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class SessionDiscoveryError extends Schema.TaggedErrorClass<SessionDiscoveryError>()(
  "SessionDiscoveryError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
