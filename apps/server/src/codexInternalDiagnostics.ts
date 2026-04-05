const CODEX_INTERNAL_DIAGNOSTIC_PREFIXES = ["[ede_diagnostic]"] as const;

export function isCodexInternalDiagnosticText(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    CODEX_INTERNAL_DIAGNOSTIC_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
  );
}

export function sanitizeCodexConversationText(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return isCodexInternalDiagnosticText(value) ? "" : value;
}
