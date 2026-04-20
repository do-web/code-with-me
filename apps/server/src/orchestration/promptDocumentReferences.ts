import type { ChatAttachment } from "@codewithme/contracts";

import { resolveAttachmentPath } from "../attachmentStore";

const DOCUMENT_REFERENCES_HEADER =
  "[Attached documents for this turn — read them with your tools:]";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Appends a machine-readable list of document-attachment file paths to a
 * turn's prompt so the agent can open them with its own tooling.
 *
 * Non-document attachments (images) are ignored and left to be transported
 * through the provider-native attachment channel.
 *
 * Returns the prompt unchanged when no resolvable document attachments are
 * present. If the original prompt is empty but documents exist, a minimal
 * seed prompt is returned so the turn has a user-visible instruction.
 */
export function appendDocumentReferencesToPrompt(input: {
  readonly prompt: string | undefined;
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly attachmentsDir: string;
}): string {
  const basePrompt = input.prompt ?? "";
  const attachments = input.attachments ?? [];
  const documentLines: string[] = [];

  for (const attachment of attachments) {
    if (attachment.type !== "document") continue;
    const absolutePath = resolveAttachmentPath({
      attachmentsDir: input.attachmentsDir,
      attachment,
    });
    if (!absolutePath) continue;
    documentLines.push(
      `- ${attachment.name} (${attachment.mimeType}, ${formatSize(
        attachment.sizeBytes,
      )}) → ${absolutePath}`,
    );
  }

  if (documentLines.length === 0) {
    return basePrompt;
  }

  const referenceBlock = [DOCUMENT_REFERENCES_HEADER, ...documentLines].join("\n");
  if (basePrompt.trim().length === 0) {
    return ["Please read the attached documents:", "", referenceBlock].join("\n");
  }
  return [basePrompt, "", referenceBlock].join("\n");
}
