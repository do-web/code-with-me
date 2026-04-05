# Provider Usage Stats Popover — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show provider-level account stats (quota bars, costs, user identity) in the ContextWindowMeter hover popover, using rate-limit and account events already emitted by both provider adapters.

**Architecture:** Both adapters already emit `account.rate-limits.updated` and `account.updated` runtime events. We add typed contracts, normalize the raw payloads server-side, push them to the client via a new WebSocket subscription channel, store them in an Effect atom, and render them in an enhanced popover.

**Tech Stack:** Effect Schema, Effect PubSub/Stream, React, Tailwind CSS, Vitest

**Spec:** `docs/superpowers/specs/2026-04-05-provider-usage-stats-popover-design.md`

---

## File Map

| Action | Path                                                                 | Responsibility                                             |
| ------ | -------------------------------------------------------------------- | ---------------------------------------------------------- |
| Create | `packages/contracts/src/providerAccountStats.ts`                     | Typed schemas for quota, account stats, WS push event      |
| Modify | `packages/contracts/src/server.ts`                                   | Add `email` to `ServerProviderAuth`                        |
| Modify | `packages/contracts/src/rpc.ts`                                      | Add WS subscription RPC + method key                       |
| Modify | `packages/contracts/src/index.ts`                                    | Re-export new module                                       |
| Create | `apps/server/src/provider/providerAccountStatsNormalization.ts`      | Normalize raw Claude/Codex payloads → typed quotas         |
| Create | `apps/server/src/provider/providerAccountStatsNormalization.test.ts` | Tests for normalization                                    |
| Create | `apps/server/src/provider/Services/ProviderAccountStats.ts`          | Service interface (PubSub + state)                         |
| Create | `apps/server/src/provider/Layers/ProviderAccountStats.ts`            | PubSub-backed implementation                               |
| Modify | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`   | Handle rate-limit + account events, accumulate cost        |
| Modify | `apps/server/src/ws.ts`                                              | Add WS subscription endpoint                               |
| Modify | `apps/server/src/server.ts`                                          | Wire ProviderAccountStats layer                            |
| Modify | `apps/web/src/wsRpcClient.ts`                                        | Add subscription method                                    |
| Create | `apps/web/src/rpc/providerAccountStats.ts`                           | Atom store + sync function                                 |
| Modify | `apps/web/src/rpc/serverState.ts`                                    | Wire provider stats subscription into startServerStateSync |
| Create | `apps/web/src/components/chat/ProviderStatsPopover.tsx`              | Enhanced popover content component                         |
| Create | `apps/web/src/components/chat/QuotaBar.tsx`                          | Single quota progress bar component                        |
| Modify | `apps/web/src/components/chat/ContextWindowMeter.tsx`                | Use new popover content                                    |

---

### Task 1: Contract Schemas (packages/contracts)

**Files:**

- Create: `packages/contracts/src/providerAccountStats.ts`
- Modify: `packages/contracts/src/server.ts`
- Modify: `packages/contracts/src/rpc.ts`
- Modify: `packages/contracts/src/index.ts`

- [ ] **Step 1: Create providerAccountStats.ts with typed schemas**

```ts
// packages/contracts/src/providerAccountStats.ts
import { Schema } from "effect";
import { TrimmedNonEmptyString, IsoDateTime } from "./baseSchemas";
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
```

- [ ] **Step 2: Add email to ServerProviderAuth**

In `packages/contracts/src/server.ts`, add `email` field:

```ts
export const ServerProviderAuth = Schema.Struct({
  status: ServerProviderAuthStatus,
  type: Schema.optional(TrimmedNonEmptyString),
  label: Schema.optional(TrimmedNonEmptyString),
  email: Schema.optional(TrimmedNonEmptyString),
});
```

- [ ] **Step 3: Add WS subscription RPC to rpc.ts**

Add to `WS_METHODS`:

```ts
// Streaming subscriptions
subscribeOrchestrationDomainEvents: "subscribeOrchestrationDomainEvents",
subscribeTerminalEvents: "subscribeTerminalEvents",
subscribeServerConfig: "subscribeServerConfig",
subscribeServerLifecycle: "subscribeServerLifecycle",
subscribeProviderAccountStats: "subscribeProviderAccountStats",  // NEW
```

Add the RPC definition after `WsSubscribeServerLifecycleRpc`:

```ts
import { ProviderAccountStatsEvent } from "./providerAccountStats";

export const WsSubscribeProviderAccountStatsRpc = Rpc.make(
  WS_METHODS.subscribeProviderAccountStats,
  {
    payload: Schema.Struct({}),
    success: ProviderAccountStatsEvent,
    stream: true,
  },
);
```

Add to `WsRpcGroup`:

```ts
export const WsRpcGroup = RpcGroup.make(
  // ... existing entries ...
  WsSubscribeProviderAccountStatsRpc,
);
```

- [ ] **Step 4: Re-export from contracts index**

In `packages/contracts/src/index.ts`, add:

```ts
export * from "./providerAccountStats";
```

- [ ] **Step 5: Run typecheck**

Run: `cd packages/contracts && bun run typecheck`
Expected: PASS — no type errors

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/providerAccountStats.ts packages/contracts/src/server.ts packages/contracts/src/rpc.ts packages/contracts/src/index.ts
git commit -m "feat: add provider account stats contracts and WS subscription RPC"
```

---

### Task 2: Server-Side Normalization Functions

**Files:**

- Create: `apps/server/src/provider/providerAccountStatsNormalization.ts`
- Create: `apps/server/src/provider/providerAccountStatsNormalization.test.ts`

- [ ] **Step 1: Write failing tests for Claude rate limit normalization**

```ts
// apps/server/src/provider/providerAccountStatsNormalization.test.ts
import { describe, it, assert } from "@effect/vitest";
import {
  normalizeClaudeRateLimits,
  normalizeCodexRateLimits,
} from "./providerAccountStatsNormalization";

describe("normalizeClaudeRateLimits", () => {
  it("normalizes a five_hour rate limit event", () => {
    const raw = {
      type: "rate_limit_event" as const,
      rate_limit_info: {
        status: "allowed" as const,
        rateLimitType: "five_hour" as const,
        utilization: 0.15,
        resetsAt: Math.floor(Date.now() / 1000) + 3600 * 4,
      },
      uuid: "test-uuid",
      session_id: "test-session",
    };
    const result = normalizeClaudeRateLimits(raw);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.name, "Session");
    assert.equal(result[0]!.percentUsed, 15);
    assert.ok(result[0]!.resetsInMs! > 0);
    assert.ok(result[0]!.resetsAtIso);
  });

  it("normalizes a seven_day rate limit event", () => {
    const raw = {
      type: "rate_limit_event" as const,
      rate_limit_info: {
        status: "allowed_warning" as const,
        rateLimitType: "seven_day" as const,
        utilization: 0.31,
        resetsAt: Math.floor(Date.now() / 1000) + 3600 * 24 * 3,
      },
      uuid: "test-uuid",
      session_id: "test-session",
    };
    const result = normalizeClaudeRateLimits(raw);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.name, "Weekly");
    assert.equal(result[0]!.percentUsed, 31);
  });

  it("normalizes seven_day_sonnet to model-specific quota", () => {
    const raw = {
      type: "rate_limit_event" as const,
      rate_limit_info: {
        status: "allowed" as const,
        rateLimitType: "seven_day_sonnet" as const,
        utilization: 0.03,
        resetsAt: Math.floor(Date.now() / 1000) + 3600 * 24 * 5,
      },
      uuid: "test-uuid",
      session_id: "test-session",
    };
    const result = normalizeClaudeRateLimits(raw);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.name, "Sonnet");
    assert.equal(result[0]!.percentUsed, 3);
  });

  it("normalizes seven_day_opus to model-specific quota", () => {
    const raw = {
      type: "rate_limit_event" as const,
      rate_limit_info: {
        status: "allowed" as const,
        rateLimitType: "seven_day_opus" as const,
        utilization: 0.5,
      },
      uuid: "test-uuid",
      session_id: "test-session",
    };
    const result = normalizeClaudeRateLimits(raw);
    assert.equal(result[0]!.name, "Opus");
    assert.equal(result[0]!.percentUsed, 50);
  });

  it("returns empty array for unknown payload shape", () => {
    const result = normalizeClaudeRateLimits({ unexpected: true });
    assert.equal(result.length, 0);
  });

  it("handles missing utilization gracefully", () => {
    const raw = {
      type: "rate_limit_event" as const,
      rate_limit_info: {
        status: "allowed" as const,
        rateLimitType: "five_hour" as const,
      },
      uuid: "test-uuid",
      session_id: "test-session",
    };
    const result = normalizeClaudeRateLimits(raw);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.percentUsed, 0);
  });
});

describe("normalizeCodexRateLimits", () => {
  it("returns empty array for unknown payload", () => {
    const result = normalizeCodexRateLimits({ unknown: true });
    assert.equal(result.length, 0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/server && bunx vitest run src/provider/providerAccountStatsNormalization.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement normalization functions**

```ts
// apps/server/src/provider/providerAccountStatsNormalization.ts
import type { ProviderQuota } from "@codewithme/contracts";

// ── Helpers ────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// ── Claude ─────────────────────────────────────────────────────────

const CLAUDE_RATE_LIMIT_TYPE_LABELS: Record<string, string> = {
  five_hour: "Session",
  seven_day: "Weekly",
  seven_day_opus: "Opus",
  seven_day_sonnet: "Sonnet",
  overage: "Overage",
};

export function normalizeClaudeRateLimits(raw: unknown): ProviderQuota[] {
  const record = asRecord(raw);
  if (!record) return [];

  const info = asRecord(record.rate_limit_info);
  if (!info) return [];

  const rateLimitType = asString(info.rateLimitType);
  const name = (rateLimitType && CLAUDE_RATE_LIMIT_TYPE_LABELS[rateLimitType]) ?? "Unknown";
  const utilization = asNumber(info.utilization);
  const percentUsed = utilization !== null ? Math.round(utilization * 100) : 0;

  const resetsAtEpoch = asNumber(info.resetsAt);
  const resetsAtIso =
    resetsAtEpoch !== null ? new Date(resetsAtEpoch * 1000).toISOString() : undefined;
  const resetsInMs =
    resetsAtEpoch !== null ? Math.max(0, resetsAtEpoch * 1000 - Date.now()) : undefined;

  return [
    {
      name,
      percentUsed,
      ...(resetsAtIso ? { resetsAtIso } : {}),
      ...(resetsInMs !== undefined ? { resetsInMs } : {}),
    },
  ];
}

// ── Codex ──────────────────────────────────────────────────────────

export function normalizeCodexRateLimits(raw: unknown): ProviderQuota[] {
  // Codex payload structure is undocumented.
  // Log and return empty until we observe real payloads.
  const record = asRecord(raw);
  if (!record) return [];

  // Best-effort: look for common patterns
  const quotas: ProviderQuota[] = [];

  // Check for array-style quotas
  if (Array.isArray(record.rateLimits)) {
    for (const entry of record.rateLimits) {
      const item = asRecord(entry);
      if (!item) continue;
      const name = asString(item.name) ?? asString(item.type) ?? "Unknown";
      const utilization = asNumber(item.utilization) ?? asNumber(item.percentUsed);
      const percentUsed =
        utilization !== null
          ? utilization <= 1
            ? Math.round(utilization * 100)
            : Math.round(utilization)
          : 0;
      quotas.push({ name, percentUsed });
    }
  }

  return quotas;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/server && bunx vitest run src/provider/providerAccountStatsNormalization.test.ts`
Expected: PASS — all tests green

- [ ] **Step 5: Run lint + typecheck**

Run: `bun fmt && bun lint && cd apps/server && bun run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/provider/providerAccountStatsNormalization.ts apps/server/src/provider/providerAccountStatsNormalization.test.ts
git commit -m "feat: add provider rate-limit normalization functions with tests"
```

---

### Task 3: Server ProviderAccountStats Service + PubSub

**Files:**

- Create: `apps/server/src/provider/Services/ProviderAccountStats.ts`
- Create: `apps/server/src/provider/Layers/ProviderAccountStats.ts`

- [ ] **Step 1: Create the service interface**

```ts
// apps/server/src/provider/Services/ProviderAccountStats.ts
import type { ProviderAccountStatsSnapshot, ProviderKind } from "@codewithme/contracts";
import { Context, type Effect, type Stream } from "effect";

export interface ProviderAccountStatsShape {
  readonly publish: (snapshot: ProviderAccountStatsSnapshot) => Effect.Effect<void>;
  readonly streamUpdates: Stream.Stream<ProviderAccountStatsSnapshot>;
  readonly getLatest: (
    provider: ProviderKind,
  ) => Effect.Effect<ProviderAccountStatsSnapshot | null>;
}

export class ProviderAccountStatsService extends Context.Tag("ProviderAccountStatsService")<
  ProviderAccountStatsService,
  ProviderAccountStatsShape
>() {}
```

- [ ] **Step 2: Create the PubSub-backed implementation**

```ts
// apps/server/src/provider/Layers/ProviderAccountStats.ts
import type { ProviderAccountStatsSnapshot, ProviderKind } from "@codewithme/contracts";
import { Effect, Layer, PubSub, Ref, Stream } from "effect";
import { ProviderAccountStatsService } from "../Services/ProviderAccountStats";

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
    };
  }),
);
```

- [ ] **Step 3: Run typecheck**

Run: `cd apps/server && bun run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/provider/Services/ProviderAccountStats.ts apps/server/src/provider/Layers/ProviderAccountStats.ts
git commit -m "feat: add ProviderAccountStats service with PubSub-backed layer"
```

---

### Task 4: ProviderRuntimeIngestion — Handle Rate Limit + Account Events

**Files:**

- Modify: `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`

- [ ] **Step 1: Add imports**

At the top of `ProviderRuntimeIngestion.ts`, add:

```ts
import { ProviderAccountStatsService } from "../../provider/Services/ProviderAccountStats";
import {
  normalizeClaudeRateLimits,
  normalizeCodexRateLimits,
} from "../../provider/providerAccountStatsNormalization";
```

- [ ] **Step 2: Add ProviderAccountStatsService dependency + state tracking**

Inside the `makeProviderRuntimeIngestion` Effect.gen function (or equivalent factory), yield the new service and create a mutable cost accumulator:

```ts
const providerAccountStats = yield * ProviderAccountStatsService;

// Cost accumulation per provider
const sessionCostByProvider: Record<string, number> = {};
const sessionTokensByProvider: Record<string, number> = {};
// Merge incoming quotas with previously known quotas per provider
const latestQuotasByProvider: Record<
  string,
  Record<string, import("@codewithme/contracts").ProviderQuota>
> = {};
```

- [ ] **Step 3: Handle account.rate-limits.updated in processRuntimeEvent**

After the existing lifecycle/activity handling, add (before the function exits):

```ts
if (event.type === "account.rate-limits.updated") {
  const provider = event.provider;
  const rawLimits = (event.payload as { rateLimits?: unknown }).rateLimits;
  const newQuotas =
    provider === "claudeAgent"
      ? normalizeClaudeRateLimits(rawLimits)
      : normalizeCodexRateLimits(rawLimits);

  if (newQuotas.length > 0) {
    // Merge new quotas into existing ones by name
    const existing = latestQuotasByProvider[provider] ?? {};
    for (const quota of newQuotas) {
      existing[quota.name] = quota;
    }
    latestQuotasByProvider[provider] = existing;

    const latest = yield * providerAccountStats.getLatest(provider);
    yield *
      providerAccountStats.publish({
        provider,
        plan: latest?.plan,
        email: latest?.email,
        quotas: Object.values(existing),
        sessionCostUsd: sessionCostByProvider[provider],
        sessionTokensTotal: sessionTokensByProvider[provider],
        updatedAt: event.createdAt,
      });
  }
}

if (event.type === "account.updated") {
  const provider = event.provider;
  const payload = event.payload as { account?: Record<string, unknown> };
  const account = payload.account;
  const plan = typeof account?.subscriptionType === "string" ? account.subscriptionType : undefined;
  const email = typeof account?.email === "string" ? account.email : undefined;

  const latest = yield * providerAccountStats.getLatest(provider);
  yield *
    providerAccountStats.publish({
      provider,
      ...(plan ? { plan } : latest?.plan ? { plan: latest.plan } : {}),
      ...(email ? { email } : latest?.email ? { email: latest.email } : {}),
      quotas: latest?.quotas ?? Object.values(latestQuotasByProvider[provider] ?? {}),
      sessionCostUsd: sessionCostByProvider[provider],
      sessionTokensTotal: sessionTokensByProvider[provider],
      updatedAt: event.createdAt,
    });
}
```

- [ ] **Step 4: Accumulate cost from turn.completed**

In the existing `turn.completed` handling block, add cost accumulation:

```ts
if (event.type === "turn.completed") {
  const provider = event.provider;
  const turnCost = (event.payload as { totalCostUsd?: number }).totalCostUsd;
  if (typeof turnCost === "number" && Number.isFinite(turnCost)) {
    sessionCostByProvider[provider] = (sessionCostByProvider[provider] ?? 0) + turnCost;
  }

  // Accumulate total processed tokens from token usage
  const usage = (event.payload as { usage?: Record<string, unknown> }).usage;
  if (usage) {
    const totalTokens =
      (typeof usage.inputTokens === "number" ? usage.inputTokens : 0) +
      (typeof usage.outputTokens === "number" ? usage.outputTokens : 0);
    if (totalTokens > 0) {
      sessionTokensByProvider[provider] = (sessionTokensByProvider[provider] ?? 0) + totalTokens;
    }
  }

  // Publish updated stats if we have any quota data
  const existingQuotas = latestQuotasByProvider[provider];
  if (existingQuotas && Object.keys(existingQuotas).length > 0) {
    const latest = yield * providerAccountStats.getLatest(provider);
    yield *
      providerAccountStats.publish({
        provider,
        plan: latest?.plan,
        email: latest?.email,
        quotas: Object.values(existingQuotas),
        sessionCostUsd: sessionCostByProvider[provider],
        sessionTokensTotal: sessionTokensByProvider[provider],
        updatedAt: event.createdAt,
      });
  }
}
```

- [ ] **Step 5: Run typecheck**

Run: `cd apps/server && bun run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
git commit -m "feat: handle rate-limit and account events in runtime ingestion"
```

---

### Task 5: Server WebSocket Endpoint

**Files:**

- Modify: `apps/server/src/ws.ts`
- Modify: `apps/server/src/server.ts`

- [ ] **Step 1: Add WS subscription handler in ws.ts**

Following the `subscribeServerLifecycle` handler pattern, add:

```ts
import { ProviderAccountStatsService } from "./provider/Services/ProviderAccountStats";
import { ProviderAccountStatsEvent } from "@codewithme/contracts";

// Inside the handlers object:
[WS_METHODS.subscribeProviderAccountStats]: (_input) =>
  observeRpcStream(
    WS_METHODS.subscribeProviderAccountStats,
    Stream.map(
      providerAccountStats.streamUpdates,
      (snapshot): ProviderAccountStatsEvent => ({
        type: "provider.account-stats.updated",
        payload: snapshot,
      }),
    ),
    { "rpc.aggregate": "provider" },
  ),
```

Where `providerAccountStats` is yielded from `ProviderAccountStatsService` at the top of the WS handler setup (same pattern as `orchestrationEngine` or `terminalManager`).

- [ ] **Step 2: Wire ProviderAccountStatsLive layer in server.ts**

Add `ProviderAccountStatsLive` to the server's layer composition, alongside other provider layers:

```ts
import { ProviderAccountStatsLive } from "./provider/Layers/ProviderAccountStats";

// In the layer composition:
ProviderAccountStatsLive,
```

- [ ] **Step 3: Run typecheck**

Run: `bun typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/ws.ts apps/server/src/server.ts
git commit -m "feat: add WebSocket subscription endpoint for provider account stats"
```

---

### Task 6: Client — WsRpcClient + Atom Store

**Files:**

- Modify: `apps/web/src/wsRpcClient.ts`
- Create: `apps/web/src/rpc/providerAccountStats.ts`
- Modify: `apps/web/src/rpc/serverState.ts`

- [ ] **Step 1: Add subscription method to WsRpcClient**

In `apps/web/src/wsRpcClient.ts`:

Add to the `WsRpcClient` interface inside `server`:

```ts
readonly server: {
  // ... existing ...
  readonly subscribeProviderAccountStats: RpcStreamMethod<
    typeof WS_METHODS.subscribeProviderAccountStats
  >;
};
```

Add to the `createWsRpcClient` implementation inside `server`:

```ts
subscribeProviderAccountStats: (listener) =>
  transport.subscribe(
    (client) => client[WS_METHODS.subscribeProviderAccountStats]({}),
    listener,
  ),
```

- [ ] **Step 2: Create providerAccountStats atom store**

```ts
// apps/web/src/rpc/providerAccountStats.ts
import type { ProviderAccountStatsSnapshot, ProviderKind } from "@codewithme/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useAtomValue } from "@effect/atom-react";

import { appAtomRegistry } from "./atomRegistry";

const providerAccountStatsAtom = Atom.make<Readonly<Record<string, ProviderAccountStatsSnapshot>>>(
  {},
).pipe(Atom.keepAlive, Atom.withLabel("providerAccountStats"));
appAtomRegistry.register(providerAccountStatsAtom);

// Module-level cache to avoid needing Atom.get
let currentStats: Readonly<Record<string, ProviderAccountStatsSnapshot>> = {};

export function applyProviderAccountStatsUpdate(snapshot: ProviderAccountStatsSnapshot): void {
  currentStats = { ...currentStats, [snapshot.provider]: snapshot };
  Atom.set(providerAccountStatsAtom, currentStats);
}

const selectForProvider =
  (provider: ProviderKind) =>
  (
    record: Readonly<Record<string, ProviderAccountStatsSnapshot>>,
  ): ProviderAccountStatsSnapshot | null =>
    record[provider] ?? null;

export function useProviderAccountStats(
  provider: ProviderKind,
): ProviderAccountStatsSnapshot | null {
  return useAtomValue(providerAccountStatsAtom, selectForProvider(provider));
}

export function resetProviderAccountStatsForTests(): void {
  currentStats = {};
  Atom.set(providerAccountStatsAtom, currentStats);
}
```

- [ ] **Step 3: Wire subscription into startServerStateSync**

In `apps/web/src/rpc/serverState.ts`:

Add import:

```ts
import { applyProviderAccountStatsUpdate } from "./providerAccountStats";
```

Extend `ServerStateClient` type:

```ts
type ServerStateClient = Pick<
  WsRpcClient["server"],
  "getConfig" | "subscribeConfig" | "subscribeLifecycle" | "subscribeProviderAccountStats"
>;
```

Add subscription to the `cleanups` array in `startServerStateSync`:

```ts
const cleanups = [
  // ... existing subscriptions ...
  client.subscribeProviderAccountStats((event) => {
    applyProviderAccountStatsUpdate(event.payload);
  }),
];
```

- [ ] **Step 4: Run typecheck**

Run: `bun typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/wsRpcClient.ts apps/web/src/rpc/providerAccountStats.ts apps/web/src/rpc/serverState.ts
git commit -m "feat: add client-side provider account stats subscription and atom store"
```

---

### Task 7: QuotaBar Component

**Files:**

- Create: `apps/web/src/components/chat/QuotaBar.tsx`

- [ ] **Step 1: Create QuotaBar component**

```tsx
// apps/web/src/components/chat/QuotaBar.tsx
import { cn } from "~/lib/utils";

export function formatResetCountdown(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return null;
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function barColor(percentUsed: number): string {
  if (percentUsed >= 90) return "bg-red-500";
  if (percentUsed >= 70) return "bg-orange-400";
  if (percentUsed >= 50) return "bg-yellow-400";
  return "bg-emerald-400";
}

interface QuotaBarProps {
  readonly name: string;
  readonly percentUsed: number;
  readonly percentReserve?: number;
  readonly resetsInMs?: number;
}

export function QuotaBar({ name, percentUsed, percentReserve, resetsInMs }: QuotaBarProps) {
  const percentLeft = Math.max(0, 100 - percentUsed);
  const resetLabel = formatResetCountdown(resetsInMs);
  const clampedUsed = Math.max(0, Math.min(100, percentUsed));

  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-foreground">{name}</div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-300",
            barColor(clampedUsed),
          )}
          style={{ width: `${clampedUsed}%` }}
        />
      </div>
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <div className="flex gap-2">
          <span>{percentLeft}% left</span>
          {percentReserve !== undefined && percentReserve > 0 ? (
            <span>{percentReserve}% in reserve</span>
          ) : null}
        </div>
        {resetLabel ? <span>Resets in {resetLabel}</span> : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run lint + fmt**

Run: `bun fmt && bun lint`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/chat/QuotaBar.tsx
git commit -m "feat: add QuotaBar component for provider usage visualization"
```

---

### Task 8: ProviderStatsPopover Component

**Files:**

- Create: `apps/web/src/components/chat/ProviderStatsPopover.tsx`

- [ ] **Step 1: Create ProviderStatsPopover component**

```tsx
// apps/web/src/components/chat/ProviderStatsPopover.tsx
import type { ProviderAccountStatsSnapshot, ServerProvider } from "@codewithme/contracts";
import type { ContextWindowSnapshot } from "~/lib/contextWindow";
import { formatContextWindowTokens } from "~/lib/contextWindow";
import { QuotaBar } from "./QuotaBar";

function providerDisplayName(provider: string): string {
  if (provider === "claudeAgent") return "Claude";
  if (provider === "codex") return "Codex";
  return provider;
}

function planBadge(
  stats: ProviderAccountStatsSnapshot | null,
  serverProvider: ServerProvider | null,
): string | null {
  if (stats?.plan) {
    const normalized = stats.plan.toLowerCase().replace(/[\s_-]+/g, "");
    if (normalized === "max" || normalized === "maxplan") return "Max";
    if (normalized === "enterprise") return "Enterprise";
    if (normalized === "team") return "Team";
    if (normalized === "pro") return "Pro";
    if (normalized === "free") return "Free";
    return stats.plan;
  }
  // Fall back to auth type from server provider
  if (serverProvider?.auth.type) {
    const authType = serverProvider.auth.type.toLowerCase();
    if (authType === "apikey") return "API Key";
    return serverProvider.auth.type;
  }
  return null;
}

function formatRelativeTime(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  if (diffMs < 5000) return "just now";
  if (diffMs < 60_000) return `${Math.floor(diffMs / 1000)}s ago`;
  if (diffMs < 3600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  return `${Math.floor(diffMs / 3600_000)}h ago`;
}

function formatCost(usd: number): string {
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

interface ProviderStatsPopoverProps {
  readonly accountStats: ProviderAccountStatsSnapshot | null;
  readonly contextWindow: ContextWindowSnapshot | null;
  readonly serverProvider: ServerProvider | null;
}

export function ProviderStatsPopover({
  accountStats,
  contextWindow,
  serverProvider,
}: ProviderStatsPopoverProps) {
  const providerKind = accountStats?.provider ?? serverProvider?.provider ?? "codex";
  const displayName = providerDisplayName(providerKind);
  const plan = planBadge(accountStats, serverProvider);
  const email = accountStats?.email ?? serverProvider?.auth.email;
  const hasQuotas = accountStats && accountStats.quotas.length > 0;

  return (
    <div className="w-72 space-y-3 leading-tight">
      {/* Header */}
      <div>
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-foreground">{displayName}</span>
          {plan ? <span className="text-xs font-medium text-muted-foreground">{plan}</span> : null}
        </div>
        {email ? <div className="text-[11px] text-muted-foreground">{email}</div> : null}
        {accountStats?.updatedAt ? (
          <div className="text-[11px] text-muted-foreground">
            Updated {formatRelativeTime(accountStats.updatedAt)}
          </div>
        ) : null}
      </div>

      {/* Quota bars */}
      {hasQuotas ? (
        <div className="space-y-2.5 border-t border-border pt-2.5">
          {accountStats.quotas.map((quota) => (
            <QuotaBar
              key={quota.name}
              name={quota.name}
              percentUsed={quota.percentUsed}
              percentReserve={quota.percentReserve}
              resetsInMs={quota.resetsInMs}
            />
          ))}
        </div>
      ) : null}

      {/* Context window */}
      {contextWindow ? (
        <div className="space-y-1 border-t border-border pt-2.5">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Context window
          </div>
          <div className="text-xs text-foreground">
            {contextWindow.usedPercentage !== null ? (
              <>
                <span>{Math.round(contextWindow.usedPercentage)}%</span>
                <span className="mx-1">·</span>
              </>
            ) : null}
            <span>{formatContextWindowTokens(contextWindow.usedTokens)}</span>
            {contextWindow.maxTokens !== null ? (
              <>
                <span>/</span>
                <span>{formatContextWindowTokens(contextWindow.maxTokens)} used</span>
              </>
            ) : (
              <span> tokens used</span>
            )}
          </div>
          {contextWindow.inputTokens !== null ||
          contextWindow.outputTokens !== null ||
          contextWindow.cachedInputTokens !== null ? (
            <div className="text-[11px] text-muted-foreground">
              {contextWindow.inputTokens !== null ? (
                <span>In: {formatContextWindowTokens(contextWindow.inputTokens)}</span>
              ) : null}
              {contextWindow.outputTokens !== null ? (
                <>
                  <span className="mx-1">·</span>
                  <span>Out: {formatContextWindowTokens(contextWindow.outputTokens)}</span>
                </>
              ) : null}
              {contextWindow.cachedInputTokens !== null ? (
                <>
                  <span className="mx-1">·</span>
                  <span>Cache: {formatContextWindowTokens(contextWindow.cachedInputTokens)}</span>
                </>
              ) : null}
            </div>
          ) : null}
          {contextWindow.compactsAutomatically ? (
            <div className="text-[11px] text-muted-foreground">Auto-compacts when needed</div>
          ) : null}
        </div>
      ) : null}

      {/* Session cost */}
      {accountStats?.sessionCostUsd !== undefined && accountStats.sessionCostUsd > 0 ? (
        <div className="space-y-1 border-t border-border pt-2.5">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Session cost
          </div>
          <div className="text-xs text-foreground">
            <span>{formatCost(accountStats.sessionCostUsd)}</span>
            {accountStats.sessionTokensTotal !== undefined &&
            accountStats.sessionTokensTotal > 0 ? (
              <>
                <span className="mx-1">·</span>
                <span>{formatContextWindowTokens(accountStats.sessionTokensTotal)} tokens</span>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 2: Run lint + fmt**

Run: `bun fmt && bun lint`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/chat/ProviderStatsPopover.tsx
git commit -m "feat: add ProviderStatsPopover component with quota bars, context window, and cost"
```

---

### Task 9: Integrate Popover into ContextWindowMeter

**Files:**

- Modify: `apps/web/src/components/chat/ContextWindowMeter.tsx`
- Modify: `apps/web/src/components/ChatView.tsx`

- [ ] **Step 1: Update ContextWindowMeter to accept new props and use ProviderStatsPopover**

Replace the popover content in `ContextWindowMeter.tsx`:

```tsx
// apps/web/src/components/chat/ContextWindowMeter.tsx
import { cn } from "~/lib/utils";
import type { ServerProvider } from "@codewithme/contracts";
import type { ProviderAccountStatsSnapshot } from "@codewithme/contracts";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ProviderStatsPopover } from "./ProviderStatsPopover";

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

interface ContextWindowMeterProps {
  readonly usage: ContextWindowSnapshot;
  readonly accountStats?: ProviderAccountStatsSnapshot | null;
  readonly serverProvider?: ServerProvider | null;
}

export function ContextWindowMeter(props: ContextWindowMeterProps) {
  const { usage, accountStats, serverProvider } = props;
  const usedPercentage = formatPercentage(usage.usedPercentage);
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (normalizedPercentage / 100) * circumference;

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            className="group inline-flex items-center justify-center rounded-full transition-opacity hover:opacity-85"
            aria-label={
              usage.maxTokens !== null && usedPercentage
                ? `Context window ${usedPercentage} used`
                : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
            }
          >
            <span className="relative flex h-6 w-6 items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 h-full w-full transform-gpu"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke="color-mix(in oklab, var(--color-muted) 70%, transparent)"
                  strokeWidth="3"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke="var(--color-muted-foreground)"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
                />
              </svg>
              <span
                className={cn(
                  "relative flex h-[15px] w-[15px] items-center justify-center rounded-full bg-background text-[8px] font-medium",
                  "text-muted-foreground",
                )}
              >
                {usage.usedPercentage !== null
                  ? Math.round(usage.usedPercentage)
                  : formatContextWindowTokens(usage.usedTokens)}
              </span>
            </span>
          </button>
        }
      />
      <PopoverPopup tooltipStyle side="top" align="end" className="w-max max-w-none px-3 py-2">
        <ProviderStatsPopover
          accountStats={accountStats ?? null}
          contextWindow={usage}
          serverProvider={serverProvider ?? null}
        />
      </PopoverPopup>
    </Popover>
  );
}
```

- [ ] **Step 2: Pass new props from ChatView.tsx**

In `apps/web/src/components/ChatView.tsx`, add imports:

```ts
import { useProviderAccountStats } from "../rpc/providerAccountStats";
import { useServerProviders } from "../rpc/serverState";
import { getProviderSnapshot } from "../providerModels";
```

In the component body, derive the active provider kind from the thread's model selection, then use the hook:

```ts
const providers = useServerProviders();
const activeProviderKind = activeThread?.modelSelection?.provider ?? "codex";
const activeServerProvider = getProviderSnapshot(providers, activeProviderKind) ?? null;
const activeAccountStats = useProviderAccountStats(activeProviderKind);
```

Update the JSX where `ContextWindowMeter` is rendered:

```tsx
{
  activeContextWindow ? (
    <ContextWindowMeter
      usage={activeContextWindow}
      accountStats={activeAccountStats}
      serverProvider={activeServerProvider}
    />
  ) : null;
}
```

- [ ] **Step 3: Run typecheck + lint + fmt**

Run: `bun fmt && bun lint && bun typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/chat/ContextWindowMeter.tsx apps/web/src/components/ChatView.tsx
git commit -m "feat: integrate provider stats popover into ContextWindowMeter"
```

---

### Task 10: Extract Email in Provider Auth Probes

**Files:**

- Modify: `apps/server/src/provider/Layers/ClaudeProvider.ts`

- [ ] **Step 1: Extract email from Claude auth probe**

In `ClaudeProvider.ts`, find the `probeClaudeCapabilities` function. It already calls `initializationResult().account`. Extend it to also return email:

```ts
// In probeClaudeCapabilities return:
return { subscriptionType: init.account?.subscriptionType, email: init.account?.email };
```

Then in `checkClaudeProviderStatus`, pass the email through to `ServerProviderAuth`:

```ts
const authMetadata = claudeAuthMetadata({ subscriptionType, authMethod });
// After building authMetadata:
const email = sdkProbeResult?.email;
// Include in ServerProviderAuth:
auth: {
  status: "authenticated",
  ...(authMetadata ?? {}),
  ...(email ? { email } : {}),
},
```

- [ ] **Step 2: Also try to extract email from `claude auth status` JSON output**

Add to the existing JSON parsing logic that walks the auth status output. Add a new walker function:

```ts
function extractEmailFromOutput(output: string): string | undefined {
  try {
    const parsed = JSON.parse(output);
    const walker = (obj: Record<string, unknown>): string | undefined => {
      for (const key of ["email", "user_email", "userEmail"]) {
        if (typeof obj[key] === "string" && obj[key].includes("@")) return obj[key] as string;
      }
      for (const key of ["account", "user", "session"]) {
        const nested = obj[key];
        if (nested && typeof nested === "object") {
          const result = walker(nested as Record<string, unknown>);
          if (result) return result;
        }
      }
      return undefined;
    };
    return walker(parsed);
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 3: Run typecheck**

Run: `cd apps/server && bun run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/provider/Layers/ClaudeProvider.ts
git commit -m "feat: extract email from Claude auth probe for provider stats"
```

---

### Task 11: Final Verification

- [ ] **Step 1: Run full typecheck**

Run: `bun typecheck`
Expected: PASS across all workspaces

- [ ] **Step 2: Run full lint + format**

Run: `bun fmt && bun lint`
Expected: PASS — no warnings/errors

- [ ] **Step 3: Run tests**

Run: `bun run test`
Expected: PASS — including the new normalization tests

- [ ] **Step 4: Manual verification**

Start the dev server and trigger a provider session. Hover over the ContextWindowMeter to verify:

1. Provider name + plan badge appear in the popover header
2. Email shows if available
3. Quota bars appear after rate-limit events arrive
4. Context window section shows token usage
5. Cost section shows after turn completion
6. Graceful degradation when no quota data available (only context window shown)

- [ ] **Step 5: Final commit if any fixups needed**

```bash
git add -A
git commit -m "fix: address lint/type issues from provider stats integration"
```
