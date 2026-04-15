import { type TimelineEntry } from "../../session-logic";

export interface TimelineSearchMatch {
  entryId: string;
  /** Row ID for scroll targeting. For grouped work entries, this is the first entry's ID. */
  rowId: string;
  textOffset: number;
  matchLength: number;
}

export interface HighlightSegment {
  text: string;
  isMatch: boolean;
  isActive: boolean;
}

export function extractSearchableText(entry: TimelineEntry): string {
  switch (entry.kind) {
    case "message":
      return entry.message.text;
    case "work": {
      const parts = [entry.entry.label];
      if (entry.entry.detail) parts.push(entry.entry.detail);
      if (entry.entry.command) parts.push(entry.entry.command);
      if (entry.entry.toolTitle) parts.push(entry.entry.toolTitle);
      return parts.join(" ");
    }
    case "proposed-plan":
      return entry.proposedPlan.planMarkdown;
  }
}

/**
 * Build a map from timeline entry ID to the row ID that contains it.
 * Mimics `deriveMessagesTimelineRows` grouping: consecutive work entries
 * are grouped into a single row whose ID is the first entry's ID.
 */
function buildEntryToRowIdMap(entries: ReadonlyArray<TimelineEntry>): Map<string, string> {
  const map = new Map<string, string>();
  let currentWorkGroupId: string | null = null;

  for (const entry of entries) {
    if (entry.kind === "work") {
      if (currentWorkGroupId === null) currentWorkGroupId = entry.id;
      map.set(entry.id, currentWorkGroupId);
    } else {
      currentWorkGroupId = null;
      map.set(entry.id, entry.id);
    }
  }
  return map;
}

export function findAllMatches(
  entries: ReadonlyArray<TimelineEntry>,
  query: string,
): TimelineSearchMatch[] {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length < 2) return [];

  const entryToRowId = buildEntryToRowIdMap(entries);
  const matches: TimelineSearchMatch[] = [];

  for (const entry of entries) {
    const text = extractSearchableText(entry).toLowerCase();
    const rowId = entryToRowId.get(entry.id);
    if (!rowId) continue;

    let startIndex = 0;
    while (startIndex < text.length) {
      const foundAt = text.indexOf(trimmed, startIndex);
      if (foundAt === -1) break;
      matches.push({
        entryId: entry.id,
        rowId,
        textOffset: foundAt,
        matchLength: trimmed.length,
      });
      startIndex = foundAt + 1;
    }
  }

  return matches;
}

export function splitTextForHighlight(
  text: string,
  query: string,
  activeOffset: number | null,
): HighlightSegment[] {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [{ text, isMatch: false, isActive: false }];

  const segments: HighlightSegment[] = [];
  const lowerText = text.toLowerCase();
  const lowerQuery = trimmed.toLowerCase();
  let cursor = 0;

  while (cursor < text.length) {
    const foundAt = lowerText.indexOf(lowerQuery, cursor);
    if (foundAt === -1) {
      segments.push({ text: text.slice(cursor), isMatch: false, isActive: false });
      break;
    }
    if (foundAt > cursor) {
      segments.push({ text: text.slice(cursor, foundAt), isMatch: false, isActive: false });
    }
    segments.push({
      text: text.slice(foundAt, foundAt + trimmed.length),
      isMatch: true,
      isActive: activeOffset === foundAt,
    });
    cursor = foundAt + trimmed.length;
  }

  if (segments.length === 0) {
    segments.push({ text, isMatch: false, isActive: false });
  }

  return segments;
}
