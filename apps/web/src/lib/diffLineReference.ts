export interface DiffLineReferenceDetail {
  filePath: string;
  lineNumber: number;
  side: "additions" | "deletions";
}

const EVENT_NAME = "diff-line-reference";

export function dispatchDiffLineReference(detail: DiffLineReferenceDetail) {
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail }));
}

export function onDiffLineReference(
  handler: (detail: DiffLineReferenceDetail) => void,
): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<DiffLineReferenceDetail>).detail);
  window.addEventListener(EVENT_NAME, listener);
  return () => window.removeEventListener(EVENT_NAME, listener);
}
