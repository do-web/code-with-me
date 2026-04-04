import { Effect, Layer, Ref, ServiceMap } from "effect";
import type { SkillEntry } from "@codewithme/contracts";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

function parseFrontmatter(
  content: string,
): { name: string | undefined; description: string | undefined } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match?.[1]) return null;
  const block = match[1];
  let name: string | undefined;
  let description: string | undefined;
  for (const line of block.split(/\r?\n/)) {
    const kv = /^(\w+):\s*(.+)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    const value = (kv[2] ?? "").trim().replace(/^["']|["']$/g, "");
    if (key === "name") name = value;
    else if (key === "description") description = value;
  }
  if (!name && !description) return null;
  return { name, description };
}

// ---------------------------------------------------------------------------
// Filesystem scanning
// ---------------------------------------------------------------------------

async function readSkillFile(
  skillMdPath: string,
  source: SkillEntry["source"],
): Promise<SkillEntry | null> {
  try {
    const content = await fs.readFile(skillMdPath, "utf-8");
    const fm = parseFrontmatter(content);
    if (!fm?.name || !fm?.description) return null;
    return { name: fm.name, description: fm.description, source };
  } catch {
    return null;
  }
}

async function scanDirectory(dir: string, source: SkillEntry["source"]): Promise<SkillEntry[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const results = await Promise.all(
      entries
        .filter((e) => e.isDirectory() || e.isSymbolicLink())
        .map((e) => readSkillFile(path.join(dir, e.name, "SKILL.md"), source)),
    );
    return results.filter((s): s is SkillEntry => s !== null);
  } catch {
    return [];
  }
}

async function getPluginSkillPaths(): Promise<string[]> {
  const installedPath = path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json");
  try {
    const raw = await fs.readFile(installedPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return [];
    const paths: string[] = [];
    for (const value of Object.values(parsed as Record<string, unknown>)) {
      if (typeof value === "object" && value !== null && "installPath" in value) {
        const installPath = (value as { installPath: unknown }).installPath;
        if (typeof installPath === "string") {
          paths.push(path.join(installPath, "skills"));
        }
      }
    }
    return paths;
  } catch {
    return [];
  }
}

/**
 * Scan marketplace plugin directories for agents and commands.
 * These are stored as individual .md files (not SKILL.md in subdirectories).
 * Path: ~/.claude/plugins/marketplaces/{marketplace}/plugins/{plugin}/agents/*.md
 * Path: ~/.claude/plugins/marketplaces/{marketplace}/plugins/{plugin}/commands/*.md
 */
async function scanMarketplacePlugins(): Promise<SkillEntry[]> {
  const marketplacesDir = path.join(os.homedir(), ".claude", "plugins", "marketplaces");
  const skills: SkillEntry[] = [];

  let marketplaceNames: string[];
  try {
    marketplaceNames = await fs.readdir(marketplacesDir);
  } catch {
    return skills;
  }

  for (const marketplace of marketplaceNames) {
    const pluginsDir = path.join(marketplacesDir, marketplace, "plugins");
    let pluginNames: string[];
    try {
      pluginNames = await fs.readdir(pluginsDir);
    } catch {
      continue;
    }
    for (const plugin of pluginNames) {
      for (const subdir of ["agents", "commands"]) {
        const dir = path.join(pluginsDir, plugin, subdir);
        let files: string[];
        try {
          files = await fs.readdir(dir);
        } catch {
          continue;
        }
        for (const file of files) {
          if (!file.endsWith(".md")) continue;
          const filePath = path.join(dir, file);
          const entry = await readSkillFile(filePath, "plugin");
          if (entry) {
            skills.push(entry);
          } else {
            // Fallback: use filename as name if frontmatter has description but no name
            try {
              const content = await fs.readFile(filePath, "utf-8");
              const fm = parseFrontmatter(content);
              if (fm?.description) {
                skills.push({
                  name: file.replace(/\.md$/, ""),
                  description: fm.description,
                  source: "plugin",
                });
              }
            } catch {
              // Skip unreadable files
            }
          }
        }
      }
    }
  }

  return skills;
}

async function scanAllSkills(): Promise<SkillEntry[]> {
  const userSkillsDir = path.join(os.homedir(), ".claude", "skills");
  const pluginSkillDirs = await getPluginSkillPaths();

  const [userSkills, marketplaceSkills, ...pluginSkillArrays] = await Promise.all([
    scanDirectory(userSkillsDir, "user"),
    scanMarketplacePlugins(),
    ...pluginSkillDirs.map((dir) => scanDirectory(dir, "plugin")),
  ]);

  // User skills win over plugin skills with the same name
  const seen = new Set<string>();
  const merged: SkillEntry[] = [];

  for (const skill of userSkills ?? []) {
    if (!seen.has(skill.name)) {
      seen.add(skill.name);
      merged.push(skill);
    }
  }
  for (const skill of marketplaceSkills) {
    if (!seen.has(skill.name)) {
      seen.add(skill.name);
      merged.push(skill);
    }
  }
  for (const pluginSkills of pluginSkillArrays) {
    for (const skill of pluginSkills) {
      if (!seen.has(skill.name)) {
        seen.add(skill.name);
        merged.push(skill);
      }
    }
  }

  return merged.toSorted((a, b) => a.name.localeCompare(b.name));
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
  yield* Effect.promise(() => scanAllSkills().catch(() => [] as SkillEntry[])).pipe(
    Effect.flatMap((skills) => Ref.set(cacheRef, skills)),
  );

  const list: Effect.Effect<SkillEntry[]> = Ref.get(cacheRef);

  const refresh: Effect.Effect<SkillEntry[]> = Effect.promise(() =>
    scanAllSkills().catch(() => [] as SkillEntry[]),
  ).pipe(Effect.flatMap((skills) => Ref.set(cacheRef, skills).pipe(Effect.map(() => skills))));

  return { list, refresh };
});

export const SkillDiscoveryLive = Layer.effect(SkillDiscovery, makeSkillDiscovery);
