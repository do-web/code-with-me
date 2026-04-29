import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { DiscoveredSessionRecord } from "../types.ts";
import { readFirstJsonLines, readLastJsonLine, readLastJsonLines } from "../readJsonlHeaders.ts";

const CLAUDE_PROJECTS_ROOT = join(homedir(), ".claude", "projects");

/**
 * Dash-decoded Claude project directory: `-Users-dweber-code` → `/Users/dweber/code`.
 * Ambiguous in the presence of dashes in the real path — treat as fallback only.
 */
function decodeDashedPath(dirName: string): string | null {
  if (!dirName.startsWith("-")) return null;
  return dirName.replace(/-/g, "/");
}

/**
 * Returns true for user-message content that is actually an internal
 * Claude Code directive (command invocations, caveat banners, title-seed
 * system prompts). We don't want these strings leaking into the session
 * preview.
 */
function isSystemLikeUserContent(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.startsWith("<command-message>")) return true;
  if (trimmed.startsWith("<command-name>")) return true;
  if (trimmed.startsWith("<local-command-caveat>")) return true;
  if (trimmed.startsWith("<system-reminder>")) return true;
  if (trimmed.startsWith("Caveat: The messages below")) return true;
  if (trimmed.startsWith("You write concise thread titles")) return true;
  // Slash-command expansions that Claude Code injects as user messages.
  if (trimmed.startsWith("Stop hook feedback:")) return true;
  if (trimmed.startsWith("Erstelle einen Git-Commit")) return true;
  // Claude's built-in commands produce heading-style templates we don't want
  // as thread titles: "# Simplify:", "# Commit:", "# Review:", etc.
  if (/^#\s+[A-ZÄÖÜ][\w\s-]{0,40}:\s/.test(trimmed)) return true;
  return false;
}

function extractCustomTitle(events: ReadonlyArray<unknown>): string | null {
  let latest: string | null = null;
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const record = event as Record<string, unknown>;
    if (record.type !== "custom-title") continue;
    const value = record.customTitle;
    if (typeof value === "string" && value.trim().length > 0) {
      latest = value.trim();
    }
  }
  return latest;
}

function extractFirstMeaningfulUserMessage(events: ReadonlyArray<unknown>): string | null {
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const record = event as Record<string, unknown>;
    if (record.type !== "user") continue;
    const message = record.message as Record<string, unknown> | undefined;
    if (!message) continue;
    const content = message.content;
    if (typeof content === "string") {
      if (!isSystemLikeUserContent(content)) {
        return content.trim().slice(0, 120);
      }
      continue;
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const partRec = part as Record<string, unknown>;
        if (typeof partRec.text !== "string") continue;
        if (isSystemLikeUserContent(partRec.text)) continue;
        return partRec.text.trim().slice(0, 120);
      }
    }
  }
  return null;
}

function extractCwd(events: ReadonlyArray<unknown>): string | null {
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const record = event as Record<string, unknown>;
    if (typeof record.cwd === "string" && record.cwd.trim().length > 0) {
      return record.cwd.trim();
    }
  }
  return null;
}

function extractSessionId(events: ReadonlyArray<unknown>): string | null {
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const record = event as Record<string, unknown>;
    if (typeof record.sessionId === "string" && record.sessionId.trim().length > 0) {
      return record.sessionId.trim();
    }
  }
  return null;
}

function extractTimestamp(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const record = event as Record<string, unknown>;
  return typeof record.timestamp === "string" ? record.timestamp : null;
}

export async function scanClaudeSessions(): Promise<Array<DiscoveredSessionRecord>> {
  let projectDirs: Array<string>;
  try {
    projectDirs = await readdir(CLAUDE_PROJECTS_ROOT);
  } catch {
    return [];
  }

  const results: Array<DiscoveredSessionRecord> = [];

  for (const projectDir of projectDirs) {
    const dirPath = join(CLAUDE_PROJECTS_ROOT, projectDir);
    let entries: Array<string>;
    try {
      entries = await readdir(dirPath);
    } catch {
      continue;
    }
    const decodedCwd = decodeDashedPath(projectDir);

    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const filePath = join(dirPath, entry);
      try {
        const fileStat = await stat(filePath);
        if (fileStat.size === 0) continue;

        const headerLines = await readFirstJsonLines(filePath, 64);
        const tailLines = await readLastJsonLines(filePath, 128).catch(() => [] as Array<unknown>);
        const combined: Array<unknown> = [...headerLines, ...tailLines];

        const sessionIdFromEvents = extractSessionId(combined);
        const fileNameSessionId = entry.replace(/\.jsonl$/, "");
        const sessionId = sessionIdFromEvents ?? fileNameSessionId;

        const cwdFromEvents = extractCwd(combined);
        const cwd = cwdFromEvents ?? decodedCwd;
        if (!cwd) continue;

        // Prefer the user-assigned custom title (Claude's `/title` command or
        // sidebar rename writes `custom-title` events). Fall back to the first
        // non-command user message.
        const title = extractCustomTitle(combined) ?? extractFirstMeaningfulUserMessage(combined);

        const firstTimestamp =
          headerLines.map((event) => extractTimestamp(event)).find((t) => t !== null) ?? null;
        const firstActiveAt = firstTimestamp ?? fileStat.mtime.toISOString();

        const lastLine = await readLastJsonLine(filePath).catch(() => null);
        const lastActiveAt = extractTimestamp(lastLine) ?? fileStat.mtime.toISOString();

        results.push({
          provider: "claudeAgent",
          sessionId,
          cwd,
          title,
          messageCount: 0,
          firstActiveAt,
          lastActiveAt,
          fileSize: fileStat.size,
          filePath,
        });
      } catch (error) {
        console.warn(`[session-discovery] failed to parse claude session ${filePath}:`, error);
      }
    }
  }

  return results;
}
