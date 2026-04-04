import type { ProviderQuota } from "@codewithme/contracts";

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

export function normalizeCodexRateLimits(raw: unknown): ProviderQuota[] {
  const record = asRecord(raw);
  if (!record) return [];

  const quotas: ProviderQuota[] = [];
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
