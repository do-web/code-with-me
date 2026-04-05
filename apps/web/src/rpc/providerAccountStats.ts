import { useMemo, useSyncExternalStore } from "react";
import type { ProviderAccountStatsSnapshot, ProviderKind } from "@codewithme/contracts";

type ProviderAccountStatsMap = Readonly<Record<string, ProviderAccountStatsSnapshot>>;

let currentStats: ProviderAccountStatsMap = {};
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ProviderAccountStatsMap {
  return currentStats;
}

export function applyProviderAccountStatsUpdate(snapshot: ProviderAccountStatsSnapshot): void {
  currentStats = { ...currentStats, [snapshot.provider]: snapshot };
  emitChange();
}

export function useProviderAccountStats(
  provider: ProviderKind,
): ProviderAccountStatsSnapshot | null {
  const state = useSyncExternalStore(subscribe, getSnapshot);
  return useMemo(() => state[provider] ?? null, [state, provider]);
}

export function resetProviderAccountStatsForTests(): void {
  currentStats = {};
  listeners.clear();
}
