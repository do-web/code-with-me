import { BookOpenIcon, DiffIcon, MessageSquareIcon, XIcon } from "lucide-react";
import { memo, useCallback, useMemo, type MouseEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "~/lib/utils";
import { useFileExplorerStore, type OpenFileEntry } from "../fileExplorerStore";
import { gitStatusQueryOptions } from "../lib/gitReactQuery";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";

function basenameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

function resolveTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function isMarkdownFile(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".mdx");
}

const FileTab = memo(function FileTab({
  file,
  isActive,
  showingDiff,
  showingMarkdown,
  hasGitChanges,
  onActivate,
  onClose,
  onToggleDiff,
  onToggleMarkdown,
}: {
  file: OpenFileEntry;
  isActive: boolean;
  showingDiff: boolean;
  showingMarkdown: boolean;
  hasGitChanges: boolean;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
  onToggleDiff: (path: string) => void;
  onToggleMarkdown: (path: string) => void;
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

  const handleToggleMarkdown = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      onToggleMarkdown(file.relativePath);
    },
    [file.relativePath, onToggleMarkdown],
  );

  const isMd = isMarkdownFile(file.relativePath);

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
      {/* Toggles – visible when tab is active */}
      {isActive && (
        <>
          {/* Diff toggle – only when file has uncommitted git changes */}
          {hasGitChanges && (
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
          {/* Markdown preview toggle – only for .md/.mdx */}
          {isMd && (
            <span
              role="button"
              tabIndex={-1}
              title={showingMarkdown ? "Show editor" : "Preview markdown"}
              className={cn(
                "shrink-0 rounded p-0.5 transition-colors",
                showingMarkdown
                  ? "bg-violet-500/20 text-violet-600 dark:text-violet-400"
                  : "text-muted-foreground/60 hover:bg-secondary hover:text-foreground",
              )}
              onClick={handleToggleMarkdown}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.stopPropagation();
                  onToggleMarkdown(file.relativePath);
                }
              }}
            >
              <BookOpenIcon className="size-3" />
            </span>
          )}
        </>
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
  const markdownViewPaths = useFileExplorerStore((s) => s.markdownViewPaths);
  const setActiveFile = useFileExplorerStore((s) => s.setActiveFile);
  const closeFile = useFileExplorerStore((s) => s.closeFile);
  const toggleDiffView = useFileExplorerStore((s) => s.toggleDiffView);
  const toggleMarkdownView = useFileExplorerStore((s) => s.toggleMarkdownView);

  // Get git status for each unique cwd among open files
  const cwds = useMemo(() => [...new Set(openFiles.map((f) => f.cwd))], [openFiles]);
  const firstCwd = cwds[0] ?? null;
  const { data: gitStatus } = useQuery({
    ...gitStatusQueryOptions(firstCwd),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });

  // Build set of changed file paths
  const changedPaths = useMemo(() => {
    const paths = new Set<string>();
    for (const file of gitStatus?.workingTree.files ?? []) {
      paths.add(file.path);
    }
    return paths;
  }, [gitStatus]);

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
          showingMarkdown={file.relativePath in markdownViewPaths}
          hasGitChanges={changedPaths.has(file.relativePath)}
          onActivate={setActiveFile}
          onClose={closeFile}
          onToggleDiff={toggleDiffView}
          onToggleMarkdown={toggleMarkdownView}
        />
      ))}
    </div>
  );
}
