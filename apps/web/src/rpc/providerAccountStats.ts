import { useAtomValue } from "@effect/atom-react";
import type { ProviderAccountStatsSnapshot, ProviderKind } from "@codewithme/contracts";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "./atomRegistry";

type ProviderAccountStatsMap = Record<string, ProviderAccountStatsSnapshot>;

const EMPTY_STATS: ProviderAccountStatsMap = {};

const providerAccountStatsAtom = Atom.make<ProviderAccountStatsMap>(EMPTY_STATS).pipe(
  Atom.keepAlive,
  Atom.withLabel("provider-account-stats"),
);

export function applyProviderAccountStatsUpdate(snapshot: ProviderAccountStatsSnapshot): void {
  const current = appAtomRegistry.get(providerAccountStatsAtom);
  appAtomRegistry.set(providerAccountStatsAtom, {
    ...current,
    [snapshot.provider]: snapshot,
  });
}

function selectByProvider(
  provider: ProviderKind,
): (map: ProviderAccountStatsMap) => ProviderAccountStatsSnapshot | null {
  return (map) => map[provider] ?? null;
}

export function useProviderAccountStats(
  provider: ProviderKind,
): ProviderAccountStatsSnapshot | null {
  return useAtomValue(providerAccountStatsAtom, selectByProvider(provider));
}

export function resetProviderAccountStatsForTests(): void {
  appAtomRegistry.set(providerAccountStatsAtom, EMPTY_STATS);
}
