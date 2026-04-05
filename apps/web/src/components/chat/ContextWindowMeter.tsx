import type { ProviderAccountStatsSnapshot, ServerProvider } from "@codewithme/contracts";
import { cn } from "~/lib/utils";
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
  readonly usage?: ContextWindowSnapshot | null;
  readonly accountStats?: ProviderAccountStatsSnapshot | null;
  readonly serverProvider?: ServerProvider | null;
}

export function ContextWindowMeter({
  usage,
  accountStats,
  serverProvider,
}: ContextWindowMeterProps) {
  const fallbackQuota =
    accountStats?.quotas.find((entry) => entry.percentUsed >= 0) ?? accountStats?.quotas[0] ?? null;
  const displayPercentage = usage?.usedPercentage ?? fallbackQuota?.percentUsed ?? null;
  const usedPercentage = formatPercentage(displayPercentage);
  const normalizedPercentage = Math.max(0, Math.min(100, displayPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (normalizedPercentage / 100) * circumference;
  const centerLabel = usage
    ? usage.usedPercentage !== null
      ? Math.round(usage.usedPercentage).toString()
      : formatContextWindowTokens(usage.usedTokens)
    : fallbackQuota && fallbackQuota.percentUsed >= 0
      ? Math.round(fallbackQuota.percentUsed).toString()
      : "?";
  const ariaLabel = usage
    ? usage.maxTokens !== null && usedPercentage
      ? `Context window ${usedPercentage} used`
      : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
    : fallbackQuota && usedPercentage
      ? `${fallbackQuota.name} ${usedPercentage} used`
      : "Provider usage";

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={0}
        closeDelay={0}
        render={
          <button
            type="button"
            className="group inline-flex items-center justify-center rounded-full transition-opacity hover:opacity-85"
            aria-label={ariaLabel}
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
                {centerLabel}
              </span>
            </span>
          </button>
        }
      />
      <PopoverPopup tooltipStyle side="top" align="end" className="w-max max-w-none px-3 py-2">
        <ProviderStatsPopover
          accountStats={accountStats ?? null}
          contextWindow={usage ?? null}
          serverProvider={serverProvider ?? null}
        />
      </PopoverPopup>
    </Popover>
  );
}
