import { ThreadId } from "@codewithme/contracts";
import { createFileRoute, retainSearchParams, useNavigate } from "@tanstack/react-router";
import { Suspense, lazy, type ReactNode, useCallback, useEffect, useState } from "react";

import ChatView from "../components/ChatView";
import { EditorTabBar } from "../components/EditorTabBar";
import { EditorView } from "../components/EditorView";
import { FileExplorerPanel } from "../components/FileExplorerPanel";
import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import { useFileExplorerStore } from "../fileExplorerStore";
import { useThreadById, useProjectById } from "../storeSelectors";
import { cn } from "~/lib/utils";
import {
  DiffPanelHeaderSkeleton,
  DiffPanelLoadingState,
  DiffPanelShell,
  type DiffPanelMode,
} from "../components/DiffPanelShell";
import { useComposerDraftStore } from "../composerDraftStore";
import {
  type DiffRouteSearch,
  parseDiffRouteSearch,
  stripDiffSearchParams,
} from "../diffRouteSearch";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useStore } from "../store";
import { Sheet, SheetPopup } from "../components/ui/sheet";
import { Sidebar, SidebarInset, SidebarProvider, SidebarRail } from "~/components/ui/sidebar";

const DiffPanel = lazy(() => import("../components/DiffPanel"));
const UncommittedChangesPanel = lazy(() => import("../components/UncommittedChangesPanel"));
const DIFF_INLINE_LAYOUT_MEDIA_QUERY = "(max-width: 1180px)";
const DIFF_INLINE_SIDEBAR_WIDTH_STORAGE_KEY = "chat_diff_sidebar_width";
const DIFF_INLINE_DEFAULT_WIDTH = "clamp(28rem,48vw,44rem)";
const DIFF_INLINE_SIDEBAR_MIN_WIDTH = 26 * 16;
const CHANGES_INLINE_SIDEBAR_WIDTH_STORAGE_KEY = "chat_changes_sidebar_width";
const CHANGES_INLINE_DEFAULT_WIDTH = "clamp(22rem,36vw,34rem)";
const CHANGES_INLINE_SIDEBAR_MIN_WIDTH = 20 * 16;
const COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX = 208;

const DiffPanelSheet = (props: {
  children: ReactNode;
  diffOpen: boolean;
  onCloseDiff: () => void;
}) => {
  return (
    <Sheet
      open={props.diffOpen}
      onOpenChange={(open) => {
        if (!open) {
          props.onCloseDiff();
        }
      }}
    >
      <SheetPopup
        side="right"
        showCloseButton={false}
        keepMounted
        className="w-[min(88vw,820px)] max-w-[820px] p-0"
      >
        {props.children}
      </SheetPopup>
    </Sheet>
  );
};

const ChangesPanelSheet = (props: {
  children: ReactNode;
  changesOpen: boolean;
  onCloseChanges: () => void;
}) => {
  return (
    <Sheet
      open={props.changesOpen}
      onOpenChange={(open) => {
        if (!open) {
          props.onCloseChanges();
        }
      }}
    >
      <SheetPopup
        side="right"
        showCloseButton={false}
        keepMounted
        className="w-[min(88vw,640px)] max-w-[640px] p-0"
      >
        {props.children}
      </SheetPopup>
    </Sheet>
  );
};

const LazyUncommittedChangesPanel = (props: { mode: DiffPanelMode }) => {
  return (
    <Suspense
      fallback={
        <DiffPanelShell mode={props.mode} header={<DiffPanelHeaderSkeleton />}>
          <DiffPanelLoadingState label="Loading changes panel..." />
        </DiffPanelShell>
      }
    >
      <UncommittedChangesPanel mode={props.mode} />
    </Suspense>
  );
};

const ChangesPanelInlineSidebar = (props: {
  changesOpen: boolean;
  onCloseChanges: () => void;
  onOpenChanges: () => void;
  renderContent: boolean;
}) => {
  const { changesOpen, onCloseChanges, onOpenChanges, renderContent } = props;
  const onOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        onOpenChanges();
        return;
      }
      onCloseChanges();
    },
    [onCloseChanges, onOpenChanges],
  );

  return (
    <SidebarProvider
      defaultOpen={false}
      open={changesOpen}
      onOpenChange={onOpenChange}
      className="w-auto min-h-0 flex-none bg-transparent"
      style={{ "--sidebar-width": CHANGES_INLINE_DEFAULT_WIDTH } as React.CSSProperties}
    >
      <Sidebar
        side="right"
        collapsible="offcanvas"
        className="border-l border-border bg-card text-foreground"
        resizable={{
          minWidth: CHANGES_INLINE_SIDEBAR_MIN_WIDTH,
          storageKey: CHANGES_INLINE_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        {renderContent ? <LazyUncommittedChangesPanel mode="sidebar" /> : null}
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>
  );
};

const DiffLoadingFallback = (props: { mode: DiffPanelMode }) => {
  return (
    <DiffPanelShell mode={props.mode} header={<DiffPanelHeaderSkeleton />}>
      <DiffPanelLoadingState label="Loading diff viewer..." />
    </DiffPanelShell>
  );
};

const LazyDiffPanel = (props: { mode: DiffPanelMode }) => {
  return (
    <DiffWorkerPoolProvider>
      <Suspense fallback={<DiffLoadingFallback mode={props.mode} />}>
        <DiffPanel mode={props.mode} />
      </Suspense>
    </DiffWorkerPoolProvider>
  );
};

const DiffPanelInlineSidebar = (props: {
  diffOpen: boolean;
  onCloseDiff: () => void;
  onOpenDiff: () => void;
  renderDiffContent: boolean;
}) => {
  const { diffOpen, onCloseDiff, onOpenDiff, renderDiffContent } = props;
  const onOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        onOpenDiff();
        return;
      }
      onCloseDiff();
    },
    [onCloseDiff, onOpenDiff],
  );
  const shouldAcceptInlineSidebarWidth = useCallback(
    ({ nextWidth, wrapper }: { nextWidth: number; wrapper: HTMLElement }) => {
      const composerForm = document.querySelector<HTMLElement>("[data-chat-composer-form='true']");
      if (!composerForm) return true;
      const composerViewport = composerForm.parentElement;
      if (!composerViewport) return true;
      const previousSidebarWidth = wrapper.style.getPropertyValue("--sidebar-width");
      wrapper.style.setProperty("--sidebar-width", `${nextWidth}px`);

      const viewportStyle = window.getComputedStyle(composerViewport);
      const viewportPaddingLeft = Number.parseFloat(viewportStyle.paddingLeft) || 0;
      const viewportPaddingRight = Number.parseFloat(viewportStyle.paddingRight) || 0;
      const viewportContentWidth = Math.max(
        0,
        composerViewport.clientWidth - viewportPaddingLeft - viewportPaddingRight,
      );
      const formRect = composerForm.getBoundingClientRect();
      const composerFooter = composerForm.querySelector<HTMLElement>(
        "[data-chat-composer-footer='true']",
      );
      const composerRightActions = composerForm.querySelector<HTMLElement>(
        "[data-chat-composer-actions='right']",
      );
      const composerRightActionsWidth = composerRightActions?.getBoundingClientRect().width ?? 0;
      const composerFooterGap = composerFooter
        ? Number.parseFloat(window.getComputedStyle(composerFooter).columnGap) ||
          Number.parseFloat(window.getComputedStyle(composerFooter).gap) ||
          0
        : 0;
      const minimumComposerWidth =
        COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX + composerRightActionsWidth + composerFooterGap;
      const hasComposerOverflow = composerForm.scrollWidth > composerForm.clientWidth + 0.5;
      const overflowsViewport = formRect.width > viewportContentWidth + 0.5;
      const violatesMinimumComposerWidth = composerForm.clientWidth + 0.5 < minimumComposerWidth;

      if (previousSidebarWidth.length > 0) {
        wrapper.style.setProperty("--sidebar-width", previousSidebarWidth);
      } else {
        wrapper.style.removeProperty("--sidebar-width");
      }

      return !hasComposerOverflow && !overflowsViewport && !violatesMinimumComposerWidth;
    },
    [],
  );

  return (
    <SidebarProvider
      defaultOpen={false}
      open={diffOpen}
      onOpenChange={onOpenChange}
      className="w-auto min-h-0 flex-none bg-transparent"
      style={{ "--sidebar-width": DIFF_INLINE_DEFAULT_WIDTH } as React.CSSProperties}
    >
      <Sidebar
        side="right"
        collapsible="offcanvas"
        className="border-l border-border bg-card text-foreground"
        resizable={{
          minWidth: DIFF_INLINE_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: shouldAcceptInlineSidebarWidth,
          storageKey: DIFF_INLINE_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        {renderDiffContent ? <LazyDiffPanel mode="sidebar" /> : null}
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>
  );
};

function ChatThreadRouteView() {
  const bootstrapComplete = useStore((store) => store.bootstrapComplete);
  const navigate = useNavigate();
  const threadId = Route.useParams({
    select: (params) => ThreadId.makeUnsafe(params.threadId),
  });
  const search = Route.useSearch();
  const threadExists = useStore((store) => store.threads.some((thread) => thread.id === threadId));
  const draftThreadExists = useComposerDraftStore((store) =>
    Object.hasOwn(store.draftThreadsByThreadId, threadId),
  );
  const routeThreadExists = threadExists || draftThreadExists;
  const diffOpen = search.diff === "1";
  const changesOpen = search.changes === "1";
  const shouldUseDiffSheet = useMediaQuery(DIFF_INLINE_LAYOUT_MEDIA_QUERY);
  // TanStack Router keeps active route components mounted across param-only navigations
  // unless remountDeps are configured, so this stays warm across thread switches.
  const [hasOpenedDiff, setHasOpenedDiff] = useState(diffOpen);
  const [hasOpenedChanges, setHasOpenedChanges] = useState(changesOpen);
  const closeDiff = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId },
      search: { diff: undefined },
    });
  }, [navigate, threadId]);
  const openDiff = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId },
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        // Explicitly unset `changes` so retainSearchParams middleware doesn't re-add it
        return { ...rest, diff: "1", changes: undefined };
      },
    });
  }, [navigate, threadId]);
  const closeChanges = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId },
      search: { changes: undefined },
    });
  }, [navigate, threadId]);
  const openChanges = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId },
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        // Explicitly unset `diff` so retainSearchParams middleware doesn't re-add it
        return { ...rest, changes: "1", diff: undefined };
      },
    });
  }, [navigate, threadId]);

  useEffect(() => {
    if (diffOpen) {
      setHasOpenedDiff(true);
    }
  }, [diffOpen]);

  useEffect(() => {
    if (changesOpen) {
      setHasOpenedChanges(true);
    }
  }, [changesOpen]);

  useEffect(() => {
    if (!bootstrapComplete) {
      return;
    }

    if (!routeThreadExists) {
      void navigate({ to: "/", replace: true });
      return;
    }
  }, [bootstrapComplete, navigate, routeThreadExists, threadId]);

  if (!bootstrapComplete || !routeThreadExists) {
    return null;
  }

  const shouldRenderDiffContent = diffOpen || hasOpenedDiff;
  const shouldRenderChangesContent = changesOpen || hasOpenedChanges;

  // Derive CWD from active thread's project – explorer follows project switches
  const thread = useThreadById(threadId);
  const project = useProjectById(thread?.projectId);
  const activeProjectCwd = project?.cwd ?? null;

  const explorerOpen = useFileExplorerStore((s) => s.explorerOpen);
  const closeExplorer = useFileExplorerStore((s) => s.closeExplorer);
  const openFiles = useFileExplorerStore((s) => s.openFiles);
  const activeFilePath = useFileExplorerStore((s) => s.activeFilePath);
  const hasOpenFiles = openFiles.length > 0;

  const fileExplorerPanel =
    explorerOpen && activeProjectCwd ? (
      <FileExplorerPanel cwd={activeProjectCwd} onClose={closeExplorer} />
    ) : null;

  const mainContent = (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      {hasOpenFiles && <EditorTabBar />}
      {/* ChatView stays mounted – CSS hidden preserves scroll, drafts, streams */}
      <div className={cn("flex min-h-0 flex-1 flex-col", activeFilePath && "hidden")}>
        <ChatView threadId={threadId} />
      </div>
      {activeFilePath && <EditorView relativePath={activeFilePath} />}
    </SidebarInset>
  );

  if (!shouldUseDiffSheet) {
    return (
      <>
        {fileExplorerPanel}
        {mainContent}
        <ChangesPanelInlineSidebar
          changesOpen={changesOpen}
          onCloseChanges={closeChanges}
          onOpenChanges={openChanges}
          renderContent={shouldRenderChangesContent}
        />
        <DiffPanelInlineSidebar
          diffOpen={diffOpen}
          onCloseDiff={closeDiff}
          onOpenDiff={openDiff}
          renderDiffContent={shouldRenderDiffContent}
        />
      </>
    );
  }

  return (
    <>
      {fileExplorerPanel}
      {mainContent}
      <ChangesPanelSheet changesOpen={changesOpen} onCloseChanges={closeChanges}>
        {shouldRenderChangesContent ? <LazyUncommittedChangesPanel mode="sheet" /> : null}
      </ChangesPanelSheet>
      <DiffPanelSheet diffOpen={diffOpen} onCloseDiff={closeDiff}>
        {shouldRenderDiffContent ? <LazyDiffPanel mode="sheet" /> : null}
      </DiffPanelSheet>
    </>
  );
}

export const Route = createFileRoute("/_chat/$threadId")({
  validateSearch: (search) => parseDiffRouteSearch(search),
  search: {
    middlewares: [retainSearchParams<DiffRouteSearch>(["diff", "changes"])],
  },
  component: ChatThreadRouteView,
});
