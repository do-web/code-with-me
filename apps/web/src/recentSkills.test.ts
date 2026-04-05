import { describe, expect, it } from "vitest";
import type { SkillEntry } from "@codewithme/contracts";
import {
  extractUsedSkillNames,
  recordRecentSkillUsage,
  splitSkillsByRecentUsage,
} from "./recentSkills";

const SKILLS: readonly SkillEntry[] = [
  {
    name: "foo",
    description: "Foo skill",
    source: "plugin",
  },
  {
    name: "bar",
    description: "Bar skill",
    source: "plugin",
  },
  {
    name: "baz",
    description: "Baz skill",
    source: "user",
  },
];

describe("extractUsedSkillNames", () => {
  it("returns canonical skill names used at the start of prompt lines", () => {
    const usedSkillNames = extractUsedSkillNames(
      "/FOO fix this\n  /bar add tests\n/model gpt-5\nnot a command\n/baz",
      SKILLS,
    );

    expect(usedSkillNames).toEqual(["foo", "bar", "baz"]);
  });

  it("ignores unknown and duplicate slash commands", () => {
    const usedSkillNames = extractUsedSkillNames("/foo\n/foo more\n/unknown\n/default", SKILLS);

    expect(usedSkillNames).toEqual(["foo"]);
  });
});

describe("recordRecentSkillUsage", () => {
  it("prepends new skills and deduplicates case-insensitively", () => {
    const recentSkillNames = recordRecentSkillUsage(["bar", "baz"], ["FOO", "bar"]);

    expect(recentSkillNames).toEqual(["FOO", "bar", "baz"]);
  });
});

describe("splitSkillsByRecentUsage", () => {
  it("returns recent skills first and preserves original order for the remainder", () => {
    const { recentSkills, remainingSkills } = splitSkillsByRecentUsage(SKILLS, ["baz", "foo"]);

    expect(recentSkills.map((skill) => skill.name)).toEqual(["baz", "foo"]);
    expect(remainingSkills.map((skill) => skill.name)).toEqual(["bar"]);
  });
});
