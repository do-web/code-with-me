/**
 * ANSI escape code stripping utility.
 *
 * Shared between server and web packages to avoid duplication.
 */

export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\].*?\x07/g, "")
    .replace(/\x1b[>]\d+[a-zA-Z]/g, "")
    .replace(/\x1b[<][a-zA-Z]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}
