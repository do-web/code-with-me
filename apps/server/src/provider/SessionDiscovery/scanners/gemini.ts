import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { DiscoveredSessionRecord } from "../types.ts";

const GEMINI_ROOT = join(homedir(), ".gemini");
const GEMINI_PROJECTS_FILE = join(GEMINI_ROOT, "projects.json");
const GEMINI_TMP_ROOT = join(GEMINI_ROOT, "tmp");
const MAX_SESSION_FILE_BYTES = 5 * 1024 * 1024;

async function loadProjectCwdByName(): Promise<Map<string, string>> {
  try {
    const raw = await readFile(GEMINI_PROJECTS_FILE, "utf8");
    const parsed = JSON.parse(raw) as { projects?: Record<string, string> };
    const byName = new Map<string, string>();
    if (parsed.projects) {
      for (const [cwd, name] of Object.entries(parsed.projects)) {
        if (typeof cwd === "string" && typeof name === "string") {
          byName.set(name, cwd);
        }
      }
    }
    return byName;
  } catch {
    return new Map();
  }
}

function extractTitle(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    if (record.type !== "user") continue;
    const content = record.content;
    if (typeof content === "string" && content.trim().length > 0) {
      return content.trim().slice(0, 120);
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const partRec = part as Record<string, unknown>;
        if (typeof partRec.text === "string" && partRec.text.trim().length > 0) {
          return partRec.text.trim().slice(0, 120);
        }
      }
    }
  }
  return null;
}

function countMessages(messages: unknown): number {
  return Array.isArray(messages) ? messages.length : 0;
}

export async function scanGeminiSessions(): Promise<Array<DiscoveredSessionRecord>> {
  const projectCwdByName = await loadProjectCwdByName();
  if (projectCwdByName.size === 0) return [];

  const results: Array<DiscoveredSessionRecord> = [];

  for (const [projectName, cwd] of projectCwdByName) {
    const chatsDir = join(GEMINI_TMP_ROOT, projectName, "chats");
    let entries: Array<string>;
    try {
      entries = await readdir(chatsDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.startsWith("session-") || !entry.endsWith(".json")) continue;
      const filePath = join(chatsDir, entry);
      try {
        const fileStat = await stat(filePath);
        if (fileStat.size === 0 || fileStat.size > MAX_SESSION_FILE_BYTES) continue;

        const raw = await readFile(filePath, "utf8");
        const parsed = JSON.parse(raw) as {
          sessionId?: string;
          startTime?: string;
          lastUpdated?: string;
          messages?: Array<unknown>;
        };

        const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : null;
        if (!sessionId) continue;

        const firstActiveAt = parsed.startTime ?? fileStat.birthtime.toISOString();
        const lastActiveAt = parsed.lastUpdated ?? fileStat.mtime.toISOString();
        const title = extractTitle(parsed.messages);
        const messageCount = countMessages(parsed.messages);

        results.push({
          provider: "gemini",
          sessionId,
          cwd,
          title,
          messageCount,
          firstActiveAt,
          lastActiveAt,
          fileSize: fileStat.size,
          filePath,
        });
      } catch (error) {
        console.warn(`[session-discovery] failed to parse gemini session ${filePath}:`, error);
      }
    }
  }

  return results;
}
