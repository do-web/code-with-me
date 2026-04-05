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

function normalizePercent(value: number | null): number | undefined {
  if (value === null) return undefined;
  return value <= 1 ? Math.round(value * 100) : Math.round(value);
}

function resolveResetFields(
  value: Record<string, unknown>,
): Pick<ProviderQuota, "resetsAtIso" | "resetsInMs"> {
  const epochCandidate =
    asNumber(value.resetsAt) ??
    asNumber(value.resetAt) ??
    asNumber(value.resetsAtEpoch) ??
    asNumber(value.resetAtEpoch);
  const millisCandidate =
    asNumber(value.resetsAtMs) ?? asNumber(value.resetAtMs) ?? asNumber(value.resetInMs);
  const isoCandidate =
    asString(value.resetsAtIso) ??
    asString(value.resetAtIso) ??
    asString(value.resetsAt) ??
    asString(value.resetAt);

  if (epochCandidate !== null) {
    const epochMs = epochCandidate > 10_000_000_000 ? epochCandidate : epochCandidate * 1000;
    return {
      resetsAtIso: new Date(epochMs).toISOString(),
      resetsInMs: Math.max(0, epochMs - Date.now()),
    };
  }

  if (millisCandidate !== null) {
    const epochMs =
      millisCandidate > 10_000_000_000
        ? millisCandidate
        : Date.now() + Math.max(0, millisCandidate);
    return {
      resetsAtIso: new Date(epochMs).toISOString(),
      resetsInMs: Math.max(0, epochMs - Date.now()),
    };
  }

  if (isoCandidate) {
    const epochMs = Date.parse(isoCandidate);
    if (Number.isFinite(epochMs)) {
      return {
        resetsAtIso: new Date(epochMs).toISOString(),
        resetsInMs: Math.max(0, epochMs - Date.now()),
      };
    }
  }

  return {};
}

function formatCodexWindowName(durationMins: number | null, slot: "primary" | "secondary"): string {
  if (durationMins === 300) return "5h limit";
  if (durationMins === 10080) return "Weekly limit";
  if (durationMins === 1440) return "Daily limit";
  if (durationMins !== null && durationMins > 0) {
    if (durationMins % 1440 === 0) {
      const days = durationMins / 1440;
      return `${days}d limit`;
    }
    if (durationMins % 60 === 0) {
      const hours = durationMins / 60;
      return `${hours}h limit`;
    }
    return `${durationMins}m limit`;
  }
  return slot === "primary" ? "Primary limit" : "Secondary limit";
}

function normalizeCodexRateLimitSnapshot(raw: unknown): ProviderQuota[] {
  const snapshot = asRecord(raw);
  if (!snapshot) return [];

  const primary = asRecord(snapshot.primary);
  const secondary = asRecord(snapshot.secondary);
  if (!primary && !secondary) return [];

  const quotas: ProviderQuota[] = [];
  if (primary) {
    quotas.push({
      name: formatCodexWindowName(asNumber(primary.windowDurationMins), "primary"),
      percentUsed: normalizePercent(asNumber(primary.usedPercent)) ?? 0,
      ...resolveResetFields(primary),
    });
  }
  if (secondary) {
    quotas.push({
      name: formatCodexWindowName(asNumber(secondary.windowDurationMins), "secondary"),
      percentUsed: normalizePercent(asNumber(secondary.usedPercent)) ?? 0,
      ...resolveResetFields(secondary),
    });
  }
  return quotas;
}

const CLAUDE_RATE_LIMIT_TYPE_LABELS: Record<string, string> = {
  five_hour: "Session",
  seven_day: "Weekly",
  seven_day_opus: "Opus",
  seven_day_sonnet: "Sonnet",
  overage: "Overage",
};

// Claude SDK's rate_limit_info.status → rough percentUsed.
// "utilization" field is preferred but often not sent by the server.
function statusToPercentUsed(status: string | null): number {
  if (status === "rejected") return 100;
  if (status === "allowed_warning") return 75;
  return -1; // -1 = unknown, let the UI decide how to display
}

export function normalizeClaudeRateLimits(raw: unknown): ProviderQuota[] {
  const record = asRecord(raw);
  if (!record) return [];

  const info = asRecord(record.rate_limit_info);
  if (!info) return [];

  const rateLimitType = asString(info.rateLimitType);
  const name = (rateLimitType && CLAUDE_RATE_LIMIT_TYPE_LABELS[rateLimitType]) ?? "Unknown";
  const utilization = asNumber(info.utilization);
  const status = asString(info.status);

  const percentUsed =
    utilization !== null ? parseFloat((utilization * 100).toFixed(1)) : statusToPercentUsed(status);

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
  const directSnapshots = record
    ? [
        ...(asRecord(record.rateLimits) ? [record.rateLimits] : []),
        ...(!asRecord(record.rateLimits) && asRecord(record.rateLimitsByLimitId)
          ? Object.values(record.rateLimitsByLimitId as Record<string, unknown>)
          : []),
      ]
    : [];
  if (directSnapshots.length > 0) {
    const normalized = directSnapshots.flatMap((snapshot) =>
      normalizeCodexRateLimitSnapshot(snapshot),
    );
    if (normalized.length > 0) {
      return normalized;
    }
  }

  const entries = Array.isArray(raw)
    ? raw
    : Array.isArray(record?.rateLimits)
      ? (record?.rateLimits as unknown[])
      : record
        ? [raw]
        : [];
  const quotas: ProviderQuota[] = [];
  for (const entry of entries) {
    const item = asRecord(entry);
    if (!item) continue;
    const name = asString(item.name) ?? asString(item.type) ?? asString(item.window) ?? "Unknown";
    const percentUsed = normalizePercent(
      asNumber(item.utilization) ??
        asNumber(item.percentUsed) ??
        asNumber(item.usedPercent) ??
        asNumber(item.usagePercent),
    );
    const percentReserve = normalizePercent(
      asNumber(item.percentReserve) ??
        asNumber(item.reservePercent) ??
        asNumber(item.reserve_percentage),
    );
    quotas.push({
      name,
      percentUsed: percentUsed ?? 0,
      ...(percentReserve !== undefined ? { percentReserve } : {}),
      ...resolveResetFields(item),
    });
  }

  return quotas;
}
