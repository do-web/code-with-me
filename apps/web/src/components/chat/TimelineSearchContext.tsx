import { createContext, useContext } from "react";

export interface TimelineSearchContextValue {
  /** Current search query. Empty string when search is inactive. */
  query: string;
  /** Entry ID of the currently active (navigated-to) match. */
  activeMatchEntryId: string | null;
  /** Active match text offset within the entry (for precise highlight). */
  activeMatchTextOffset: number | null;
  /** Set of entry IDs that have at least one match — O(1) lookup per row. */
  matchingEntryIds: ReadonlySet<string>;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

const defaultValue: TimelineSearchContextValue = {
  query: "",
  activeMatchEntryId: null,
  activeMatchTextOffset: null,
  matchingEntryIds: EMPTY_SET,
};

export const TimelineSearchContext = createContext<TimelineSearchContextValue>(defaultValue);

export function useTimelineSearchContext(): TimelineSearchContextValue {
  return useContext(TimelineSearchContext);
}
