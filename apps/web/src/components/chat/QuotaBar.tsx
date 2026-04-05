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

function statusLabel(percentUsed: number): { text: string; color: string } {
  if (percentUsed === 100) return { text: "Rate limited", color: "text-red-400" };
  if (percentUsed >= 70) return { text: "Warning", color: "text-orange-400" };
  return { text: "OK", color: "text-emerald-400" };
}

interface QuotaBarProps {
  readonly name: string;
  readonly percentUsed: number;
  readonly percentReserve?: number | undefined;
  readonly resetsInMs?: number | undefined;
}

export function QuotaBar({ name, percentUsed, percentReserve, resetsInMs }: QuotaBarProps) {
  const resetLabel = formatResetCountdown(resetsInMs);
  const hasRealPercentage = percentUsed >= 0;
  const clampedUsed = Math.max(0, Math.min(100, hasRealPercentage ? percentUsed : 0));

  // percentUsed === -1 means unknown (no utilization from SDK)
  if (!hasRealPercentage) {
    const status = statusLabel(percentUsed === -1 ? 0 : percentUsed);
    return (
      <div className="space-y-0.5">
        <div className="text-xs font-medium text-foreground">{name}</div>
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span className={status.color}>{status.text}</span>
          {resetLabel ? <span>Resets in {resetLabel}</span> : null}
        </div>
      </div>
    );
  }

  const percentLeft = Math.max(0, 100 - percentUsed);

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
          <span>{Math.round(percentLeft)}% left</span>
          {percentReserve !== undefined && percentReserve > 0 ? (
            <span>{percentReserve}% in reserve</span>
          ) : null}
        </div>
        {resetLabel ? <span>Resets in {resetLabel}</span> : null}
      </div>
    </div>
  );
}
