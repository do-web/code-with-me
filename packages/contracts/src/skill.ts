import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";

export const SkillSource = Schema.Literals(["user", "plugin", "agent", "command"]);
export type SkillSource = typeof SkillSource.Type;

export const SkillEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  source: SkillSource,
});
export type SkillEntry = typeof SkillEntry.Type;

export const SkillsListResult = Schema.Struct({
  skills: Schema.Array(SkillEntry),
});
export type SkillsListResult = typeof SkillsListResult.Type;

export class SkillsListError extends Schema.TaggedErrorClass<SkillsListError>()("SkillsListError", {
  message: Schema.String,
}) {}

export class SkillsRefreshError extends Schema.TaggedErrorClass<SkillsRefreshError>()(
  "SkillsRefreshError",
  { message: Schema.String },
) {}
