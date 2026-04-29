import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { DiscoveredSessionRecord } from "../types.ts";
import { readFirstJsonLines, readLastJsonLine } from "../readJsonlHeaders.ts";

const CODEX_SESSIONS_ROOT = join(homedir(), ".codex", "sessions");

async function listDatedJsonlFiles(root: string): Promise<Array<string>> {
  const files: Array<string> = [];
  let years: Array<string>;
  try {
    years = await readdir(root);
  } catch {
    return files;
  }
  for (const year of years) {
    if (!/^\d{4}$/.test(year)) continue;
    const yearDir = join(root, year);
    let months: Array<string>;
    try {
      months = await readdir(yearDir);
    } catch {
      continue;
    }
    for (const month of months) {
      const monthDir = join(yearDir, month);
      let days: Array<string>;
      try {
        days = await readdir(monthDir);
      } catch {
        continue;
      }
      for (const day of days) {
        const dayDir = join(monthDir, day);
        let entries: Array<string>;
        try {
          entries = await readdir(dayDir);
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (entry.startsWith("rollout-") && entry.endsWith(".jsonl")) {
            files.push(join(dayDir, entry));
          }
        }
      }
    }
  }
  return files;
}

function extractCodexTitle(events: Array<unknown>): string | null {
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const record = event as Record<string, unknown>;
    if (record.type !== "response_item") continue;
    const payload = record.payload as Record<string, unknown> | undefined;
    if (!payload || payload.type !== "message") continue;
    if (payload.role !== "user") continue;
    const content = payload.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const partRec = part as Record<string, unknown>;
      if (typeof partRec.text === "string" && partRec.text.trim().length > 0) {
        return partRec.text.trim().slice(0, 120);
      }
    }
  }
  return null;
}

export async function scanCodexSessions(): Promise<Array<DiscoveredSessionRecord>> {
  const files = await listDatedJsonlFiles(CODEX_SESSIONS_ROOT);
  const results: Array<DiscoveredSessionRecord> = [];

  for (const filePath of files) {
    try {
      const fileStat = await stat(filePath);
      if (fileStat.size === 0) continue;
      const headerLines = await readFirstJsonLines(filePath, 32);
      const sessionMeta = headerLines.find(
        (line): line is Record<string, unknown> =>
          !!line &&
          typeof line === "object" &&
          (line as Record<string, unknown>).type === "session_meta",
      );
      if (!sessionMeta) continue;
      const payload = (sessionMeta as Record<string, unknown>).payload as
        | Record<string, unknown>
        | undefined;
      if (!payload) continue;
      const sessionId = typeof payload.id === "string" ? payload.id : null;
      const cwd = typeof payload.cwd === "string" ? payload.cwd : null;
      if (!sessionId || !cwd) continue;

      const firstActiveAt =
        typeof payload.timestamp === "string"
          ? payload.timestamp
          : (((sessionMeta as Record<string, unknown>).timestamp as string | undefined) ??
            fileStat.mtime.toISOString());

      const lastLine = await readLastJsonLine(filePath).catch(() => null);
      const lastActiveAt =
        lastLine && typeof lastLine === "object" && lastLine !== null
          ? typeof (lastLine as Record<string, unknown>).timestamp === "string"
            ? ((lastLine as Record<string, unknown>).timestamp as string)
            : fileStat.mtime.toISOString()
          : fileStat.mtime.toISOString();

      const title = extractCodexTitle(headerLines);

      results.push({
        provider: "codex",
        sessionId,
        cwd,
        title,
        messageCount: 0, // expensive to count exactly; 0 means "unknown"
        firstActiveAt,
        lastActiveAt,
        fileSize: fileStat.size,
        filePath,
      });
    } catch (error) {
      console.warn(`[session-discovery] failed to parse codex session ${filePath}:`, error);
    }
  }

  return results;
}
