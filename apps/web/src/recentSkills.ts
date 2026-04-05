import type { SkillEntry } from "@codewithme/contracts";
import * as Schema from "effect/Schema";

export const RECENT_SKILLS_STORAGE_KEY = "codewithme:recent-skills:v1";
export const RecentSkillNamesSchema = Schema.Array(Schema.String);

const MAX_RECENT_SKILLS = 12;

function normalizeSkillName(name: string): string {
  return name.trim().toLowerCase();
}

export function extractUsedSkillNames(
  prompt: string,
  skills: readonly SkillEntry[],
): readonly string[] {
  const canonicalSkillNameByNormalizedName = new Map(
    skills.map((skill) => [normalizeSkillName(skill.name), skill.name] as const),
  );
  const seenNames = new Set<string>();
  const usedSkillNames: string[] = [];

  for (const line of prompt.split(/\r?\n/g)) {
    const match = /^\/([^\s/]+)/.exec(line.trimStart());
    const skillName = match?.[1];
    if (!skillName) {
      continue;
    }
    const canonicalSkillName = canonicalSkillNameByNormalizedName.get(
      normalizeSkillName(skillName),
    );
    if (!canonicalSkillName || seenNames.has(canonicalSkillName)) {
      continue;
    }
    seenNames.add(canonicalSkillName);
    usedSkillNames.push(canonicalSkillName);
  }

  return usedSkillNames;
}

export function recordRecentSkillUsage(
  existingSkillNames: readonly string[],
  usedSkillNames: readonly string[],
): string[] {
  const dedupedSkillNames: string[] = [];
  const seenNormalizedNames = new Set<string>();

  for (const skillName of [...usedSkillNames, ...existingSkillNames]) {
    const normalizedSkillName = normalizeSkillName(skillName);
    if (!normalizedSkillName || seenNormalizedNames.has(normalizedSkillName)) {
      continue;
    }
    seenNormalizedNames.add(normalizedSkillName);
    dedupedSkillNames.push(skillName);
    if (dedupedSkillNames.length >= MAX_RECENT_SKILLS) {
      break;
    }
  }

  return dedupedSkillNames;
}

export function splitSkillsByRecentUsage(
  skills: readonly SkillEntry[],
  recentSkillNames: readonly string[],
): {
  recentSkills: SkillEntry[];
  remainingSkills: SkillEntry[];
} {
  const skillByNormalizedName = new Map(
    skills.map((skill) => [normalizeSkillName(skill.name), skill] as const),
  );
  const recentSkills: SkillEntry[] = [];
  const seenSkillNames = new Set<string>();

  for (const skillName of recentSkillNames) {
    const matchedSkill = skillByNormalizedName.get(normalizeSkillName(skillName));
    if (!matchedSkill || seenSkillNames.has(matchedSkill.name)) {
      continue;
    }
    seenSkillNames.add(matchedSkill.name);
    recentSkills.push(matchedSkill);
  }

  const remainingSkills = skills.filter((skill) => !seenSkillNames.has(skill.name));
  return { recentSkills, remainingSkills };
}
