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
                <span className="mx-1">&middot;</span>
              </>
            ) : null}
            <span>{formatContextWindowTokens(contextWindow.usedTokens)}</span>
            {contextWindow.maxTokens !== null ? (
              <>
                <span>/</span>
                <span>{formatContextWindowTokens(contextWindow.maxTokens ?? null)} used</span>
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
                <span>In: {formatContextWindowTokens(contextWindow.inputTokens ?? null)}</span>
              ) : null}
              {contextWindow.outputTokens !== null ? (
                <>
                  <span className="mx-1">&middot;</span>
                  <span>Out: {formatContextWindowTokens(contextWindow.outputTokens ?? null)}</span>
                </>
              ) : null}
              {contextWindow.cachedInputTokens !== null ? (
                <>
                  <span className="mx-1">&middot;</span>
                  <span>
                    Cache: {formatContextWindowTokens(contextWindow.cachedInputTokens ?? null)}
                  </span>
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
                <span className="mx-1">&middot;</span>
                <span>
                  {formatContextWindowTokens(accountStats.sessionTokensTotal ?? null)} tokens
                </span>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
