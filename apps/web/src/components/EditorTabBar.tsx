import { DiffIcon, MessageSquareIcon, XIcon } from "lucide-react";
import { memo, useCallback, type MouseEvent } from "react";
import { cn } from "~/lib/utils";
import { useFileExplorerStore, type OpenFileEntry } from "../fileExplorerStore";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";

function basenameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

function resolveTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

const FileTab = memo(function FileTab({
  file,
  isActive,
  showingDiff,
  onActivate,
  onClose,
  onToggleDiff,
}: {
  file: OpenFileEntry;
  isActive: boolean;
  showingDiff: boolean;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
  onToggleDiff: (path: string) => void;
}) {
  const handleClose = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      onClose(file.relativePath);
    },
    [file.relativePath, onClose],
  );

  const handleToggleDiff = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      onToggleDiff(file.relativePath);
    },
    [file.relativePath, onToggleDiff],
  );

  return (
    <button
      type="button"
      className={cn(
        "group flex h-full shrink-0 items-center gap-1.5 border-r border-border/60 px-3 text-xs transition-colors",
        isActive
          ? "bg-background text-foreground"
          : "bg-card/50 text-muted-foreground hover:bg-card hover:text-foreground",
      )}
      onClick={() => onActivate(file.relativePath)}
    >
      <VscodeEntryIcon
        pathValue={file.relativePath}
        kind="file"
        theme={resolveTheme()}
        className="size-3.5"
      />
      <span className="max-w-32 truncate">
        {basenameOf(file.relativePath)}
        {file.isDirty && (
          <span className="text-amber-500" title="Unsaved changes – Cmd/Ctrl+S to save">
            *
          </span>
        )}
      </span>
      {/* Diff toggle – visible when tab is active */}
      {isActive && (
        <span
          role="button"
          tabIndex={-1}
          title={showingDiff ? "Show editor" : "Show changes"}
          className={cn(
            "shrink-0 rounded p-0.5 transition-colors",
            showingDiff
              ? "bg-sky-500/20 text-sky-600 dark:text-sky-400"
              : "text-muted-foreground/60 hover:bg-secondary hover:text-foreground",
          )}
          onClick={handleToggleDiff}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.stopPropagation();
              onToggleDiff(file.relativePath);
            }
          }}
        >
          <DiffIcon className="size-3" />
        </span>
      )}
      <span
        role="button"
        tabIndex={-1}
        className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-secondary group-hover:opacity-100"
        onClick={handleClose}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.stopPropagation();
            onClose(file.relativePath);
          }
        }}
      >
        <XIcon className="size-3" />
      </span>
    </button>
  );
});

export function EditorTabBar() {
  const openFiles = useFileExplorerStore((s) => s.openFiles);
  const activeFilePath = useFileExplorerStore((s) => s.activeFilePath);
  const diffViewPaths = useFileExplorerStore((s) => s.diffViewPaths);
  const setActiveFile = useFileExplorerStore((s) => s.setActiveFile);
  const closeFile = useFileExplorerStore((s) => s.closeFile);
  const toggleDiffView = useFileExplorerStore((s) => s.toggleDiffView);

  return (
    <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-border bg-card/80">
      {/* Chat tab – always first */}
      <button
        type="button"
        className={cn(
          "flex shrink-0 items-center gap-1.5 border-r border-border/60 px-3 text-xs transition-colors",
          activeFilePath === null
            ? "bg-background text-foreground"
            : "bg-card/50 text-muted-foreground hover:bg-card hover:text-foreground",
        )}
        onClick={() => setActiveFile(null)}
      >
        <MessageSquareIcon className="size-3.5" />
        <span>Chat</span>
      </button>

      {/* File tabs */}
      {openFiles.map((file) => (
        <FileTab
          key={`${file.cwd}:${file.relativePath}`}
          file={file}
          isActive={activeFilePath === file.relativePath}
          showingDiff={file.relativePath in diffViewPaths}
          onActivate={setActiveFile}
          onClose={closeFile}
          onToggleDiff={toggleDiffView}
        />
      ))}
    </div>
  );
}
