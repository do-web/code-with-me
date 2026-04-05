import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRightIcon, Undo2Icon } from "lucide-react";
import { useParams } from "@tanstack/react-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ThreadId, type GitStatusResult } from "@codewithme/contracts";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { DiffStatLabel } from "~/components/chat/DiffStatLabel";
import { VscodeEntryIcon } from "~/components/chat/VscodeEntryIcon";
import { toastManager } from "~/components/ui/toast";
import type { DiffPanelMode } from "./DiffPanelShell";
import {
  gitDiscardChangesMutationOptions,
  gitFileDiffQueryOptions,
  gitStatusQueryOptions,
} from "~/lib/gitReactQuery";
import { buildPatchCacheKey, resolveDiffThemeName } from "~/lib/diffRendering";
import { useTheme } from "~/hooks/useTheme";
import { useStore } from "~/store";
import { cn } from "~/lib/utils";

/**
 * Static CSS overrides for inline diff rendering, matching the DiffPanel theme.
 * Contains only CSS variable declarations — no user-controlled content.
 */
const DIFF_CSS = `
[data-slot=changes-panel] [data-diffs-header],
[data-slot=changes-panel] [data-diff],
[data-slot=changes-panel] [data-file],
[data-slot=changes-panel] [data-error-wrapper],
[data-slot=changes-panel] [data-virtualizer-buffer] {
  --diffs-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-light-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-dark-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;
  --diffs-bg-context-override: color-mix(in srgb, var(--background) 97%, var(--foreground));
  --diffs-bg-hover-override: color-mix(in srgb, var(--background) 94%, var(--foreground));
  --diffs-bg-separator-override: color-mix(in srgb, var(--background) 95%, var(--foreground));
  --diffs-bg-buffer-override: color-mix(in srgb, var(--background) 90%, var(--foreground));
  --diffs-bg-addition-override: color-mix(in srgb, var(--background) 92%, var(--success));
  --diffs-bg-addition-number-override: color-mix(in srgb, var(--background) 88%, var(--success));
  --diffs-bg-addition-hover-override: color-mix(in srgb, var(--background) 85%, var(--success));
  --diffs-bg-addition-emphasis-override: color-mix(in srgb, var(--background) 80%, var(--success));
  --diffs-bg-deletion-override: color-mix(in srgb, var(--background) 92%, var(--destructive));
  --diffs-bg-deletion-number-override: color-mix(in srgb, var(--background) 88%, var(--destructive));
  --diffs-bg-deletion-hover-override: color-mix(in srgb, var(--background) 85%, var(--destructive));
  --diffs-bg-deletion-emphasis-override: color-mix(in srgb, var(--background) 80%, var(--destructive));
  background-color: var(--diffs-bg) !important;
}
[data-slot=changes-panel] [data-file-info] {
  display: none !important;
}
`;

/** Inject DIFF_CSS once into the document head. */
function useDiffStylesheet() {
  const injectedRef = useRef(false);
  useEffect(() => {
    if (injectedRef.current) return;
    injectedRef.current = true;
    const id = "uncommitted-changes-panel-diff-css";
    if (document.getElementById(id)) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent = DIFF_CSS;
    document.head.appendChild(style);
  }, []);
}

export default function UncommittedChangesPanel({ mode }: { mode: DiffPanelMode }) {
  const routeThreadId = useParams({
    strict: false,
    select: (params: Record<string, string | undefined>) =>
      params.threadId ? ThreadId.makeUnsafe(params.threadId) : null,
  });
  const activeThread = useStore((store) =>
    routeThreadId ? store.threads.find((thread) => thread.id === routeThreadId) : undefined,
  );
  const activeProjectId = activeThread?.projectId ?? null;
  const activeProject = useStore((store) =>
    activeProjectId ? store.projects.find((project) => project.id === activeProjectId) : undefined,
  );
  const gitCwd = activeThread?.worktreePath ?? activeProject?.cwd ?? null;

  const { data: gitStatus = null } = useQuery(gitStatusQueryOptions(gitCwd));
  const files = gitStatus?.workingTree.files ?? [];
  const queryClient = useQueryClient();

  const discardMutation = useMutation(
    gitDiscardChangesMutationOptions({ cwd: gitCwd, queryClient }),
  );
  const [discardTarget, setDiscardTarget] = useState<string | null>(null);

  const confirmDiscard = useCallback(
    async (filePath: string) => {
      try {
        await discardMutation.mutateAsync([filePath]);
        toastManager.add({ type: "success", title: "Changes discarded", description: filePath });
      } catch {
        toastManager.add({
          type: "error",
          title: "Failed to discard changes",
          description: filePath,
        });
      }
      setDiscardTarget(null);
    },
    [discardMutation],
  );

  const confirmDiscardAll = useCallback(async () => {
    const allPaths = files.map((f) => f.path);
    if (allPaths.length === 0) return;
    try {
      await discardMutation.mutateAsync(allPaths);
      toastManager.add({
        type: "success",
        title: "All changes discarded",
        description: `${allPaths.length} file(s)`,
      });
    } catch {
      toastManager.add({ type: "error", title: "Failed to discard changes" });
    }
    setDiscardTarget(null);
  }, [discardMutation, files]);

  const totalInsertions = gitStatus?.workingTree.insertions ?? 0;
  const totalDeletions = gitStatus?.workingTree.deletions ?? 0;

  return (
    <div className="flex h-full min-w-0 flex-col bg-background" data-slot="changes-panel">
      {/* Header */}
      <div className="border-b border-border">
        <div className="flex items-center justify-between gap-2 px-4 h-12">
          <div className="flex items-center gap-2 min-w-0">
            <h3 className="text-sm font-medium truncate">Uncommitted Changes</h3>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {files.length} file(s)
            </span>
            {(totalInsertions > 0 || totalDeletions > 0) && (
              <span className="shrink-0 font-mono text-[10px] tabular-nums">
                <DiffStatLabel additions={totalInsertions} deletions={totalDeletions} />
              </span>
            )}
          </div>
          {files.length > 0 && (
            <Button
              variant="ghost"
              size="xs"
              className="shrink-0 text-destructive"
              onClick={() => setDiscardTarget("__all__")}
              disabled={discardMutation.isPending}
            >
              Discard all
            </Button>
          )}
        </div>
      </div>

      {/* File list */}
      <ScrollArea className="min-h-0 flex-1">
        {files.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">No uncommitted changes.</p>
        ) : (
          <div className="space-y-0.5 p-2">
            {files.map((file) => (
              <FileChangeItem
                key={file.path}
                file={file}
                gitCwd={gitCwd}
                onRequestDiscard={setDiscardTarget}
                isDiscarding={discardMutation.isPending}
              />
            ))}
          </div>
        )}
      </ScrollArea>

      {/* Discard confirmation dialog */}
      <AlertDialog
        open={discardTarget !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setDiscardTarget(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard changes?</AlertDialogTitle>
            <AlertDialogDescription>
              {discardTarget === "__all__"
                ? `This will permanently discard all uncommitted changes in ${files.length} file(s). This action cannot be undone.`
                : `This will permanently discard all changes to "${discardTarget}". This action cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              size="sm"
              disabled={discardMutation.isPending}
              onClick={() => {
                if (discardTarget === "__all__") {
                  void confirmDiscardAll();
                } else if (discardTarget) {
                  void confirmDiscard(discardTarget);
                }
              }}
            >
              {discardMutation.isPending ? "Discarding..." : "Discard"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

// --- Sub-components ---

type WorkingTreeFile = GitStatusResult["workingTree"]["files"][number];

const FileChangeItem = memo(function FileChangeItem({
  file,
  gitCwd,
  onRequestDiscard,
  isDiscarding,
}: {
  file: WorkingTreeFile;
  gitCwd: string | null;
  onRequestDiscard: (filePath: string) => void;
  isDiscarding: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const { resolvedTheme } = useTheme();

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <div className="group flex items-center gap-1 rounded-md pr-1 hover:bg-accent/50">
        <CollapsibleTrigger className="flex flex-1 items-center gap-1.5 overflow-hidden py-1.5 pl-2">
          <ChevronRightIcon
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground/70 transition-transform",
              expanded && "rotate-90",
            )}
          />
          <VscodeEntryIcon
            pathValue={file.path}
            kind="file"
            theme={resolvedTheme}
            className="size-3.5 shrink-0"
          />
          <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground/80 group-hover:text-foreground/90">
            {file.path}
          </span>
          {(file.insertions > 0 || file.deletions > 0) && (
            <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums">
              <DiffStatLabel additions={file.insertions} deletions={file.deletions} />
            </span>
          )}
        </CollapsibleTrigger>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                className="shrink-0 opacity-0 group-hover:opacity-100 text-destructive"
                disabled={isDiscarding}
                onClick={(e) => {
                  e.stopPropagation();
                  onRequestDiscard(file.path);
                }}
              />
            }
          >
            <Undo2Icon className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="left">Discard changes</TooltipPopup>
        </Tooltip>
      </div>
      <CollapsiblePanel>
        {expanded && <FileDiffViewer gitCwd={gitCwd} filePath={file.path} />}
      </CollapsiblePanel>
    </Collapsible>
  );
});

const FileDiffViewer = memo(function FileDiffViewer({
  gitCwd,
  filePath,
}: {
  gitCwd: string | null;
  filePath: string;
}) {
  useDiffStylesheet();

  const { data, isLoading, error } = useQuery(gitFileDiffQueryOptions({ cwd: gitCwd, filePath }));
  const { resolvedTheme } = useTheme();
  const themeName = resolveDiffThemeName(resolvedTheme);

  const renderablePatch = useMemo(() => {
    if (!data?.diff) return null;
    const normalizedPatch = data.diff.trim();
    if (normalizedPatch.length === 0) return null;
    try {
      const parsedPatches = parsePatchFiles(
        normalizedPatch,
        buildPatchCacheKey(normalizedPatch, "uncommitted-changes"),
      );
      const files = parsedPatches.flatMap((p) => p.files);
      if (files.length > 0) return { kind: "files" as const, files };
      return { kind: "raw" as const, text: normalizedPatch };
    } catch {
      return { kind: "raw" as const, text: normalizedPatch };
    }
  }, [data?.diff]);

  if (isLoading) {
    return <div className="px-4 py-3 text-xs text-muted-foreground">Loading diff...</div>;
  }

  if (error) {
    return (
      <div className="px-4 py-3 text-xs text-destructive">Failed to load diff: {error.message}</div>
    );
  }

  if (data?.isBinary) {
    return (
      <div className="px-4 py-3 text-xs text-muted-foreground">
        Binary file — no diff available.
      </div>
    );
  }

  if (!renderablePatch) {
    return <div className="px-4 py-3 text-xs text-muted-foreground">No changes to display.</div>;
  }

  if (renderablePatch.kind === "raw") {
    return (
      <pre className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
        {renderablePatch.text}
      </pre>
    );
  }

  return (
    <div className="max-h-80 overflow-auto rounded-md border">
      {renderablePatch.files.map((fileDiff) => (
        <FileDiff
          key={fileDiff.cacheKey ?? fileDiff.name}
          fileDiff={fileDiff}
          options={{
            diffStyle: "unified",
            lineDiffType: "none",
            overflow: "wrap",
            theme: themeName,
            themeType: resolvedTheme as "light" | "dark",
            unsafeCSS: DIFF_CSS,
          }}
        />
      ))}
      {data?.truncated && (
        <div className="border-t bg-muted/40 px-3 py-2 text-center text-xs text-muted-foreground">
          Diff truncated — file is too large.
        </div>
      )}
    </div>
  );
});
