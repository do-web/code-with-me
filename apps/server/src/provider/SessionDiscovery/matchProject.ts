import type { OrchestrationProject, ProjectId } from "@codewithme/contracts";

/**
 * Find the project whose workspace root best matches the given cwd.
 *
 * 1. Exact match wins.
 * 2. Otherwise: the longest project root that is a path ancestor of the
 *    session cwd (monorepo subdirectory support).
 */
export function matchProjectByCwd(
  sessionCwd: string,
  projects: ReadonlyArray<OrchestrationProject>,
): ProjectId | null {
  const normalizedSession = normalize(sessionCwd);
  const exact = projects.find((project) => normalize(project.workspaceRoot) === normalizedSession);
  if (exact) return exact.id;

  const containing = projects
    .filter((project) => {
      const root = normalize(project.workspaceRoot);
      return normalizedSession === root || normalizedSession.startsWith(root + "/");
    })
    .toSorted((left, right) => right.workspaceRoot.length - left.workspaceRoot.length)[0];

  return containing?.id ?? null;
}

function normalize(path: string): string {
  const trimmed = path.trim();
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}
