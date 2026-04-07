/**
 * Single Zustand store for terminal UI state keyed by projectId.
 *
 * Terminal transition helpers are intentionally private to keep the public
 * API constrained to store actions/selectors.
 */

import { ProjectId, type TerminalEvent } from "@codewithme/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { analyzeOutput, extractLastLine } from "./lib/terminalAnsi";
import { resolveStorage } from "./lib/storage";
import { terminalRunningSubprocessFromEvent } from "./terminalActivity";
import {
  DEFAULT_THREAD_TERMINAL_HEIGHT,
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_TERMINALS_PER_GROUP,
  type ThreadTerminalGroup,
} from "./types";

interface ThreadTerminalState {
  terminalOpen: boolean;
  terminalCollapsed: boolean;
  terminalHeight: number;
  terminalIds: string[];
  runningTerminalIds: string[];
  activeTerminalId: string;
  terminalGroups: ThreadTerminalGroup[];
  activeTerminalGroupId: string;
}

export interface TerminalCollapsedInfo {
  lastMessage: string;
  warningCount: number;
  errorCount: number;
}

export interface ThreadTerminalLaunchContext {
  cwd: string;
  worktreePath: string | null;
}

export interface TerminalEventEntry {
  id: number;
  event: TerminalEvent;
}

const TERMINAL_STATE_STORAGE_KEY = "codewithme:terminal-state:v1";
const EMPTY_TERMINAL_EVENT_ENTRIES: ReadonlyArray<TerminalEventEntry> = [];
const MAX_TERMINAL_EVENT_BUFFER = 200;

function createTerminalStateStorage() {
  return resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined);
}

function normalizeTerminalIds(terminalIds: string[]): string[] {
  const ids = [...new Set(terminalIds.map((id) => id.trim()).filter((id) => id.length > 0))];
  return ids.length > 0 ? ids : [DEFAULT_THREAD_TERMINAL_ID];
}

function normalizeRunningTerminalIds(
  runningTerminalIds: string[],
  terminalIds: string[],
): string[] {
  if (runningTerminalIds.length === 0) return [];
  const validTerminalIdSet = new Set(terminalIds);
  return [...new Set(runningTerminalIds)]
    .map((id) => id.trim())
    .filter((id) => id.length > 0 && validTerminalIdSet.has(id));
}

function fallbackGroupId(terminalId: string): string {
  return `group-${terminalId}`;
}

function assignUniqueGroupId(baseId: string, usedGroupIds: Set<string>): string {
  let candidate = baseId;
  let index = 2;
  while (usedGroupIds.has(candidate)) {
    candidate = `${baseId}-${index}`;
    index += 1;
  }
  usedGroupIds.add(candidate);
  return candidate;
}

function findGroupIndexByTerminalId(
  terminalGroups: ThreadTerminalGroup[],
  terminalId: string,
): number {
  return terminalGroups.findIndex((group) => group.terminalIds.includes(terminalId));
}

function normalizeTerminalGroupIds(terminalIds: string[]): string[] {
  return [...new Set(terminalIds.map((id) => id.trim()).filter((id) => id.length > 0))];
}

function normalizeTerminalGroups(
  terminalGroups: ThreadTerminalGroup[],
  terminalIds: string[],
): ThreadTerminalGroup[] {
  const validTerminalIdSet = new Set(terminalIds);
  const assignedTerminalIds = new Set<string>();
  const nextGroups: ThreadTerminalGroup[] = [];
  const usedGroupIds = new Set<string>();

  for (const group of terminalGroups) {
    const groupTerminalIds = normalizeTerminalGroupIds(group.terminalIds).filter((terminalId) => {
      if (!validTerminalIdSet.has(terminalId)) return false;
      if (assignedTerminalIds.has(terminalId)) return false;
      return true;
    });
    if (groupTerminalIds.length === 0) continue;
    for (const terminalId of groupTerminalIds) {
      assignedTerminalIds.add(terminalId);
    }
    const baseGroupId =
      group.id.trim().length > 0
        ? group.id.trim()
        : fallbackGroupId(groupTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);
    nextGroups.push({
      id: assignUniqueGroupId(baseGroupId, usedGroupIds),
      terminalIds: groupTerminalIds,
    });
  }

  for (const terminalId of terminalIds) {
    if (assignedTerminalIds.has(terminalId)) continue;
    nextGroups.push({
      id: assignUniqueGroupId(fallbackGroupId(terminalId), usedGroupIds),
      terminalIds: [terminalId],
    });
  }

  if (nextGroups.length === 0) {
    return [
      {
        id: fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID),
        terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
      },
    ];
  }

  return nextGroups;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function terminalGroupsEqual(left: ThreadTerminalGroup[], right: ThreadTerminalGroup[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftGroup = left[index];
    const rightGroup = right[index];
    if (!leftGroup || !rightGroup) return false;
    if (leftGroup.id !== rightGroup.id) return false;
    if (!arraysEqual(leftGroup.terminalIds, rightGroup.terminalIds)) return false;
  }
  return true;
}

function threadTerminalStateEqual(left: ThreadTerminalState, right: ThreadTerminalState): boolean {
  return (
    left.terminalOpen === right.terminalOpen &&
    left.terminalCollapsed === right.terminalCollapsed &&
    left.terminalHeight === right.terminalHeight &&
    left.activeTerminalId === right.activeTerminalId &&
    left.activeTerminalGroupId === right.activeTerminalGroupId &&
    arraysEqual(left.terminalIds, right.terminalIds) &&
    arraysEqual(left.runningTerminalIds, right.runningTerminalIds) &&
    terminalGroupsEqual(left.terminalGroups, right.terminalGroups)
  );
}

const DEFAULT_THREAD_TERMINAL_STATE: ThreadTerminalState = Object.freeze({
  terminalOpen: false,
  terminalCollapsed: false,
  terminalHeight: DEFAULT_THREAD_TERMINAL_HEIGHT,
  terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
  runningTerminalIds: [],
  activeTerminalId: DEFAULT_THREAD_TERMINAL_ID,
  terminalGroups: [
    {
      id: fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID),
      terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
    },
  ],
  activeTerminalGroupId: fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID),
});

function createDefaultThreadTerminalState(): ThreadTerminalState {
  return {
    ...DEFAULT_THREAD_TERMINAL_STATE,
    terminalIds: [...DEFAULT_THREAD_TERMINAL_STATE.terminalIds],
    runningTerminalIds: [...DEFAULT_THREAD_TERMINAL_STATE.runningTerminalIds],
    terminalGroups: copyTerminalGroups(DEFAULT_THREAD_TERMINAL_STATE.terminalGroups),
  };
}

function getDefaultThreadTerminalState(): ThreadTerminalState {
  return DEFAULT_THREAD_TERMINAL_STATE;
}

function normalizeThreadTerminalState(state: ThreadTerminalState): ThreadTerminalState {
  const terminalIds = normalizeTerminalIds(state.terminalIds);
  const nextTerminalIds = terminalIds.length > 0 ? terminalIds : [DEFAULT_THREAD_TERMINAL_ID];
  const runningTerminalIds = normalizeRunningTerminalIds(state.runningTerminalIds, nextTerminalIds);
  const activeTerminalId = nextTerminalIds.includes(state.activeTerminalId)
    ? state.activeTerminalId
    : (nextTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);
  const terminalGroups = normalizeTerminalGroups(state.terminalGroups, nextTerminalIds);
  const activeGroupIdFromState = terminalGroups.some(
    (group) => group.id === state.activeTerminalGroupId,
  )
    ? state.activeTerminalGroupId
    : null;
  const activeGroupIdFromTerminal =
    terminalGroups.find((group) => group.terminalIds.includes(activeTerminalId))?.id ?? null;

  const normalized: ThreadTerminalState = {
    terminalOpen: state.terminalOpen,
    terminalCollapsed: state.terminalCollapsed ?? false,
    terminalHeight:
      Number.isFinite(state.terminalHeight) && state.terminalHeight > 0
        ? state.terminalHeight
        : DEFAULT_THREAD_TERMINAL_HEIGHT,
    terminalIds: nextTerminalIds,
    runningTerminalIds,
    activeTerminalId,
    terminalGroups,
    activeTerminalGroupId:
      activeGroupIdFromState ??
      activeGroupIdFromTerminal ??
      terminalGroups[0]?.id ??
      fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID),
  };
  return threadTerminalStateEqual(state, normalized) ? state : normalized;
}

function isDefaultThreadTerminalState(state: ThreadTerminalState): boolean {
  const normalized = normalizeThreadTerminalState(state);
  return threadTerminalStateEqual(normalized, DEFAULT_THREAD_TERMINAL_STATE);
}

function isValidTerminalId(terminalId: string): boolean {
  return terminalId.trim().length > 0;
}

function terminalEventBufferKey(projectId: ProjectId, terminalId: string): string {
  return `${projectId}\u0000${terminalId}`;
}

function copyTerminalGroups(groups: ThreadTerminalGroup[]): ThreadTerminalGroup[] {
  return groups.map((group) => ({
    id: group.id,
    terminalIds: [...group.terminalIds],
  }));
}

function appendTerminalEventEntry(
  terminalEventEntriesByKey: Record<string, ReadonlyArray<TerminalEventEntry>>,
  nextTerminalEventId: number,
  event: TerminalEvent,
) {
  const key = terminalEventBufferKey(ProjectId.makeUnsafe(event.projectId), event.terminalId);
  const currentEntries = terminalEventEntriesByKey[key] ?? EMPTY_TERMINAL_EVENT_ENTRIES;
  const nextEntry: TerminalEventEntry = {
    id: nextTerminalEventId,
    event,
  };
  const nextEntries =
    currentEntries.length >= MAX_TERMINAL_EVENT_BUFFER
      ? [...currentEntries.slice(1), nextEntry]
      : [...currentEntries, nextEntry];

  return {
    terminalEventEntriesByKey: {
      ...terminalEventEntriesByKey,
      [key]: nextEntries,
    },
    nextTerminalEventId: nextTerminalEventId + 1,
  };
}

function launchContextFromStartEvent(
  event: Extract<TerminalEvent, { type: "started" | "restarted" }>,
): ThreadTerminalLaunchContext {
  return {
    cwd: event.snapshot.cwd,
    worktreePath: event.snapshot.worktreePath,
  };
}

function upsertTerminalIntoGroups(
  state: ThreadTerminalState,
  terminalId: string,
  mode: "split" | "new",
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!isValidTerminalId(terminalId)) {
    return normalized;
  }

  const isNewTerminal = !normalized.terminalIds.includes(terminalId);
  const terminalIds = isNewTerminal
    ? [...normalized.terminalIds, terminalId]
    : normalized.terminalIds;
  const terminalGroups = copyTerminalGroups(normalized.terminalGroups);

  const existingGroupIndex = findGroupIndexByTerminalId(terminalGroups, terminalId);
  if (existingGroupIndex >= 0) {
    terminalGroups[existingGroupIndex]!.terminalIds = terminalGroups[
      existingGroupIndex
    ]!.terminalIds.filter((id) => id !== terminalId);
    if (terminalGroups[existingGroupIndex]!.terminalIds.length === 0) {
      terminalGroups.splice(existingGroupIndex, 1);
    }
  }

  if (mode === "new") {
    const usedGroupIds = new Set(terminalGroups.map((group) => group.id));
    const nextGroupId = assignUniqueGroupId(fallbackGroupId(terminalId), usedGroupIds);
    terminalGroups.push({ id: nextGroupId, terminalIds: [terminalId] });
    return normalizeThreadTerminalState({
      ...normalized,
      terminalOpen: true,
      terminalIds,
      activeTerminalId: terminalId,
      terminalGroups,
      activeTerminalGroupId: nextGroupId,
    });
  }

  let activeGroupIndex = terminalGroups.findIndex(
    (group) => group.id === normalized.activeTerminalGroupId,
  );
  if (activeGroupIndex < 0) {
    activeGroupIndex = findGroupIndexByTerminalId(terminalGroups, normalized.activeTerminalId);
  }
  if (activeGroupIndex < 0) {
    const usedGroupIds = new Set(terminalGroups.map((group) => group.id));
    const nextGroupId = assignUniqueGroupId(
      fallbackGroupId(normalized.activeTerminalId),
      usedGroupIds,
    );
    terminalGroups.push({ id: nextGroupId, terminalIds: [normalized.activeTerminalId] });
    activeGroupIndex = terminalGroups.length - 1;
  }

  const destinationGroup = terminalGroups[activeGroupIndex];
  if (!destinationGroup) {
    return normalized;
  }

  if (
    isNewTerminal &&
    !destinationGroup.terminalIds.includes(terminalId) &&
    destinationGroup.terminalIds.length >= MAX_TERMINALS_PER_GROUP
  ) {
    return normalized;
  }

  if (!destinationGroup.terminalIds.includes(terminalId)) {
    const anchorIndex = destinationGroup.terminalIds.indexOf(normalized.activeTerminalId);
    if (anchorIndex >= 0) {
      destinationGroup.terminalIds.splice(anchorIndex + 1, 0, terminalId);
    } else {
      destinationGroup.terminalIds.push(terminalId);
    }
  }

  return normalizeThreadTerminalState({
    ...normalized,
    terminalOpen: true,
    terminalIds,
    activeTerminalId: terminalId,
    terminalGroups,
    activeTerminalGroupId: destinationGroup.id,
  });
}

function setThreadTerminalOpen(state: ThreadTerminalState, open: boolean): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (normalized.terminalOpen === open) return normalized;
  return { ...normalized, terminalOpen: open };
}

function setThreadTerminalCollapsed(
  state: ThreadTerminalState,
  collapsed: boolean,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (normalized.terminalCollapsed === collapsed) return normalized;
  return { ...normalized, terminalCollapsed: collapsed };
}

function setThreadTerminalHeight(state: ThreadTerminalState, height: number): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!Number.isFinite(height) || height <= 0 || normalized.terminalHeight === height) {
    return normalized;
  }
  return { ...normalized, terminalHeight: height };
}

function splitThreadTerminal(state: ThreadTerminalState, terminalId: string): ThreadTerminalState {
  return upsertTerminalIntoGroups(state, terminalId, "split");
}

function newThreadTerminal(state: ThreadTerminalState, terminalId: string): ThreadTerminalState {
  return upsertTerminalIntoGroups(state, terminalId, "new");
}

function setThreadActiveTerminal(
  state: ThreadTerminalState,
  terminalId: string,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }
  const activeTerminalGroupId =
    normalized.terminalGroups.find((group) => group.terminalIds.includes(terminalId))?.id ??
    normalized.activeTerminalGroupId;
  if (
    normalized.activeTerminalId === terminalId &&
    normalized.activeTerminalGroupId === activeTerminalGroupId
  ) {
    return normalized;
  }
  return {
    ...normalized,
    activeTerminalId: terminalId,
    activeTerminalGroupId,
  };
}

function closeThreadTerminal(state: ThreadTerminalState, terminalId: string): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }

  const remainingTerminalIds = normalized.terminalIds.filter((id) => id !== terminalId);
  if (remainingTerminalIds.length === 0) {
    return createDefaultThreadTerminalState();
  }

  const closedTerminalIndex = normalized.terminalIds.indexOf(terminalId);
  const nextActiveTerminalId =
    normalized.activeTerminalId === terminalId
      ? (remainingTerminalIds[Math.min(closedTerminalIndex, remainingTerminalIds.length - 1)] ??
        remainingTerminalIds[0] ??
        DEFAULT_THREAD_TERMINAL_ID)
      : normalized.activeTerminalId;

  const terminalGroups = normalized.terminalGroups
    .map((group) => ({
      ...group,
      terminalIds: group.terminalIds.filter((id) => id !== terminalId),
    }))
    .filter((group) => group.terminalIds.length > 0);

  const nextActiveTerminalGroupId =
    terminalGroups.find((group) => group.terminalIds.includes(nextActiveTerminalId))?.id ??
    terminalGroups[0]?.id ??
    fallbackGroupId(nextActiveTerminalId);

  return normalizeThreadTerminalState({
    terminalOpen: normalized.terminalOpen,
    terminalCollapsed: normalized.terminalCollapsed,
    terminalHeight: normalized.terminalHeight,
    terminalIds: remainingTerminalIds,
    runningTerminalIds: normalized.runningTerminalIds.filter((id) => id !== terminalId),
    activeTerminalId: nextActiveTerminalId,
    terminalGroups,
    activeTerminalGroupId: nextActiveTerminalGroupId,
  });
}

function setThreadTerminalActivity(
  state: ThreadTerminalState,
  terminalId: string,
  hasRunningSubprocess: boolean,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }
  const alreadyRunning = normalized.runningTerminalIds.includes(terminalId);
  if (hasRunningSubprocess === alreadyRunning) {
    return normalized;
  }
  const runningTerminalIds = new Set(normalized.runningTerminalIds);
  if (hasRunningSubprocess) {
    runningTerminalIds.add(terminalId);
  } else {
    runningTerminalIds.delete(terminalId);
  }
  return { ...normalized, runningTerminalIds: [...runningTerminalIds] };
}

export function selectProjectTerminalState(
  terminalStateByProjectId: Record<ProjectId, ThreadTerminalState>,
  projectId: ProjectId,
): ThreadTerminalState {
  if (projectId.length === 0) {
    return getDefaultThreadTerminalState();
  }
  return terminalStateByProjectId[projectId] ?? getDefaultThreadTerminalState();
}

function updateTerminalStateByProjectId(
  terminalStateByProjectId: Record<ProjectId, ThreadTerminalState>,
  projectId: ProjectId,
  updater: (state: ThreadTerminalState) => ThreadTerminalState,
): Record<ProjectId, ThreadTerminalState> {
  if (projectId.length === 0) {
    return terminalStateByProjectId;
  }

  const current = selectProjectTerminalState(terminalStateByProjectId, projectId);
  const next = updater(current);
  if (next === current) {
    return terminalStateByProjectId;
  }

  if (isDefaultThreadTerminalState(next)) {
    if (terminalStateByProjectId[projectId] === undefined) {
      return terminalStateByProjectId;
    }
    const { [projectId]: _removed, ...rest } = terminalStateByProjectId;
    return rest as Record<ProjectId, ThreadTerminalState>;
  }

  return {
    ...terminalStateByProjectId,
    [projectId]: next,
  };
}

export function selectTerminalEventEntries(
  terminalEventEntriesByKey: Record<string, ReadonlyArray<TerminalEventEntry>>,
  projectId: ProjectId,
  terminalId: string,
): ReadonlyArray<TerminalEventEntry> {
  if (projectId.length === 0 || terminalId.trim().length === 0) {
    return EMPTY_TERMINAL_EVENT_ENTRIES;
  }
  return (
    terminalEventEntriesByKey[terminalEventBufferKey(projectId, terminalId)] ??
    EMPTY_TERMINAL_EVENT_ENTRIES
  );
}

const DEFAULT_COLLAPSED_INFO: TerminalCollapsedInfo = {
  lastMessage: "",
  warningCount: 0,
  errorCount: 0,
};

export function selectTerminalCollapsedInfo(
  terminalCollapsedInfoByKey: Record<string, TerminalCollapsedInfo>,
  projectId: ProjectId,
  terminalId: string,
): TerminalCollapsedInfo {
  if (projectId.length === 0 || terminalId.trim().length === 0) {
    return DEFAULT_COLLAPSED_INFO;
  }
  return (
    terminalCollapsedInfoByKey[terminalEventBufferKey(projectId, terminalId)] ??
    DEFAULT_COLLAPSED_INFO
  );
}

function updateCollapsedInfoForEvent(
  info: TerminalCollapsedInfo,
  event: TerminalEvent,
): TerminalCollapsedInfo {
  if (event.type === "output") {
    const { lastLine, warnings, errors } = analyzeOutput(event.data);
    return {
      lastMessage: lastLine ?? info.lastMessage,
      warningCount: info.warningCount + warnings,
      errorCount: info.errorCount + errors,
    };
  }
  if (event.type === "error") {
    return {
      lastMessage: event.message,
      warningCount: info.warningCount,
      errorCount: info.errorCount + 1,
    };
  }
  if (event.type === "started" || event.type === "restarted") {
    return { lastMessage: "", warningCount: 0, errorCount: 0 };
  }
  if (event.type === "cleared") {
    return { ...info, lastMessage: "" };
  }
  return info;
}

function initCollapsedInfoFromBuffer(
  entries: ReadonlyArray<TerminalEventEntry>,
): TerminalCollapsedInfo {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.event.type === "output") {
      const lastLine = extractLastLine(entry.event.data);
      if (lastLine) return { lastMessage: lastLine, warningCount: 0, errorCount: 0 };
    }
  }
  return { lastMessage: "", warningCount: 0, errorCount: 0 };
}

function applyCollapsedTransition(
  state: Pick<
    TerminalStateStoreState,
    "terminalStateByProjectId" | "terminalEventEntriesByKey" | "terminalCollapsedInfoByKey"
  >,
  projectId: ProjectId,
  collapsed: boolean,
): Partial<TerminalStateStoreState> {
  const nextTerminalStateByProjectId = updateTerminalStateByProjectId(
    state.terminalStateByProjectId,
    projectId,
    (current) => setThreadTerminalCollapsed(current, collapsed),
  );
  if (nextTerminalStateByProjectId === state.terminalStateByProjectId) {
    return state as TerminalStateStoreState;
  }

  const terminalState = selectProjectTerminalState(nextTerminalStateByProjectId, projectId);
  let nextCollapsedInfoByKey = state.terminalCollapsedInfoByKey;

  if (collapsed) {
    const key = terminalEventBufferKey(projectId, terminalState.activeTerminalId);
    const entries = state.terminalEventEntriesByKey[key] ?? EMPTY_TERMINAL_EVENT_ENTRIES;
    nextCollapsedInfoByKey = {
      ...nextCollapsedInfoByKey,
      [key]: initCollapsedInfoFromBuffer(entries),
    };
  } else {
    const updates: Record<string, TerminalCollapsedInfo> = {};
    for (const terminalId of terminalState.terminalIds) {
      const key = terminalEventBufferKey(projectId, terminalId);
      const existing = nextCollapsedInfoByKey[key];
      if (existing && (existing.warningCount > 0 || existing.errorCount > 0)) {
        updates[key] = { ...existing, warningCount: 0, errorCount: 0 };
      }
    }
    if (Object.keys(updates).length > 0) {
      nextCollapsedInfoByKey = { ...nextCollapsedInfoByKey, ...updates };
    }
  }

  return {
    terminalStateByProjectId: nextTerminalStateByProjectId,
    terminalCollapsedInfoByKey: nextCollapsedInfoByKey,
  };
}

interface TerminalStateStoreState {
  terminalStateByProjectId: Record<ProjectId, ThreadTerminalState>;
  terminalLaunchContextByProjectId: Record<ProjectId, ThreadTerminalLaunchContext>;
  terminalEventEntriesByKey: Record<string, ReadonlyArray<TerminalEventEntry>>;
  terminalCollapsedInfoByKey: Record<string, TerminalCollapsedInfo>;
  nextTerminalEventId: number;
  setTerminalOpen: (projectId: ProjectId, open: boolean) => void;
  setTerminalHeight: (projectId: ProjectId, height: number) => void;
  setTerminalCollapsed: (projectId: ProjectId, collapsed: boolean) => void;
  toggleTerminalCollapsed: (projectId: ProjectId) => void;
  splitTerminal: (projectId: ProjectId, terminalId: string) => void;
  newTerminal: (projectId: ProjectId, terminalId: string) => void;
  ensureTerminal: (
    projectId: ProjectId,
    terminalId: string,
    options?: { open?: boolean; active?: boolean },
  ) => void;
  setActiveTerminal: (projectId: ProjectId, terminalId: string) => void;
  closeTerminal: (projectId: ProjectId, terminalId: string) => void;
  setTerminalLaunchContext: (projectId: ProjectId, context: ThreadTerminalLaunchContext) => void;
  clearTerminalLaunchContext: (projectId: ProjectId) => void;
  setTerminalActivity: (
    projectId: ProjectId,
    terminalId: string,
    hasRunningSubprocess: boolean,
  ) => void;
  recordTerminalEvent: (event: TerminalEvent) => void;
  applyTerminalEvent: (event: TerminalEvent) => void;
  clearTerminalState: (projectId: ProjectId) => void;
  removeTerminalState: (projectId: ProjectId) => void;
  removeOrphanedTerminalStates: (activeProjectIds: Set<ProjectId>) => void;
}

export const useTerminalStateStore = create<TerminalStateStoreState>()(
  persist(
    (set) => {
      const updateTerminal = (
        projectId: ProjectId,
        updater: (state: ThreadTerminalState) => ThreadTerminalState,
      ) => {
        set((state) => {
          const nextTerminalStateByProjectId = updateTerminalStateByProjectId(
            state.terminalStateByProjectId,
            projectId,
            updater,
          );
          if (nextTerminalStateByProjectId === state.terminalStateByProjectId) {
            return state;
          }
          return {
            terminalStateByProjectId: nextTerminalStateByProjectId,
          };
        });
      };

      return {
        terminalStateByProjectId: {},
        terminalLaunchContextByProjectId: {},
        terminalEventEntriesByKey: {},
        terminalCollapsedInfoByKey: {},
        nextTerminalEventId: 1,
        setTerminalOpen: (projectId, open) =>
          updateTerminal(projectId, (state) => setThreadTerminalOpen(state, open)),
        setTerminalHeight: (projectId, height) =>
          updateTerminal(projectId, (state) => setThreadTerminalHeight(state, height)),
        setTerminalCollapsed: (projectId, collapsed) =>
          set((state) => applyCollapsedTransition(state, projectId, collapsed)),
        toggleTerminalCollapsed: (projectId) =>
          set((state) => {
            const current = selectProjectTerminalState(state.terminalStateByProjectId, projectId);
            return applyCollapsedTransition(state, projectId, !current.terminalCollapsed);
          }),
        splitTerminal: (projectId, terminalId) =>
          updateTerminal(projectId, (state) => splitThreadTerminal(state, terminalId)),
        newTerminal: (projectId, terminalId) =>
          updateTerminal(projectId, (state) => newThreadTerminal(state, terminalId)),
        ensureTerminal: (projectId, terminalId, options) =>
          updateTerminal(projectId, (state) => {
            let nextState = state;
            if (!state.terminalIds.includes(terminalId)) {
              nextState = newThreadTerminal(nextState, terminalId);
            }
            if (options?.active === false) {
              nextState = {
                ...nextState,
                activeTerminalId: state.activeTerminalId,
                activeTerminalGroupId: state.activeTerminalGroupId,
              };
            }
            if (options?.active ?? true) {
              nextState = setThreadActiveTerminal(nextState, terminalId);
            }
            if (options?.open) {
              nextState = setThreadTerminalOpen(nextState, true);
            }
            return normalizeThreadTerminalState(nextState);
          }),
        setActiveTerminal: (projectId, terminalId) =>
          updateTerminal(projectId, (state) => setThreadActiveTerminal(state, terminalId)),
        closeTerminal: (projectId, terminalId) =>
          updateTerminal(projectId, (state) => closeThreadTerminal(state, terminalId)),
        setTerminalLaunchContext: (projectId, context) =>
          set((state) => ({
            terminalLaunchContextByProjectId: {
              ...state.terminalLaunchContextByProjectId,
              [projectId]: context,
            },
          })),
        clearTerminalLaunchContext: (projectId) =>
          set((state) => {
            if (!state.terminalLaunchContextByProjectId[projectId]) {
              return state;
            }
            const { [projectId]: _removed, ...rest } = state.terminalLaunchContextByProjectId;
            return { terminalLaunchContextByProjectId: rest };
          }),
        setTerminalActivity: (projectId, terminalId, hasRunningSubprocess) =>
          updateTerminal(projectId, (state) =>
            setThreadTerminalActivity(state, terminalId, hasRunningSubprocess),
          ),
        recordTerminalEvent: (event) =>
          set((state) => {
            const nextEventState = appendTerminalEventEntry(
              state.terminalEventEntriesByKey,
              state.nextTerminalEventId,
              event,
            );

            // Update collapsed info if the terminal's project is collapsed
            const projectId = ProjectId.makeUnsafe(event.projectId);
            const terminalState = selectProjectTerminalState(
              state.terminalStateByProjectId,
              projectId,
            );
            if (!terminalState.terminalCollapsed) {
              return nextEventState;
            }

            const key = terminalEventBufferKey(projectId, event.terminalId);
            const currentInfo = state.terminalCollapsedInfoByKey[key] ?? DEFAULT_COLLAPSED_INFO;
            const nextInfo = updateCollapsedInfoForEvent(currentInfo, event);
            if (nextInfo === currentInfo) {
              return nextEventState;
            }

            return {
              ...nextEventState,
              terminalCollapsedInfoByKey: {
                ...state.terminalCollapsedInfoByKey,
                [key]: nextInfo,
              },
            };
          }),
        applyTerminalEvent: (event) =>
          set((state) => {
            const projectId = ProjectId.makeUnsafe(event.projectId);
            let nextTerminalStateByProjectId = state.terminalStateByProjectId;
            let nextTerminalLaunchContextByProjectId = state.terminalLaunchContextByProjectId;

            if (event.type === "started" || event.type === "restarted") {
              nextTerminalStateByProjectId = updateTerminalStateByProjectId(
                nextTerminalStateByProjectId,
                projectId,
                (current) => {
                  let nextState = current;
                  if (!current.terminalIds.includes(event.terminalId)) {
                    nextState = newThreadTerminal(nextState, event.terminalId);
                  }
                  nextState = setThreadActiveTerminal(nextState, event.terminalId);
                  nextState = setThreadTerminalOpen(nextState, true);
                  return normalizeThreadTerminalState(nextState);
                },
              );
              nextTerminalLaunchContextByProjectId = {
                ...nextTerminalLaunchContextByProjectId,
                [projectId]: launchContextFromStartEvent(event),
              };
            }

            const hasRunningSubprocess = terminalRunningSubprocessFromEvent(event);
            if (hasRunningSubprocess !== null) {
              nextTerminalStateByProjectId = updateTerminalStateByProjectId(
                nextTerminalStateByProjectId,
                projectId,
                (current) =>
                  setThreadTerminalActivity(current, event.terminalId, hasRunningSubprocess),
              );
            }

            const nextEventState = appendTerminalEventEntry(
              state.terminalEventEntriesByKey,
              state.nextTerminalEventId,
              event,
            );

            // Update collapsed info if the project is collapsed
            const terminalState = selectProjectTerminalState(
              nextTerminalStateByProjectId,
              projectId,
            );
            let nextCollapsedInfoByKey = state.terminalCollapsedInfoByKey;
            if (terminalState.terminalCollapsed) {
              const key = terminalEventBufferKey(projectId, event.terminalId);
              const currentInfo = nextCollapsedInfoByKey[key] ?? DEFAULT_COLLAPSED_INFO;
              const nextInfo = updateCollapsedInfoForEvent(currentInfo, event);
              if (nextInfo !== currentInfo) {
                nextCollapsedInfoByKey = { ...nextCollapsedInfoByKey, [key]: nextInfo };
              }
            }

            return {
              terminalStateByProjectId: nextTerminalStateByProjectId,
              terminalLaunchContextByProjectId: nextTerminalLaunchContextByProjectId,
              terminalCollapsedInfoByKey: nextCollapsedInfoByKey,
              ...nextEventState,
            };
          }),
        clearTerminalState: (projectId) =>
          set((state) => {
            const nextTerminalStateByProjectId = updateTerminalStateByProjectId(
              state.terminalStateByProjectId,
              projectId,
              () => createDefaultThreadTerminalState(),
            );
            const hadLaunchContext =
              state.terminalLaunchContextByProjectId[projectId] !== undefined;
            const { [projectId]: _removed, ...remainingLaunchContexts } =
              state.terminalLaunchContextByProjectId;
            const nextTerminalEventEntriesByKey = { ...state.terminalEventEntriesByKey };
            let removedEventEntries = false;
            for (const key of Object.keys(nextTerminalEventEntriesByKey)) {
              if (key.startsWith(`${projectId}\u0000`)) {
                delete nextTerminalEventEntriesByKey[key];
                removedEventEntries = true;
              }
            }
            if (
              nextTerminalStateByProjectId === state.terminalStateByProjectId &&
              !hadLaunchContext &&
              !removedEventEntries
            ) {
              return state;
            }
            return {
              terminalStateByProjectId: nextTerminalStateByProjectId,
              terminalLaunchContextByProjectId: remainingLaunchContexts,
              terminalEventEntriesByKey: nextTerminalEventEntriesByKey,
            };
          }),
        removeTerminalState: (projectId) =>
          set((state) => {
            const hadTerminalState = state.terminalStateByProjectId[projectId] !== undefined;
            const hadLaunchContext =
              state.terminalLaunchContextByProjectId[projectId] !== undefined;
            const nextTerminalEventEntriesByKey = { ...state.terminalEventEntriesByKey };
            let removedEventEntries = false;
            for (const key of Object.keys(nextTerminalEventEntriesByKey)) {
              if (key.startsWith(`${projectId}\u0000`)) {
                delete nextTerminalEventEntriesByKey[key];
                removedEventEntries = true;
              }
            }
            if (!hadTerminalState && !hadLaunchContext && !removedEventEntries) {
              return state;
            }
            const nextTerminalStateByProjectId = { ...state.terminalStateByProjectId };
            delete nextTerminalStateByProjectId[projectId];
            const nextLaunchContexts = { ...state.terminalLaunchContextByProjectId };
            delete nextLaunchContexts[projectId];
            return {
              terminalStateByProjectId: nextTerminalStateByProjectId,
              terminalLaunchContextByProjectId: nextLaunchContexts,
              terminalEventEntriesByKey: nextTerminalEventEntriesByKey,
            };
          }),
        removeOrphanedTerminalStates: (activeProjectIds) =>
          set((state) => {
            const orphanedIds = Object.keys(state.terminalStateByProjectId).filter(
              (id) => !activeProjectIds.has(id as ProjectId),
            );
            const orphanedLaunchContextIds = Object.keys(
              state.terminalLaunchContextByProjectId,
            ).filter((id) => !activeProjectIds.has(id as ProjectId));
            const nextTerminalEventEntriesByKey = { ...state.terminalEventEntriesByKey };
            let removedEventEntries = false;
            for (const key of Object.keys(nextTerminalEventEntriesByKey)) {
              const [projectId] = key.split("\u0000");
              if (projectId && !activeProjectIds.has(projectId as ProjectId)) {
                delete nextTerminalEventEntriesByKey[key];
                removedEventEntries = true;
              }
            }
            if (
              orphanedIds.length === 0 &&
              orphanedLaunchContextIds.length === 0 &&
              !removedEventEntries
            ) {
              return state;
            }
            const next = { ...state.terminalStateByProjectId };
            for (const id of orphanedIds) {
              delete next[id as ProjectId];
            }
            const nextLaunchContexts = { ...state.terminalLaunchContextByProjectId };
            for (const id of orphanedLaunchContextIds) {
              delete nextLaunchContexts[id as ProjectId];
            }
            return {
              terminalStateByProjectId: next,
              terminalLaunchContextByProjectId: nextLaunchContexts,
              terminalEventEntriesByKey: nextTerminalEventEntriesByKey,
            };
          }),
      };
    },
    {
      name: TERMINAL_STATE_STORAGE_KEY,
      version: 2,
      storage: createJSONStorage(createTerminalStateStorage),
      migrate: (persistedState, version) => {
        if (version < 2) {
          return { terminalStateByProjectId: {}, terminalLaunchContextByProjectId: {} };
        }
        return persistedState;
      },
      partialize: (state) => ({
        terminalStateByProjectId: state.terminalStateByProjectId,
      }),
    },
  ),
);
