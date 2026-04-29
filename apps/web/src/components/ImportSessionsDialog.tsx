import type { DiscoveredSession, ProviderKind } from "@codewithme/contracts";
import { useNavigate } from "@tanstack/react-router";
import { DownloadIcon, FolderPlusIcon, Loader2Icon, SearchIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useStore } from "../store";
import { getWsRpcClient } from "../wsRpcClient";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { PROVIDER_ICON_BY_PROVIDER, providerIconClassName } from "./chat/providerIcons";
import { cn } from "~/lib/utils";

interface ImportSessionsDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

type ImportState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; sessions: ReadonlyArray<DiscoveredSession> }
  | { status: "error"; message: string };

interface ImportGroup {
  readonly key: string;
  readonly label: string;
  readonly projectId: string | null;
  readonly cwd: string;
  readonly sessions: Array<DiscoveredSession>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formatRelative(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  const deltaMs = Date.now() - parsed;
  const mins = Math.round(deltaMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  return `${months}mo ago`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function providerLabel(provider: ProviderKind): string {
  if (provider === "claudeAgent") return "Claude Code";
  if (provider === "gemini") return "Gemini";
  return "Codex";
}

function matchesQuery(session: DiscoveredSession, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    session.sessionId.toLowerCase().includes(q) ||
    session.cwd.toLowerCase().includes(q) ||
    (session.title ?? "").toLowerCase().includes(q) ||
    providerLabel(session.provider).toLowerCase().includes(q)
  );
}

export function ImportSessionsDialog(props: ImportSessionsDialogProps) {
  const { open, onOpenChange } = props;
  const [state, setState] = useState<ImportState>({ status: "idle" });
  const [importingKey, setImportingKey] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [manualProvider, setManualProvider] = useState<ProviderKind>("claudeAgent");
  const navigate = useNavigate();

  // Select the raw array reference so Zustand's default identity comparison
  // handles re-renders correctly. Deriving any shape here would allocate a
  // new object per render and cause an infinite update loop.
  const rawProjects = useStore((store) => store.projects);
  const projects = useMemo(
    () =>
      rawProjects.map((project) => ({
        id: project.id,
        name: project.name,
        cwd: project.cwd,
      })),
    [rawProjects],
  );

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    setImportError(null);
    void getWsRpcClient()
      .sessionImport.listImportable()
      .then((result) => {
        if (cancelled) return;
        setState({ status: "ready", sessions: result.sessions });
      })
      .catch((error) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setState({ status: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const trimmedQuery = query.trim();

  const filteredSessions = useMemo(() => {
    if (state.status !== "ready") return [] as ReadonlyArray<DiscoveredSession>;
    return state.sessions.filter((session) => matchesQuery(session, trimmedQuery));
  }, [state, trimmedQuery]);

  const groups = useMemo((): Array<ImportGroup> => {
    const byKey = new Map<string, ImportGroup>();
    for (const session of filteredSessions) {
      const matchedProject = projects.find(
        (project) =>
          project.cwd === session.cwd ||
          session.cwd === project.cwd + "/" ||
          session.cwd.startsWith(project.cwd + "/"),
      );
      if (matchedProject) {
        const key = `project:${matchedProject.id}`;
        let group = byKey.get(key);
        if (!group) {
          group = {
            key,
            label: matchedProject.name,
            projectId: matchedProject.id,
            cwd: matchedProject.cwd,
            sessions: [],
          };
          byKey.set(key, group);
        }
        group.sessions.push(session);
      } else {
        const key = `orphan:${session.cwd}`;
        let group = byKey.get(key);
        if (!group) {
          group = {
            key,
            label: "No matching project",
            projectId: null,
            cwd: session.cwd,
            sessions: [],
          };
          byKey.set(key, group);
        }
        group.sessions.push(session);
      }
    }
    return Array.from(byKey.values()).map((group) => ({
      ...group,
      sessions: group.sessions.toSorted((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt)),
    }));
  }, [filteredSessions, projects]);

  const looksLikeSessionId = UUID_PATTERN.test(trimmedQuery);
  const manualMatchSession =
    looksLikeSessionId && state.status === "ready"
      ? state.sessions.find((session) => session.sessionId === trimmedQuery)
      : undefined;
  const showManualImport = looksLikeSessionId && !manualMatchSession && state.status === "ready";

  const handleImport = async (session: DiscoveredSession, projectId: string | null) => {
    const key = `${session.provider}:${session.sessionId}`;
    setImportingKey(key);
    setImportError(null);
    try {
      const client = getWsRpcClient();
      const title = session.title ? session.title.slice(0, 80) : undefined;
      const result = await client.sessionImport.importExternal({
        provider: session.provider,
        sessionId: session.sessionId,
        filePath: session.filePath,
        cwd: session.cwd,
        ...(projectId ? { projectId: projectId as never } : {}),
        ...(title ? { title: title as never } : {}),
      });
      setState((prev) =>
        prev.status === "ready"
          ? {
              status: "ready",
              sessions: prev.sessions.filter(
                (entry) =>
                  !(entry.provider === session.provider && entry.sessionId === session.sessionId),
              ),
            }
          : prev,
      );
      onOpenChange(false);
      await navigate({ to: "/$threadId", params: { threadId: result.threadId } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setImportError(message);
    } finally {
      setImportingKey(null);
    }
  };

  const handleManualImport = async () => {
    const key = `manual:${trimmedQuery}`;
    setImportingKey(key);
    setImportError(null);
    try {
      const client = getWsRpcClient();
      const activeProjectCwd = projects[0]?.cwd ?? "";
      const result = await client.sessionImport.importExternal({
        provider: manualProvider,
        sessionId: trimmedQuery as never,
        filePath: trimmedQuery as never, // adapter will resolve via sessionId for resume
        cwd: (activeProjectCwd || "/") as never,
      });
      onOpenChange(false);
      await navigate({ to: "/$threadId", params: { threadId: result.threadId } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setImportError(message);
    } finally {
      setImportingKey(null);
    }
  };

  const isReady = state.status === "ready";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import external session</DialogTitle>
          <DialogDescription>
            Discovered sessions from Codex, Claude Code and Gemini CLI. Imports are attached to the
            project whose path matches.
          </DialogDescription>
          <div className="relative mt-2">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground/70"
            />
            <Input
              type="search"
              placeholder="Search by title, cwd, provider — or paste a session UUID"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="ps-8"
              disabled={!isReady}
            />
          </div>
        </DialogHeader>
        <DialogPanel className="max-h-[60vh] overflow-y-auto">
          {state.status === "loading" ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground/80">
              <Loader2Icon className="mr-2 size-4 animate-spin" /> Scanning local sessions…
            </div>
          ) : state.status === "error" ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-destructive-foreground text-sm">
              Failed to scan sessions: {state.message}
            </div>
          ) : isReady ? (
            <div className="flex flex-col gap-4">
              {showManualImport ? (
                <div className="rounded-md border border-border/60 bg-muted/20 p-3">
                  <div className="mb-2 text-sm">
                    Session <code className="font-mono text-xs">{trimmedQuery}</code> was not found
                    on disk. Try importing it directly by choosing its provider:
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="inline-flex overflow-hidden rounded-md border border-border">
                      {(["codex", "claudeAgent", "gemini"] as const).map((provider) => {
                        const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[provider];
                        const active = manualProvider === provider;
                        return (
                          <button
                            key={provider}
                            type="button"
                            onClick={() => setManualProvider(provider)}
                            className={cn(
                              "flex items-center gap-1.5 px-3 py-1.5 text-xs transition-colors",
                              active
                                ? "bg-accent text-foreground"
                                : "text-muted-foreground hover:bg-accent/40",
                            )}
                          >
                            <ProviderIcon
                              aria-hidden="true"
                              className={cn(
                                "size-3.5",
                                providerIconClassName(provider, "text-muted-foreground"),
                              )}
                            />
                            {providerLabel(provider)}
                          </button>
                        );
                      })}
                    </div>
                    <Button
                      size="sm"
                      disabled={importingKey === `manual:${trimmedQuery}`}
                      onClick={() => void handleManualImport()}
                    >
                      {importingKey === `manual:${trimmedQuery}` ? (
                        <Loader2Icon className="size-3 animate-spin" />
                      ) : (
                        <DownloadIcon className="size-3" />
                      )}
                      Import by ID
                    </Button>
                  </div>
                </div>
              ) : null}
              {groups.length === 0 && !showManualImport ? (
                <div className="py-10 text-center text-muted-foreground/80 text-sm">
                  {trimmedQuery
                    ? `No sessions matching "${trimmedQuery}".`
                    : "No importable external sessions found."}
                </div>
              ) : null}
              {groups.map((group) => (
                <div key={group.key} className="rounded-md border border-border/60">
                  <div className="flex items-center gap-2 border-b border-border/60 bg-muted/40 px-3 py-2">
                    {group.projectId ? (
                      <span className="font-medium text-sm">{group.label}</span>
                    ) : (
                      <>
                        <FolderPlusIcon className="size-4 text-muted-foreground" />
                        <span className="font-medium text-sm">{group.label}</span>
                      </>
                    )}
                    <span className="text-muted-foreground/70 text-xs">{group.cwd}</span>
                  </div>
                  <ul className="divide-y divide-border/40">
                    {group.sessions.map((session) => {
                      const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[session.provider];
                      const key = `${session.provider}:${session.sessionId}`;
                      const isImporting = importingKey === key;
                      return (
                        <li
                          key={key}
                          className="flex items-center gap-3 px-3 py-2.5 hover:bg-accent/40"
                        >
                          <ProviderIcon
                            aria-hidden="true"
                            className={cn(
                              "size-4 shrink-0",
                              providerIconClassName(session.provider, "text-muted-foreground"),
                            )}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm">
                              {session.title ?? `Session ${session.sessionId.slice(0, 8)}`}
                            </div>
                            <div className="text-muted-foreground/70 text-xs">
                              {providerLabel(session.provider)} ·{" "}
                              {formatRelative(session.lastActiveAt)} ·{" "}
                              {formatFileSize(session.fileSize)}
                            </div>
                          </div>
                          <Button
                            variant={group.projectId ? "default" : "outline"}
                            size="sm"
                            disabled={isImporting}
                            onClick={() => handleImport(session, group.projectId)}
                            title={
                              group.projectId
                                ? undefined
                                : `Will auto-create a project at ${session.cwd}`
                            }
                          >
                            {isImporting ? (
                              <Loader2Icon className="size-3 animate-spin" />
                            ) : (
                              <DownloadIcon className="size-3" />
                            )}
                            {group.projectId ? "Import" : "Create & import"}
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
              {importError ? (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-destructive-foreground text-sm">
                  Import failed: {importError}
                </div>
              ) : null}
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
