import { ChevronUp, TerminalSquare, TriangleAlert, XCircle } from "lucide-react";

interface CollapsedTerminalBarProps {
  lastMessage: string;
  warningCount: number;
  errorCount: number;
  onExpand: () => void;
}

export function CollapsedTerminalBar({
  lastMessage,
  warningCount,
  errorCount,
  onExpand,
}: CollapsedTerminalBarProps) {
  return (
    <div
      className="flex h-9 w-full shrink-0 cursor-pointer items-center gap-2 bg-background px-3 transition-colors hover:bg-accent/30"
      onClick={onExpand}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onExpand();
        }
      }}
    >
      <TerminalSquare className="size-3.5 shrink-0 text-muted-foreground" />

      <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
        {lastMessage || "\u00A0"}
      </span>

      {warningCount > 0 && (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-yellow-500/15 px-1.5 py-0.5 text-xs font-medium text-yellow-600 dark:text-yellow-400">
          <TriangleAlert className="size-3" />
          {warningCount}
        </span>
      )}

      {errorCount > 0 && (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-red-500/15 px-1.5 py-0.5 text-xs font-medium text-red-600 dark:text-red-400">
          <XCircle className="size-3" />
          {errorCount}
        </span>
      )}

      <button
        className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        onClick={(e) => {
          e.stopPropagation();
          onExpand();
        }}
        aria-label="Expand terminal"
      >
        <ChevronUp className="size-3.5" />
      </button>
    </div>
  );
}
