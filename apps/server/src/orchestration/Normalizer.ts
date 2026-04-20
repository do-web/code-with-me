import { Effect, FileSystem, Path } from "effect";
import {
  CHAT_DOCUMENT_MIME_PATTERN,
  type ChatAttachment,
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  PROVIDER_SEND_TURN_MAX_DOCUMENT_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type UploadChatAttachment,
} from "@codewithme/contracts";

import {
  expectedDocumentKindsForMime,
  parseBase64DataUrl,
  sniffDocumentKind,
} from "../attachmentMime";
import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore";
import { ServerConfig } from "../config";
import { WorkspacePaths } from "../workspace/Services/WorkspacePaths";

export const normalizeDispatchCommand = (command: ClientOrchestrationCommand) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const workspacePaths = yield* WorkspacePaths;

    const normalizeProjectWorkspaceRoot = (workspaceRoot: string) =>
      workspacePaths.normalizeWorkspaceRoot(workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: cause.message,
            }),
        ),
      );

    if (command.type === "project.create") {
      return {
        ...command,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(command.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (command.type === "project.meta.update" && command.workspaceRoot !== undefined) {
      return {
        ...command,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(command.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (command.type !== "thread.turn.start") {
      return command as OrchestrationCommand;
    }

    const writtenAttachmentPaths: string[] = [];

    const persistAttachmentBytes = (input: {
      readonly persistedAttachment: ChatAttachment;
      readonly bytes: Buffer;
      readonly displayName: string;
    }) =>
      Effect.gen(function* () {
        const attachmentPath = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment: input.persistedAttachment,
        });
        if (!attachmentPath) {
          return yield* new OrchestrationDispatchCommandError({
            message: `Failed to resolve persisted path for '${input.displayName}'.`,
          });
        }

        yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true }).pipe(
          Effect.mapError(
            () =>
              new OrchestrationDispatchCommandError({
                message: `Failed to create attachment directory for '${input.displayName}'.`,
              }),
          ),
        );
        yield* fileSystem.writeFile(attachmentPath, input.bytes).pipe(
          Effect.mapError(
            () =>
              new OrchestrationDispatchCommandError({
                message: `Failed to persist attachment '${input.displayName}'.`,
              }),
          ),
        );
        writtenAttachmentPaths.push(attachmentPath);
        return input.persistedAttachment;
      });

    const normalizeImageAttachment = (
      attachment: Extract<UploadChatAttachment, { type: "image" }>,
    ) =>
      Effect.gen(function* () {
        const parsed = parseBase64DataUrl(attachment.dataUrl);
        if (!parsed || !parsed.mimeType.startsWith("image/")) {
          return yield* new OrchestrationDispatchCommandError({
            message: `Invalid image attachment payload for '${attachment.name}'.`,
          });
        }

        const bytes = Buffer.from(parsed.base64, "base64");
        if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
          return yield* new OrchestrationDispatchCommandError({
            message: `Image attachment '${attachment.name}' is empty or too large.`,
          });
        }

        const attachmentId = createAttachmentId(command.threadId);
        if (!attachmentId) {
          return yield* new OrchestrationDispatchCommandError({
            message: "Failed to create a safe attachment id.",
          });
        }

        return yield* persistAttachmentBytes({
          persistedAttachment: {
            type: "image" as const,
            id: attachmentId,
            name: attachment.name,
            mimeType: parsed.mimeType.toLowerCase(),
            sizeBytes: bytes.byteLength,
          },
          bytes,
          displayName: attachment.name,
        });
      });

    const normalizeDocumentAttachment = (
      attachment: Extract<UploadChatAttachment, { type: "document" }>,
    ) =>
      Effect.gen(function* () {
        const parsed = parseBase64DataUrl(attachment.dataUrl);
        if (!parsed || !CHAT_DOCUMENT_MIME_PATTERN.test(parsed.mimeType)) {
          return yield* new OrchestrationDispatchCommandError({
            message: `Invalid document attachment payload for '${attachment.name}'.`,
          });
        }

        const bytes = Buffer.from(parsed.base64, "base64");
        if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_DOCUMENT_BYTES) {
          return yield* new OrchestrationDispatchCommandError({
            message: `Document attachment '${attachment.name}' is empty or too large.`,
          });
        }

        const sniffedKind = sniffDocumentKind(bytes);
        const expectedKinds = expectedDocumentKindsForMime(parsed.mimeType);
        if (sniffedKind === null || !expectedKinds.has(sniffedKind)) {
          return yield* new OrchestrationDispatchCommandError({
            message: `Document attachment '${attachment.name}' does not match the declared content type.`,
          });
        }

        const attachmentId = createAttachmentId(command.threadId);
        if (!attachmentId) {
          return yield* new OrchestrationDispatchCommandError({
            message: "Failed to create a safe attachment id.",
          });
        }

        return yield* persistAttachmentBytes({
          persistedAttachment: {
            type: "document" as const,
            id: attachmentId,
            name: attachment.name,
            mimeType: parsed.mimeType.toLowerCase(),
            sizeBytes: bytes.byteLength,
          },
          bytes,
          displayName: attachment.name,
        });
      });

    const normalizedAttachments = yield* Effect.forEach(
      command.message.attachments,
      (attachment: UploadChatAttachment) =>
        attachment.type === "document"
          ? normalizeDocumentAttachment(attachment)
          : normalizeImageAttachment(attachment),
      { concurrency: 1 },
    ).pipe(
      Effect.onError(() =>
        // Best-effort cleanup of already-written attachment files if a later
        // attachment in the same turn failed validation or I/O.
        Effect.forEach(
          writtenAttachmentPaths,
          (filePath) => fileSystem.remove(filePath).pipe(Effect.catch(() => Effect.void)),
          { concurrency: "unbounded" },
        ),
      ),
    );

    return {
      ...command,
      message: {
        ...command.message,
        attachments: normalizedAttachments,
      },
    } satisfies OrchestrationCommand;
  });
