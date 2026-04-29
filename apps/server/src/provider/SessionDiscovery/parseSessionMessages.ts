import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

import type { ProviderKind } from "@codewithme/contracts";

export interface ParsedMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

const MAX_TEXT_LENGTH = 64_000;

function truncate(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > MAX_TEXT_LENGTH
    ? trimmed.slice(0, MAX_TEXT_LENGTH) + "\n\n…[truncated]"
    : trimmed;
}

function isSystemLike(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.startsWith("<command-message>")) return true;
  if (trimmed.startsWith("<command-name>")) return true;
  if (trimmed.startsWith("<local-command-caveat>")) return true;
  if (trimmed.startsWith("<system-reminder>")) return true;
  if (trimmed.startsWith("Caveat: The messages below")) return true;
  if (trimmed.startsWith("You write concise thread titles")) return true;
  if (trimmed.startsWith("Stop hook feedback:")) return true;
  if (trimmed.startsWith("Erstelle einen Git-Commit")) return true;
  if (/^#\s+[A-ZÄÖÜ][\w\s-]{0,40}:\s/.test(trimmed)) return true;
  return false;
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: Array<string> = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const rec = part as Record<string, unknown>;
    if (typeof rec.text === "string") parts.push(rec.text);
    else if (typeof rec.content === "string") parts.push(rec.content);
  }
  return parts.join("\n\n");
}

async function parseClaudeJsonl(filePath: string): Promise<Array<ParsedMessage>> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    const messages: Array<ParsedMessage> = [];
    rl.on("line", (line: string) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      let event: unknown;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (!event || typeof event !== "object") return;
      const record = event as Record<string, unknown>;
      const type = record.type;
      if (type !== "user" && type !== "assistant") return;
      const message = record.message as Record<string, unknown> | undefined;
      if (!message) return;
      const text = extractTextFromContent(message.content);
      if (isSystemLike(text)) return;
      const timestamp = typeof record.timestamp === "string" ? record.timestamp : null;
      if (!timestamp) return;
      messages.push({
        role: type,
        text: truncate(text),
        createdAt: timestamp,
      });
    });
    rl.on("close", () => resolve(messages));
    rl.on("error", (error: unknown) => reject(error));
  });
}

async function parseCodexJsonl(filePath: string): Promise<Array<ParsedMessage>> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    const messages: Array<ParsedMessage> = [];
    rl.on("line", (line: string) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      let event: unknown;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (!event || typeof event !== "object") return;
      const record = event as Record<string, unknown>;
      if (record.type !== "response_item") return;
      const payload = record.payload as Record<string, unknown> | undefined;
      if (!payload || payload.type !== "message") return;
      const role = payload.role;
      if (role !== "user" && role !== "assistant") return;
      const text = extractTextFromContent(payload.content);
      if (isSystemLike(text)) return;
      const timestamp =
        typeof record.timestamp === "string"
          ? record.timestamp
          : typeof payload.timestamp === "string"
            ? payload.timestamp
            : null;
      if (!timestamp) return;
      messages.push({
        role,
        text: truncate(text),
        createdAt: timestamp,
      });
    });
    rl.on("close", () => resolve(messages));
    rl.on("error", (error: unknown) => reject(error));
  });
}

async function parseGeminiJson(filePath: string): Promise<Array<ParsedMessage>> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as { messages?: Array<unknown> };
    if (!Array.isArray(parsed.messages)) return [];
    const results: Array<ParsedMessage> = [];
    for (const message of parsed.messages) {
      if (!message || typeof message !== "object") continue;
      const rec = message as Record<string, unknown>;
      const role = rec.type;
      if (role !== "user" && role !== "assistant") continue;
      const text = extractTextFromContent(rec.content);
      if (isSystemLike(text)) continue;
      const timestamp = typeof rec.timestamp === "string" ? rec.timestamp : null;
      if (!timestamp) continue;
      results.push({ role, text: truncate(text), createdAt: timestamp });
    }
    return results;
  } catch {
    return [];
  }
}

export async function parseSessionMessages(input: {
  readonly provider: ProviderKind;
  readonly filePath: string;
}): Promise<Array<ParsedMessage>> {
  switch (input.provider) {
    case "claudeAgent":
      return parseClaudeJsonl(input.filePath).catch(() => []);
    case "codex":
      return parseCodexJsonl(input.filePath).catch(() => []);
    case "gemini":
      return parseGeminiJson(input.filePath);
  }
}
