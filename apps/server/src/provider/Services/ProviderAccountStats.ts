import type { ProviderAccountStatsSnapshot, ProviderKind } from "@codewithme/contracts";
import { ServiceMap, type Effect, type Stream } from "effect";

export interface ProviderAccountStatsShape {
  readonly publish: (snapshot: ProviderAccountStatsSnapshot) => Effect.Effect<void>;
  readonly streamUpdates: Stream.Stream<ProviderAccountStatsSnapshot>;
  readonly getLatest: (
    provider: ProviderKind,
  ) => Effect.Effect<ProviderAccountStatsSnapshot | null>;
}

export class ProviderAccountStatsService extends ServiceMap.Service<
  ProviderAccountStatsService,
  ProviderAccountStatsShape
>()("codewithme/provider/Services/ProviderAccountStats") {}
