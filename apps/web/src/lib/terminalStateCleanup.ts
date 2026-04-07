import type { ProjectId } from "@codewithme/contracts";

interface TerminalRetentionProject {
  id: ProjectId;
}

interface CollectActiveTerminalProjectIdsInput {
  snapshotProjects: readonly TerminalRetentionProject[];
}

export function collectActiveTerminalProjectIds(
  input: CollectActiveTerminalProjectIdsInput,
): Set<ProjectId> {
  return new Set(input.snapshotProjects.map((project) => project.id));
}
