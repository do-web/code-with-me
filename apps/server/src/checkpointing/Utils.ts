import { Encoding } from "effect";
import { CheckpointRef, ProjectId, type ThreadId } from "@codewithme/contracts";

export const CHECKPOINT_REFS_PREFIX = "refs/codewithme/checkpoints";

/**
 * Legacy ref prefixes from before the project rebrand.
 * Used as fallbacks when resolving checkpoint refs created before the rename.
 */
export const LEGACY_CHECKPOINT_REFS_PREFIXES = ["refs/t3/checkpoints"] as const;

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.makeUnsafe(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/turn/${turnCount}`,
  );
}

/**
 * Returns possible checkpoint ref candidates for a thread turn, starting with
 * the current prefix followed by legacy prefixes. Useful when resolving refs
 * that may have been created before the project was rebranded.
 */
export function checkpointRefCandidatesForThreadTurn(
  threadId: ThreadId,
  turnCount: number,
): CheckpointRef[] {
  const suffix = `${Encoding.encodeBase64Url(threadId)}/turn/${turnCount}`;
  return [
    CheckpointRef.makeUnsafe(`${CHECKPOINT_REFS_PREFIX}/${suffix}`),
    ...LEGACY_CHECKPOINT_REFS_PREFIXES.map((prefix) =>
      CheckpointRef.makeUnsafe(`${prefix}/${suffix}`),
    ),
  ];
}

export function resolveThreadWorkspaceCwd(input: {
  readonly thread: {
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  };
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>;
}): string | undefined {
  const worktreeCwd = input.thread.worktreePath ?? undefined;
  if (worktreeCwd) {
    return worktreeCwd;
  }

  return input.projects.find((project) => project.id === input.thread.projectId)?.workspaceRoot;
}
