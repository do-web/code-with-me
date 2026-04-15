import { ChevronRightIcon, FolderIcon, FolderOpenIcon, RefreshCwIcon, XIcon } from "lucide-react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "~/lib/utils";
import { useFileExplorerStore } from "../fileExplorerStore";
import { directoryListingQueryOptions, fileExplorerQueryKeys } from "../lib/fileExplorerReactQuery";
import { gitStatusQueryOptions } from "../lib/gitReactQuery";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";
import { ScrollArea } from "./ui/scroll-area";
import { ensureNativeApi } from "../nativeApi";
import { toastManager } from "./ui/toast";
import { Spinner } from "./ui/spinner";

// ── Git change tracking context ──────────────────────────────────────

interface GitChangeInfo {
  insertions: number;
  deletions: number;
}

const EMPTY_CHANGES = new Map<string, GitChangeInfo>();

/** Set of changed file paths + directories containing changes, fetched once at panel level */
const GitChangesContext = createContext<{
  changedFiles: Map<string, GitChangeInfo>;
  changedDirs: Set<string>;
}>({ changedFiles: EMPTY_CHANGES, changedDirs: new Set() });

function useGitChanges(cwd: string) {
  const { data: gitStatus } = useQuery({
    ...gitStatusQueryOptions(cwd),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });

  return useMemo(() => {
    const changedFiles = new Map<string, GitChangeInfo>();
    const changedDirs = new Set<string>();

    for (const file of gitStatus?.workingTree.files ?? []) {
      changedFiles.set(file.path, {
        insertions: file.insertions,
        deletions: file.deletions,
      });
      // Mark all parent directories as containing changes
      const segments = file.path.split("/");
      for (let i = 1; i < segments.length; i++) {
        changedDirs.add(segments.slice(0, i).join("/"));
      }
    }

    return { changedFiles, changedDirs };
  }, [gitStatus]);
}

function resolveTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function basenameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

// ── Directory node (lazy-loaded children) ────────────────────────────

const DirectoryNode = memo(function DirectoryNode({
  cwd,
  dirPath,
  depth,
}: {
  cwd: string;
  dirPath: string;
  depth: number;
}) {
  const expanded = useFileExplorerStore((s) => !!s.expandedDirsByCwd[cwd]?.[dirPath]);
  const toggleDirectory = useFileExplorerStore((s) => s.toggleDirectory);
  const { changedDirs } = useContext(GitChangesContext);
  const hasChanges = changedDirs.has(dirPath);
  const leftPadding = 8 + depth * 14;

  // Only fetch when expanded
  const { data, isLoading } = useQuery({
    ...directoryListingQueryOptions(cwd, dirPath),
    enabled: expanded,
  });

  return (
    <div>
      <button
        type="button"
        className="group flex w-full items-center gap-1.5 rounded-sm py-1 pr-2 text-left hover:bg-accent/60"
        style={{ paddingLeft: `${leftPadding}px` }}
        onClick={() => toggleDirectory(cwd, dirPath)}
      >
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/70 transition-transform",
            expanded && "rotate-90",
          )}
        />
        {expanded ? (
          <FolderOpenIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
        ) : (
          <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
        )}
        <span
          className={cn(
            "truncate font-mono text-[11px] group-hover:text-foreground/90",
            hasChanges ? "text-sky-600 dark:text-sky-400" : "text-muted-foreground/90",
          )}
        >
          {basenameOf(dirPath)}
        </span>
        {isLoading && expanded && <Spinner className="ml-auto size-3" />}
      </button>
      {expanded && data && (
        <div>
          {data.entries.map((entry) =>
            entry.kind === "directory" ? (
              <DirectoryNode key={entry.path} cwd={cwd} dirPath={entry.path} depth={depth + 1} />
            ) : (
              <FileNode key={entry.path} cwd={cwd} relativePath={entry.path} depth={depth + 1} />
            ),
          )}
        </div>
      )}
    </div>
  );
});

// ── File node ────────────────────────────────────────────────────────

const FileNode = memo(function FileNode({
  cwd,
  relativePath,
  depth,
}: {
  cwd: string;
  relativePath: string;
  depth: number;
}) {
  const openFile = useFileExplorerStore((s) => s.openFile);
  const activeFilePath = useFileExplorerStore((s) => s.activeFilePath);
  const { changedFiles } = useContext(GitChangesContext);
  const changeInfo = changedFiles.get(relativePath);
  const isActive = activeFilePath === relativePath;
  const leftPadding = 8 + depth * 14;
  const [loading, setLoading] = useState(false);

  const handleClick = useCallback(async () => {
    // If already open, just activate
    const state = useFileExplorerStore.getState();
    const alreadyOpen = state.openFiles.some(
      (f) => f.relativePath === relativePath && f.cwd === cwd,
    );
    if (alreadyOpen) {
      openFile(cwd, relativePath);
      return;
    }

    // Load file content
    setLoading(true);
    try {
      const api = ensureNativeApi();
      await api.projects.readFile({ cwd, relativePath });
      openFile(cwd, relativePath);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to open file",
        description: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setLoading(false);
    }
  }, [cwd, openFile, relativePath]);

  return (
    <button
      type="button"
      className={cn(
        "group flex w-full items-center gap-1.5 rounded-sm py-1 pr-2 text-left hover:bg-accent/60",
        isActive && "bg-accent/80",
      )}
      style={{ paddingLeft: `${leftPadding + 18}px` }}
      onClick={handleClick}
      disabled={loading}
    >
      <VscodeEntryIcon
        pathValue={relativePath}
        kind="file"
        theme={resolveTheme()}
        className="size-3.5 shrink-0"
      />
      <span
        className={cn(
          "truncate font-mono text-[11px] group-hover:text-foreground",
          changeInfo ? "text-sky-600 dark:text-sky-400" : "text-foreground/80",
        )}
      >
        {basenameOf(relativePath)}
      </span>
      {changeInfo && (
        <span className="ml-auto flex shrink-0 gap-0.5 font-mono text-[10px] tabular-nums">
          {changeInfo.insertions > 0 && (
            <span className="text-emerald-600 dark:text-emerald-400">+{changeInfo.insertions}</span>
          )}
          {changeInfo.deletions > 0 && (
            <span className="text-red-500 dark:text-red-400">-{changeInfo.deletions}</span>
          )}
        </span>
      )}
      {loading && <Spinner className="ml-auto size-3" />}
    </button>
  );
});

// ── Root directory listing ───────────────────────────────────────────

const RootDirectoryListing = memo(function RootDirectoryListing({ cwd }: { cwd: string }) {
  const { data, isLoading, error } = useQuery(directoryListingQueryOptions(cwd));
  const gitChanges = useGitChanges(cwd);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Spinner className="size-5" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-3 py-4 text-xs text-red-500">
        Failed to load directory: {error.message}
      </div>
    );
  }

  if (!data || data.entries.length === 0) {
    return <div className="px-3 py-4 text-xs text-muted-foreground/60">Empty directory</div>;
  }

  return (
    <GitChangesContext value={gitChanges}>
      <div className="py-1">
        {data.entries.map((entry) =>
          entry.kind === "directory" ? (
            <DirectoryNode key={entry.path} cwd={cwd} dirPath={entry.path} depth={0} />
          ) : (
            <FileNode key={entry.path} cwd={cwd} relativePath={entry.path} depth={0} />
          ),
        )}
      </div>
    </GitChangesContext>
  );
});

// ── Resizable panel ──────────────────────────────────────────────────

const MIN_WIDTH = 192;
const MAX_WIDTH_RATIO = 0.35;
const DEFAULT_WIDTH = 280;
const STORAGE_KEY = "file_explorer_width";

function readPersistedWidth(): number {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = Number.parseInt(stored, 10);
      if (Number.isFinite(parsed) && parsed >= MIN_WIDTH) return parsed;
    }
  } catch {
    // ignore
  }
  return DEFAULT_WIDTH;
}

export function FileExplorerPanel({ cwd, onClose }: { cwd: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [width, setWidth] = useState(readPersistedWidth);
  const widthRef = useRef(width);
  widthRef.current = width;

  const resizeStateRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);

  const handleResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: widthRef.current,
    };
  }, []);

  const handleResizePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const rs = resizeStateRef.current;
    if (!rs || rs.pointerId !== event.pointerId) return;
    const maxWidth = window.innerWidth * MAX_WIDTH_RATIO;
    const nextWidth = Math.max(
      MIN_WIDTH,
      Math.min(maxWidth, rs.startWidth + (event.clientX - rs.startX)),
    );
    setWidth(nextWidth);
  }, []);

  const handleResizePointerEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const rs = resizeStateRef.current;
    if (!rs || rs.pointerId !== event.pointerId) return;
    resizeStateRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    try {
      localStorage.setItem(STORAGE_KEY, String(Math.round(widthRef.current)));
    } catch {
      // ignore
    }
  }, []);

  const projectName = cwd.split(/[/\\]/).findLast((s) => s.length > 0) ?? cwd;

  const handleRefresh = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: fileExplorerQueryKeys.all,
    });
  }, [queryClient]);

  return (
    <div className="relative flex h-dvh shrink-0" style={{ width: `${width}px` }}>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden border-r border-border bg-card">
        {/* Header */}
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/80 px-2">
          <FolderOpenIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
          <span className="flex-1 truncate text-xs font-medium text-foreground/80">
            {projectName}
          </span>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground/60 hover:bg-secondary hover:text-foreground"
            onClick={handleRefresh}
            title="Refresh"
          >
            <RefreshCwIcon className="size-3" />
          </button>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground/60 hover:bg-secondary hover:text-foreground"
            onClick={onClose}
            title="Close file explorer"
          >
            <XIcon className="size-3" />
          </button>
        </div>

        {/* Tree */}
        <ScrollArea className="flex-1">
          <RootDirectoryListing cwd={cwd} />
        </ScrollArea>
      </div>

      {/* Resize handle */}
      <div
        className="absolute top-0 right-0 bottom-0 z-10 w-1 cursor-col-resize hover:bg-primary/20 active:bg-primary/30"
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerEnd}
        onPointerCancel={handleResizePointerEnd}
      />
    </div>
  );
}
