import { useCallback, useMemo, useRef, useState } from "react";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { type TimelineEntry } from "../../session-logic";
import { findAllMatches, type TimelineSearchMatch } from "./timelineSearchUtils";

const SEARCH_DEBOUNCE_MS = 150;

export interface TimelineSearchState {
  isOpen: boolean;
  query: string;
  matches: ReadonlyArray<TimelineSearchMatch>;
  activeMatchIndex: number;
  /** Incremented on each navigation to trigger scroll even to the same entry. */
  scrollNonce: number;
}

export interface TimelineSearchActions {
  open: () => void;
  close: () => void;
  setQuery: (query: string) => void;
  goToNext: () => void;
  goToPrevious: () => void;
  /** Ref to the search input for programmatic focus. */
  inputRef: React.RefObject<HTMLInputElement | null>;
}

export function useTimelineSearch(
  timelineEntries: ReadonlyArray<TimelineEntry>,
): [TimelineSearchState, TimelineSearchActions] {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQueryRaw] = useState("");
  const [activeMatchIndex, setActiveMatchIndex] = useState(-1);
  const [scrollNonce, setScrollNonce] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [debouncedQuery] = useDebouncedValue(query, { wait: SEARCH_DEBOUNCE_MS });

  // Only recompute matches when debounced query or entry count changes.
  // Using entries.length instead of entries reference avoids recompute on every streaming token.
  const entriesLength = timelineEntries.length;
  const matches = useMemo(
    () => findAllMatches(timelineEntries, debouncedQuery),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [debouncedQuery, entriesLength],
  );

  // Reset active index when matches change
  const prevMatchesLengthRef = useRef(matches.length);
  if (prevMatchesLengthRef.current !== matches.length) {
    prevMatchesLengthRef.current = matches.length;
    if (matches.length > 0 && activeMatchIndex >= matches.length) {
      setActiveMatchIndex(0);
    } else if (matches.length === 0) {
      setActiveMatchIndex(-1);
    }
  }

  const setQuery = useCallback((value: string) => {
    setQueryRaw(value);
    setActiveMatchIndex(0);
    setScrollNonce((n) => n + 1);
  }, []);

  const open = useCallback(() => {
    setIsOpen(true);
    // Defer focus so the input is mounted first
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (input) {
        input.focus();
        input.select();
      }
    });
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setQueryRaw("");
    setActiveMatchIndex(-1);
  }, []);

  const goToNext = useCallback(() => {
    if (matches.length === 0) return;
    setActiveMatchIndex((prev) => (prev + 1 >= matches.length ? 0 : prev + 1));
    setScrollNonce((n) => n + 1);
  }, [matches.length]);

  const goToPrevious = useCallback(() => {
    if (matches.length === 0) return;
    setActiveMatchIndex((prev) => (prev - 1 < 0 ? matches.length - 1 : prev - 1));
    setScrollNonce((n) => n + 1);
  }, [matches.length]);

  const activeMatch = activeMatchIndex >= 0 ? matches[activeMatchIndex] : undefined;

  const state: TimelineSearchState = {
    isOpen,
    query,
    matches,
    activeMatchIndex: activeMatch ? activeMatchIndex : -1,
    scrollNonce,
  };

  const actions: TimelineSearchActions = {
    open,
    close,
    setQuery,
    goToNext,
    goToPrevious,
    inputRef,
  };

  return [state, actions];
}
