import type { ProviderAccountStatsSnapshot, ProviderKind } from "@codewithme/contracts";
import { Effect, Layer, PubSub, Ref, Stream } from "effect";

import {
  ProviderAccountStatsService,
  type ProviderAccountStatsShape,
} from "../Services/ProviderAccountStats";

export const ProviderAccountStatsLive = Layer.effect(
  ProviderAccountStatsService,
  Effect.gen(function* () {
    const pubSub = yield* PubSub.unbounded<ProviderAccountStatsSnapshot>();
    const latestByProvider = yield* Ref.make<Map<ProviderKind, ProviderAccountStatsSnapshot>>(
      new Map(),
    );

    return {
      publish: (snapshot) =>
        Effect.gen(function* () {
          yield* Ref.update(latestByProvider, (current) => {
            const next = new Map(current);
            next.set(snapshot.provider, snapshot);
            return next;
          });
          yield* PubSub.publish(pubSub, snapshot);
        }),

      get streamUpdates() {
        return Stream.fromPubSub(pubSub);
      },

      snapshot: Ref.get(latestByProvider).pipe(
        Effect.map((map) => ({
          latestByProvider: map as ReadonlyMap<ProviderKind, ProviderAccountStatsSnapshot>,
        })),
      ),

      getLatest: (provider: ProviderKind) =>
        Ref.get(latestByProvider).pipe(Effect.map((map) => map.get(provider) ?? null)),
    } satisfies ProviderAccountStatsShape;
  }),
);
