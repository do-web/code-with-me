import type { ProviderAccountStatsSnapshot, ProviderKind } from "@codewithme/contracts";
import { ServiceMap, type Effect, type Stream } from "effect";

interface SnapshotState {
  readonly latestByProvider: ReadonlyMap<ProviderKind, ProviderAccountStatsSnapshot>;
}

export interface ProviderAccountStatsShape {
  readonly publish: (snapshot: ProviderAccountStatsSnapshot) => Effect.Effect<void>;
  readonly streamUpdates: Stream.Stream<ProviderAccountStatsSnapshot>;
  readonly snapshot: Effect.Effect<SnapshotState>;
  readonly getLatest: (
    provider: ProviderKind,
  ) => Effect.Effect<ProviderAccountStatsSnapshot | null>;
}

export class ProviderAccountStatsService extends ServiceMap.Service<
  ProviderAccountStatsService,
  ProviderAccountStatsShape
>()("codewithme/provider/Services/ProviderAccountStats") {}
