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
    const latestByProvider = yield* Ref.make<Record<string, ProviderAccountStatsSnapshot>>({});

    return {
      publish: (snapshot) =>
        Effect.gen(function* () {
          yield* Ref.update(latestByProvider, (current) => ({
            ...current,
            [snapshot.provider]: snapshot,
          }));
          yield* PubSub.publish(pubSub, snapshot);
        }),

      get streamUpdates() {
        return Stream.fromPubSub(pubSub);
      },

      getLatest: (provider: ProviderKind) =>
        Ref.get(latestByProvider).pipe(Effect.map((record) => record[provider] ?? null)),
    } satisfies ProviderAccountStatsShape;
  }),
);
