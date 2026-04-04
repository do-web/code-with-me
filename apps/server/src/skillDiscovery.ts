import { Effect, Layer, Ref, ServiceMap } from "effect";
import type { SkillEntry } from "@codewithme/contracts";
import { execFile } from "node:child_process";

// ---------------------------------------------------------------------------
// Skill discovery via Claude CLI
// ---------------------------------------------------------------------------

const CLAUDE_SKILLS_PROMPT =
  'List all available skills as a JSON array. Each element must have "name" (string) and "description" (string). Output ONLY the JSON array, no markdown fences, no other text.';

function parseSkillsFromCli(stdout: string): SkillEntry[] {
  // Extract JSON array – handle possible markdown fences
  const jsonMatch = /\[[\s\S]*\]/.exec(stdout);
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

function queryClaudeSkills(): Promise<SkillEntry[]> {
  return new Promise((resolve) => {
    execFile(
      "claude",
      ["-p", CLAUDE_SKILLS_PROMPT, "--output-format", "json", "--bare", "--model", "haiku"],
      { timeout: 30_000 },
      (error, stdout) => {
        if (error || !stdout) {
          resolve([]);
          return;
        }

        // claude --output-format json wraps response in {"result": "..."} envelope
        try {
          const envelope: unknown = JSON.parse(stdout);
          if (typeof envelope === "object" && envelope !== null && "result" in envelope) {
            const result = (envelope as { result: unknown }).result;
            if (typeof result === "string") {
              resolve(parseSkillsFromCli(result));
              return;
            }
          }
        } catch {
          // Try raw output as fallback
        }

        resolve(parseSkillsFromCli(stdout));
      },
    );
  });
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

  // Initial load — best effort, failure silently ignored
  yield* Effect.promise(() => queryClaudeSkills().catch(() => [] as SkillEntry[])).pipe(
    Effect.flatMap((skills) => Ref.set(cacheRef, skills)),
  );

  const list: Effect.Effect<SkillEntry[]> = Ref.get(cacheRef);

  const refresh: Effect.Effect<SkillEntry[]> = Effect.promise(() =>
    queryClaudeSkills().catch(() => [] as SkillEntry[]),
  ).pipe(Effect.flatMap((skills) => Ref.set(cacheRef, skills).pipe(Effect.map(() => skills))));

  return { list, refresh };
});

export const SkillDiscoveryLive = Layer.effect(SkillDiscovery, makeSkillDiscovery);
