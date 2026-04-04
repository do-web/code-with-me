import { Effect, Layer, Ref, ServiceMap } from "effect";
import type { SkillEntry } from "@codewithme/contracts";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Cache file path: ~/.claude/skills-cache.json
// ---------------------------------------------------------------------------

const CACHE_PATH = path.join(os.homedir(), ".claude", "skills-cache.json");

// ---------------------------------------------------------------------------
// Read from cache file
// ---------------------------------------------------------------------------

async function readCachedSkills(): Promise<SkillEntry[]> {
  try {
    const raw = await fs.readFile(CACHE_PATH, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is SkillEntry =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as Record<string, unknown>).name === "string" &&
        typeof (item as Record<string, unknown>).description === "string",
    );
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Query Claude CLI and write cache
// ---------------------------------------------------------------------------

const CLAUDE_SKILLS_PROMPT =
  'List all available skills as a JSON array. Each element must have "name" (string) and "description" (string). Output ONLY the JSON array, no markdown fences, no other text.';

function parseSkillsFromCliResult(stdout: string): SkillEntry[] {
  // claude --output-format json wraps response in {"result": "..."} envelope
  let text = stdout;
  try {
    const envelope: unknown = JSON.parse(stdout);
    if (typeof envelope === "object" && envelope !== null && "result" in envelope) {
      const result = (envelope as { result: unknown }).result;
      if (typeof result === "string") text = result;
    }
  } catch {
    // Use raw stdout
  }

  const jsonMatch = /\[[\s\S]*\]/.exec(text);
  if (!jsonMatch) return [];

  try {
    const parsed: unknown = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is { name: string; description: string } =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as Record<string, unknown>).name === "string" &&
          typeof (item as Record<string, unknown>).description === "string",
      )
      .map((item) => ({
        name: item.name,
        description: item.description,
        source: "plugin" as const,
      }));
  } catch {
    return [];
  }
}

async function refreshSkillsFromCli(): Promise<SkillEntry[]> {
  const skills = await new Promise<SkillEntry[]>((resolve) => {
    execFile(
      "claude",
      ["-p", CLAUDE_SKILLS_PROMPT, "--output-format", "json", "--model", "haiku"],
      { timeout: 60_000 },
      (error, stdout) => {
        if (error || !stdout) {
          resolve([]);
          return;
        }
        resolve(parseSkillsFromCliResult(stdout));
      },
    );
  });

  // Write cache for next server start
  if (skills.length > 0) {
    await fs.writeFile(CACHE_PATH, JSON.stringify(skills, null, 2)).catch(() => {});
  }

  return skills;
}

// ---------------------------------------------------------------------------
// Effect service
// ---------------------------------------------------------------------------

interface SkillDiscoveryShape {
  readonly list: Effect.Effect<SkillEntry[]>;
  readonly refresh: Effect.Effect<SkillEntry[]>;
}

export class SkillDiscovery extends ServiceMap.Service<SkillDiscovery, SkillDiscoveryShape>()(
  "codewithme/skills/SkillDiscovery",
) {}

const makeSkillDiscovery: Effect.Effect<SkillDiscoveryShape> = Effect.gen(function* () {
  const cacheRef = yield* Ref.make<SkillEntry[]>([]);

  // Load from cache file (instant, no API call)
  yield* Effect.promise(() => readCachedSkills()).pipe(
    Effect.flatMap((skills) => Ref.set(cacheRef, skills)),
  );

  const list: Effect.Effect<SkillEntry[]> = Ref.get(cacheRef);

  // Refresh: call Claude CLI, update cache file + in-memory ref
  const refresh: Effect.Effect<SkillEntry[]> = Effect.promise(() =>
    refreshSkillsFromCli().catch(() => [] as SkillEntry[]),
  ).pipe(
    Effect.flatMap((skills) =>
      skills.length > 0
        ? Ref.set(cacheRef, skills).pipe(Effect.map(() => skills))
        : Ref.get(cacheRef),
    ),
  );

  return { list, refresh };
});

export const SkillDiscoveryLive = Layer.effect(SkillDiscovery, makeSkillDiscovery);
