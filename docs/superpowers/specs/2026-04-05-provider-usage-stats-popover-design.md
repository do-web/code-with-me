# Provider Usage Stats Popover

## Problem

The ContextWindowMeter shows per-thread token usage but no account-level information: quota limits, reset countdowns, costs, or the logged-in user. Both provider adapters (Claude, Codex) already emit `account.updated` and `account.rate-limits.updated` runtime events, but the ingestion layer drops them — no data reaches the client.

## Goal

Extend the ContextWindowMeter hover popover to show provider-level account stats: quota bars with reset countdowns, session costs, and the authenticated user identity. Support both Claude and Codex providers with a unified, provider-agnostic UI.

## Data Sources

### Already emitted (server-side)

| Event                         | Source (Claude)                             | Source (Codex)                                     |
| ----------------------------- | ------------------------------------------- | -------------------------------------------------- |
| `account.rate-limits.updated` | `rate_limit_event` from Claude Agent SDK    | `account/rateLimits/updated` JSON-RPC notification |
| `account.updated`             | Not yet emitted (SDK init has account info) | `account/updated` JSON-RPC notification            |

### Already available (client-side)

- `ServerProvider.auth.label` — e.g. "Claude Max Subscription"
- `ServerProvider.auth.type` — e.g. "max", "apiKey"
- `ServerProvider.auth.status` — "authenticated" | "unauthenticated" | "unknown"
- `ContextWindowSnapshot` — per-thread token usage (usedTokens, maxTokens, input/output/cached breakdown)
- `TurnCompletedPayload.totalCostUsd` — per-turn cost

### Missing

- **Email/username** of logged-in account — needs extraction from provider auth probe
- **Quota data** — emitted but dropped by ingestion layer
- **Aggregated cost** — per-turn costs not accumulated anywhere

## Architecture

```
Provider SDK events (rate_limit_event, account/updated)
  ↓ already implemented in ClaudeAdapter / CodexAdapter
ProviderRuntimeEvent (type: "account.rate-limits.updated" | "account.updated")
  ↓ NEW: handle in ProviderRuntimeIngestion
  ↓ normalize raw payload → typed ProviderQuota[] / AccountInfo
  ↓ NEW: WebSocket push (provider-scoped channels, not thread activities)
Client Zustand store (new slice: providerAccountStats per ProviderKind)
  ↓ NEW: render
ContextWindowMeter popover (enhanced UI)
```

## Contract Changes (packages/contracts)

### Extend ServerProviderAuth

Add optional `email` field:

```ts
export const ServerProviderAuth = Schema.Struct({
  status: ServerProviderAuthStatus,
  type: Schema.optional(TrimmedNonEmptyString),
  label: Schema.optional(TrimmedNonEmptyString),
  email: Schema.optional(TrimmedNonEmptyString), // NEW
});
```

### Type the rate limits payload

Replace `Schema.Unknown` with a normalized, provider-agnostic schema:

```ts
const ProviderQuota = Schema.Struct({
  name: TrimmedNonEmptyString, // "session" | "weekly" | model slug
  percentUsed: Schema.Number, // 0-100
  percentReserve: Schema.optional(Schema.Number), // optional reserve %
  resetsAtIso: Schema.optional(TrimmedNonEmptyString), // ISO datetime
  resetsInMs: Schema.optional(Schema.Number), // ms until reset
});

const AccountRateLimitsUpdatedPayload = Schema.Struct({
  quotas: Schema.Array(ProviderQuota),
});
```

### Type the account updated payload

```ts
const AccountUpdatedPayload = Schema.Struct({
  provider: ProviderKind,
  plan: Schema.optional(TrimmedNonEmptyString),
  email: Schema.optional(TrimmedNonEmptyString),
});
```

### WebSocket push channels (not thread activities)

Account stats are provider-scoped, not thread-scoped — they don't belong in `OrchestrationThreadActivity`. Instead, use dedicated WebSocket push channels:

- `provider.quotas.updated` — carries normalized `ProviderQuota[]` + provider kind
- `provider.account.updated` — carries account identity (plan, email) + provider kind

These follow the existing push pattern used elsewhere in the WebSocket server.

## Server Changes (apps/server)

### ProviderRuntimeIngestion

Handle `account.rate-limits.updated` and `account.updated` events:

1. **Normalize** the raw provider payload into the typed schema above
2. **Publish** to a new PubSub topic or directly push via WebSocket

Normalization functions per provider:

- `normalizeClaudeRateLimits(rawMessage)` — parse Claude SDK's `rate_limit_event` into `ProviderQuota[]`
- `normalizeCodexRateLimits(rawPayload)` — parse Codex's `account/rateLimits/updated` into `ProviderQuota[]`
- `normalizeClaudeAccount(rawAccount)` — extract plan, email from Claude SDK account info
- `normalizeCodexAccount(rawPayload)` — extract plan, email from Codex account info

### ClaudeProvider / CodexProvider

Extract email during auth probe and include in `ServerProviderAuth.email`.

For Claude: parse from `claude auth status` JSON output or `initializationResult().account`.
For Codex: parse from `account/updated` event payload or login probe.

**Email precedence:** Static auth probe (at provider startup) provides the initial value. Runtime `account.updated` events override it if they carry a newer email — the client always shows the latest known value.

### Cost accumulation (in ProviderRuntimeIngestion)

Accumulate `totalCostUsd` from `turn.completed` events per provider session inside `ProviderRuntimeIngestion`. Store as an in-memory running total keyed by provider kind. Push the updated total to the client via `provider.quotas.updated` alongside quota data after each turn completion.

## Client Changes (apps/web)

### New: lib/providerAccountStats.ts

```ts
interface ProviderAccountStats {
  provider: "codex" | "claudeAgent";
  plan?: string;
  email?: string;
  quotas: ProviderQuota[];
  sessionCostUsd?: number;
  updatedAt: string;
}
```

Derive function to merge incoming WebSocket pushes into latest snapshot.

### Store integration

Add `providerAccountStats: Map<ProviderKind, ProviderAccountStats>` to the Zustand store (or a lightweight standalone store). Update on WebSocket push messages.

### Enhanced ContextWindowMeter popover

The existing popover content is replaced with a richer layout:

```
┌─────────────────────────────────────┐
│ Claude                          Max │
│ user@example.com                    │
│ Updated 12s ago                     │
│─────────────────────────────────────│
│ Session                             │
│ ████████████░░░░░  85% left         │
│                    Resets in 4h 2m   │
│                                     │
│ Weekly                              │
│ █████████░░░░░░░░  69% left         │
│ 16% in reserve     Resets in 3d 17h │
│                                     │
│ Sonnet                              │
│ ██████████████░░░  97% left         │
│                    Resets in 5d 10h  │
│─────────────────────────────────────│
│ Context Window                      │
│ 42% · 59k/128k used                │
│ In: 45k · Out: 14k · Cache: 8k     │
│ Auto-compacts when needed           │
│─────────────────────────────────────│
│ Session Cost                        │
│ $2.34 · 6.9M tokens                │
└─────────────────────────────────────┘
```

**Sections:**

1. **Header** — Provider name + plan badge + email + relative "updated" timestamp
2. **Quota bars** — One per quota entry. Progress bar with % left on the left, reset countdown on the right. Reserve shown if present. Color gradient: green → yellow → orange → red as usage increases.
3. **Context window** — Existing ContextWindowMeter data, reformatted into the new layout. Token breakdown (input/output/cached).
4. **Session cost** — Accumulated cost for the current provider session, if available.

**When no quota data is available** (e.g. provider hasn't sent rate limit events yet), only the context window section and available provider info are shown — graceful degradation.

### Popover sizing

- Fixed width (~320px) to accommodate progress bars and labels
- Max height with scroll if many quota entries
- Same trigger behavior (hover with 150ms delay)

## Normalization Strategy

Raw rate limit payloads differ between providers. Normalization happens server-side before forwarding to the client.

**Claude `rate_limit_event`** — Exact structure not documented by Anthropic. Implementation step 1 is to log the raw payload and build normalization from observed data. Expected fields based on CodexBar analysis: session window, weekly window, model-specific windows with percentage and reset timestamps.

**Codex `account/rateLimits/updated`** — Exact structure not documented by OpenAI. Same approach: log first, normalize iteratively. The Codex app-server JSON-RPC payload is already forwarded as-is in `CodexAdapter.ts:1179`.

**Fallback:** If the raw payload doesn't match expected structure, forward it as a single "unknown" quota with whatever percentage/reset info can be extracted. Log a warning for debugging.

## Risks & Mitigations

| Risk                                                   | Mitigation                                                       |
| ------------------------------------------------------ | ---------------------------------------------------------------- |
| Raw rate limit payload structure unknown               | Log raw payloads first, implement normalization iteratively      |
| Email not available from all auth methods              | Show email only when present, fall back to plan label only       |
| Rate limit events not emitted by all provider versions | Graceful degradation — show only context window if no quota data |
| Frequent updates causing re-renders                    | Debounce store updates, memoize derived state                    |

## Out of Scope

- 30-day cost history (requires persistent storage)
- Rate limit notifications/alerts
- Multiple account support
- Provider-specific settings in the popover
