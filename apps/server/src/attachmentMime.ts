import Mime from "@effect/platform-node/Mime";

export const IMAGE_EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  "image/avif": ".avif",
  "image/bmp": ".bmp",
  "image/gif": ".gif",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/svg+xml": ".svg",
  "image/tiff": ".tiff",
  "image/webp": ".webp",
};

export const SAFE_IMAGE_FILE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".tiff",
  ".webp",
]);

export const DOCUMENT_EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/rtf": ".rtf",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/vnd.oasis.opendocument.text": ".odt",
  "application/vnd.oasis.opendocument.spreadsheet": ".ods",
  "application/vnd.oasis.opendocument.presentation": ".odp",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "text/tab-separated-values": ".tsv",
  "text/markdown": ".md",
  "text/x-log": ".log",
};

export const SAFE_DOCUMENT_FILE_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".rtf",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".odt",
  ".ods",
  ".odp",
  ".txt",
  ".csv",
  ".tsv",
  ".md",
  ".log",
]);

export function parseBase64DataUrl(
  dataUrl: string,
): { readonly mimeType: string; readonly base64: string } | null {
  const match = /^data:([^,]+),([a-z0-9+/=\r\n ]+)$/i.exec(dataUrl.trim());
  if (!match) return null;

  const headerParts = (match[1] ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (headerParts.length < 2) {
    return null;
  }
  const trailingToken = headerParts.at(-1)?.toLowerCase();
  if (trailingToken !== "base64") {
    return null;
  }

  const mimeType = headerParts[0]?.toLowerCase();
  const base64 = match[2]?.replace(/\s+/g, "");
  if (!mimeType || !base64) return null;

  return { mimeType, base64 };
}

function inferExtension(input: {
  mimeType: string;
  fileName: string | undefined;
  byMime: Record<string, string>;
  safeExtensions: ReadonlySet<string>;
}): string {
  const key = input.mimeType.toLowerCase();
  const fromMime = Object.hasOwn(input.byMime, key) ? input.byMime[key] : undefined;
  if (fromMime) {
    return fromMime;
  }

  const fromMimeExtension = Mime.getExtension(input.mimeType);
  if (fromMimeExtension && input.safeExtensions.has(fromMimeExtension)) {
    return fromMimeExtension;
  }

  const fileName = input.fileName?.trim() ?? "";
  const extensionMatch = /\.([a-z0-9]{1,8})$/i.exec(fileName);
  const fileNameExtension = extensionMatch ? `.${extensionMatch[1]!.toLowerCase()}` : "";
  if (input.safeExtensions.has(fileNameExtension)) {
    return fileNameExtension;
  }

  return ".bin";
}

export function inferImageExtension(input: { mimeType: string; fileName?: string }): string {
  return inferExtension({
    mimeType: input.mimeType,
    fileName: input.fileName,
    byMime: IMAGE_EXTENSION_BY_MIME_TYPE,
    safeExtensions: SAFE_IMAGE_FILE_EXTENSIONS,
  });
}

export function inferDocumentExtension(input: { mimeType: string; fileName?: string }): string {
  return inferExtension({
    mimeType: input.mimeType,
    fileName: input.fileName,
    byMime: DOCUMENT_EXTENSION_BY_MIME_TYPE,
    safeExtensions: SAFE_DOCUMENT_FILE_EXTENSIONS,
  });
}

export type DocumentMagicKind = "pdf" | "office-zip" | "office-cfb" | "rtf" | "text";

/**
 * Detects the document family of a byte buffer via magic bytes.
 * Used to prevent MIME spoofing attacks on uploaded documents.
 *
 * Returns null for unknown/empty payloads.
 */
export function sniffDocumentKind(bytes: Uint8Array): DocumentMagicKind | null {
  if (bytes.byteLength === 0) return null;

  const head = bytes.subarray(0, Math.min(bytes.byteLength, 1024));
  const headAscii = Buffer.from(head).toString("binary");
  if (headAscii.includes("%PDF-")) return "pdf";

  if (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  ) {
    return "office-zip";
  }

  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0 &&
    bytes[4] === 0xa1 &&
    bytes[5] === 0xb1 &&
    bytes[6] === 0x1a &&
    bytes[7] === 0xe1
  ) {
    return "office-cfb";
  }

  if (headAscii.startsWith("{\\rtf")) return "rtf";

  const textProbe = bytes.subarray(0, Math.min(bytes.byteLength, 4096));
  const hasNull = textProbe.some((byte) => byte === 0x00);
  if (!hasNull) return "text";

  return null;
}

/**
 * Categorise a MIME type to the expected magic-byte family.
 * Returns the set of magic kinds acceptable for the MIME type.
 */
export function expectedDocumentKindsForMime(mimeType: string): ReadonlySet<DocumentMagicKind> {
  const lower = mimeType.toLowerCase();
  if (lower === "application/pdf") return new Set(["pdf"]);
  if (lower === "application/rtf") return new Set(["rtf", "text"]);
  if (lower === "application/msword") return new Set(["office-cfb"]);
  if (lower === "application/vnd.ms-excel") return new Set(["office-cfb"]);
  if (lower === "application/vnd.ms-powerpoint") return new Set(["office-cfb"]);
  if (lower.startsWith("application/vnd.openxmlformats-officedocument."))
    return new Set(["office-zip"]);
  if (lower.startsWith("application/vnd.oasis.opendocument.")) return new Set(["office-zip"]);
  if (lower.startsWith("text/")) return new Set(["text"]);
  return new Set();
}
