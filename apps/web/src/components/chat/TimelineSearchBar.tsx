import { memo, useCallback, type KeyboardEvent } from "react";
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

interface TimelineSearchBarProps {
  query: string;
  activeMatchIndex: number;
  totalMatchCount: number;
  onQueryChange: (value: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}

export const TimelineSearchBar = memo(function TimelineSearchBar(props: TimelineSearchBarProps) {
  const {
    query,
    activeMatchIndex,
    totalMatchCount,
    onQueryChange,
    onNext,
    onPrevious,
    onClose,
    inputRef,
  } = props;

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        if (event.shiftKey) {
          onPrevious();
        } else {
          onNext();
        }
      }
    },
    [onClose, onNext, onPrevious],
  );

  const counterLabel =
    totalMatchCount === 0
      ? query.trim().length >= 2
        ? "No results"
        : ""
      : `${activeMatchIndex + 1} of ${totalMatchCount}`;

  return (
    <div
      role="search"
      className="absolute top-2 right-4 z-20 flex items-center gap-1.5 rounded-lg border border-border bg-card px-2 py-1 shadow-sm"
    >
      <Input
        ref={inputRef}
        type="search"
        size="sm"
        placeholder="Find in conversation..."
        value={query}
        onChange={(event) => onQueryChange((event.target as HTMLInputElement).value)}
        onKeyDown={onKeyDown}
        className="h-7 w-48 text-xs"
        nativeInput
      />
      {counterLabel && (
        <span className="whitespace-nowrap text-[11px] text-muted-foreground" aria-live="polite">
          {counterLabel}
        </span>
      )}
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        onClick={onPrevious}
        disabled={totalMatchCount === 0}
        aria-label="Previous match"
      >
        <ChevronUpIcon className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        onClick={onNext}
        disabled={totalMatchCount === 0}
        aria-label="Next match"
      >
        <ChevronDownIcon className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        onClick={onClose}
        aria-label="Close search"
      >
        <XIcon className="size-3.5" />
      </Button>
    </div>
  );
});
