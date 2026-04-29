import { createRequire } from "node:module";

import type { ProviderQuota } from "@codewithme/contracts";
import { stripAnsi } from "@codewithme/shared/ansi";
import { Effect } from "effect";

import * as ChildProcessRegistry from "../childProcessRegistry.ts";

// ── Output parsing ──────────────────────────────────────────────────
//
// Expected `/usage` output lines:
//   Current session    █████████  42%usedResets in 5m (Europe/Berlin)
//   Current week (all models)█████  35%usedResets Apr 8 at 6pm (Europe/Berlin)
//   Current week (Sonnet only)█  3%usedResets Apr 10 at 11am (Europe/Berlin)

interface ParsedUsageLine {
  label: string;
  percentUsed: number;
  resetsText: string | null;
}

const USAGE_LINE_RE = /(\d+(?:\.\d+)?)\s*%\s*used/i;
const RESETS_RE = /Resets?\s+(.*?)(?:\s*\(|$)/i;

function parseUsageLines(rawOutput: string): ParsedUsageLine[] {
  const clean = stripAnsi(rawOutput);
  const results: ParsedUsageLine[] = [];

  // Split into logical segments by looking for "% used"
  const segments = clean.split(/(?=Current\s)/i).filter((s) => USAGE_LINE_RE.test(s));

  for (const segment of segments) {
    const percentMatch = segment.match(USAGE_LINE_RE);
    if (!percentMatch) continue;

    const percentUsed = parseFloat(percentMatch[1]!);

    // Determine the label.
    // Order matters: model-specific markers (Opus/Sonnet) win over the
    // generic "week" check, otherwise a "Current week (Opus only)" segment
    // would be mislabelled as "Weekly" and collide with the all-models row.
    const lowerSegment = segment.toLowerCase();
    let label: string;
    if (lowerSegment.includes("opus")) {
      label = "Weekly Opus";
    } else if (lowerSegment.includes("sonnet")) {
      label = "Weekly Sonnet";
    } else if (lowerSegment.includes("week")) {
      label = "Weekly";
    } else if (lowerSegment.includes("session")) {
      label = "Session";
    } else {
      label = "Unknown";
    }

    const resetsMatch = segment.match(RESETS_RE);
    const resetsText = resetsMatch?.[1]?.trim() ?? null;

    results.push({ label, percentUsed, resetsText });
  }

  return dedupeLabels(results);
}

// Safety net: if the upstream output ever produces two rows with the same
// label (e.g. two "Weekly" entries because the model marker was missing),
// suffix the duplicates so the UI doesn't show identical names.
function dedupeLabels(lines: ParsedUsageLine[]): ParsedUsageLine[] {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const count = seen.get(line.label) ?? 0;
    seen.set(line.label, count + 1);
    if (count === 0) return line;
    return { ...line, label: `${line.label} (${count + 1})` };
  });
}

// ── Reset text → ms ─────────────────────────────────────────────────

function parseResetTextToMs(text: string | null): number | undefined {
  if (!text) return undefined;

  // "in 2h 31m" or "in 5m"
  const inMatch = text.match(/in\s+(?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)m)?/i);
  if (inMatch) {
    const days = parseInt(inMatch[1] ?? "0", 10);
    const hours = parseInt(inMatch[2] ?? "0", 10);
    const minutes = parseInt(inMatch[3] ?? "0", 10);
    return (days * 86400 + hours * 3600 + minutes * 60) * 1000;
  }

  // "Apr 8 at 6pm" — parse as a future date
  const dateMatch = text.match(/([A-Z][a-z]+)\s+(\d+)\s+at\s+(\d+)(?::(\d+))?\s*(am|pm)/i);
  if (dateMatch) {
    const months: Record<string, number> = {
      Jan: 0,
      Feb: 1,
      Mar: 2,
      Apr: 3,
      May: 4,
      Jun: 5,
      Jul: 6,
      Aug: 7,
      Sep: 8,
      Oct: 9,
      Nov: 10,
      Dec: 11,
    };
    const month = months[dateMatch[1]!];
    if (month !== undefined) {
      const day = parseInt(dateMatch[2]!, 10);
      let hour = parseInt(dateMatch[3]!, 10);
      const minute = parseInt(dateMatch[4] ?? "0", 10);
      if (dateMatch[5]!.toLowerCase() === "pm" && hour < 12) hour += 12;
      if (dateMatch[5]!.toLowerCase() === "am" && hour === 12) hour = 0;

      const now = new Date();
      const target = new Date(now.getFullYear(), month, day, hour, minute);
      if (target.getTime() < now.getTime()) {
        target.setFullYear(target.getFullYear() + 1);
      }
      return Math.max(0, target.getTime() - now.getTime());
    }
  }

  return undefined;
}

function parsedLinesToQuotas(lines: ParsedUsageLine[]): ProviderQuota[] {
  return lines.map((line) => ({
    name: line.label,
    percentUsed: line.percentUsed,
    ...(line.resetsText ? { resetsInMs: parseResetTextToMs(line.resetsText) } : {}),
  }));
}

// ── PTY-based probe ─────────────────────────────────────────────────

const PROBE_TIMEOUT_MS = 20_000;

export function probeClaudeUsage(binaryPath: string): Effect.Effect<ProviderQuota[]> {
  return Effect.promise(() => runPtyProbe(binaryPath));
}

function runPtyProbe(binaryPath: string): Promise<ProviderQuota[]> {
  console.log("[usage-probe-pty] starting PTY probe with binary:", binaryPath);
  return new Promise((resolve) => {
    let nodePty: typeof import("node-pty");
    try {
      const requireForPty = createRequire(import.meta.url);
      nodePty = requireForPty("node-pty");
      console.log("[usage-probe-pty] node-pty loaded");
    } catch (err) {
      console.error("[usage-probe-pty] node-pty load failed:", err);
      resolve([]);
      return;
    }

    let output = "";
    let usageSent = false;
    let resolved = false;
    let done = false;

    const proc = nodePty.spawn(binaryPath, [], {
      name: "xterm-256color",
      cols: 120,
      rows: 60,
      cwd: "/tmp",
      env: { ...globalThis.process.env },
    });

    // Register the PTY so a server crash during the (up to 20 s) probe
    // doesn't leave a claude CLI behind holding a PTY device.
    const registeredPid = typeof proc.pid === "number" ? proc.pid : undefined;
    if (registeredPid !== undefined) {
      ChildProcessRegistry.register({ pid: registeredPid, label: "claude-usage-probe" });
    }

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        try {
          proc.kill();
        } catch {
          // ignore
        }
        if (registeredPid !== undefined) {
          ChildProcessRegistry.unregister(registeredPid);
        }
      }
    };

    const timeout = setTimeout(() => {
      console.warn(
        "[usage-probe-pty] TIMEOUT after",
        PROBE_TIMEOUT_MS,
        "ms, output length:",
        output.length,
      );
      cleanup();
      resolve([]);
    }, PROBE_TIMEOUT_MS);

    proc.onData((data: string) => {
      output += data;

      if (!usageSent && output.length > 300) {
        usageSent = true;
        console.log("[usage-probe-pty] sending /usage command");
        setTimeout(() => proc.write("/usage\r"), 800);
      }

      if (usageSent && !done && /\d+%\s*used/i.test(stripAnsi(output))) {
        done = true;
        console.log("[usage-probe-pty] detected usage data, waiting 1.5s for full output");
        setTimeout(() => {
          clearTimeout(timeout);
          cleanup();
          const quotas = parsedLinesToQuotas(parseUsageLines(output));
          console.log("[usage-probe-pty] parsed quotas:", JSON.stringify(quotas));
          resolve(quotas);
        }, 1500);
      }
    });

    proc.onExit(({ exitCode }) => {
      console.log(
        "[usage-probe-pty] process exited with code:",
        exitCode,
        "output length:",
        output.length,
      );
      clearTimeout(timeout);
      if (registeredPid !== undefined) {
        ChildProcessRegistry.unregister(registeredPid);
      }
      if (!resolved) {
        resolved = true;
        const quotas = parsedLinesToQuotas(parseUsageLines(output));
        console.log("[usage-probe-pty] parsed on exit:", JSON.stringify(quotas));
        resolve(quotas);
      }
    });
  });
}

// ── Exports for testing ─────────────────────────────────────────────

export { parseUsageLines, parsedLinesToQuotas, parseResetTextToMs };
