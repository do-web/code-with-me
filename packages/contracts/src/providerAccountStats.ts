import { Schema } from "effect";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas";
import { ProviderKind } from "./orchestration";

export const ProviderQuota = Schema.Struct({
  name: TrimmedNonEmptyString,
  percentUsed: Schema.Number,
  percentReserve: Schema.optional(Schema.Number),
  resetsAtIso: Schema.optional(TrimmedNonEmptyString),
  resetsInMs: Schema.optional(Schema.Number),
});
export type ProviderQuota = typeof ProviderQuota.Type;

export const ProviderAccountStatsSnapshot = Schema.Struct({
  provider: ProviderKind,
  plan: Schema.optional(TrimmedNonEmptyString),
  email: Schema.optional(TrimmedNonEmptyString),
  quotas: Schema.Array(ProviderQuota),
  sessionCostUsd: Schema.optional(Schema.Number),
  sessionTokensTotal: Schema.optional(Schema.Number),
  updatedAt: IsoDateTime,
});
export type ProviderAccountStatsSnapshot = typeof ProviderAccountStatsSnapshot.Type;

export const ProviderAccountStatsEvent = Schema.Struct({
  type: Schema.Literal("provider.account-stats.updated"),
  payload: ProviderAccountStatsSnapshot,
});
export type ProviderAccountStatsEvent = typeof ProviderAccountStatsEvent.Type;
