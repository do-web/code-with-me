import type { PackageManagerId, ProjectReadPackageScriptsResult } from "@codewithme/contracts";
import { Effect, FileSystem, Path } from "effect";

export class ReadPackageScriptsError {
  readonly _tag = "ReadPackageScriptsError";
  constructor(
    readonly message: string,
    readonly cause?: unknown,
  ) {}
}

export const readPackageScripts = Effect.fn("readPackageScripts")(function* (input: {
  cwd: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const packageJsonPath = path.join(input.cwd, "package.json");

  const raw = yield* fileSystem
    .readFileString(packageJsonPath)
    .pipe(
      Effect.mapError(
        (cause) =>
          new ReadPackageScriptsError(`Failed to read package.json at ${packageJsonPath}`, cause),
      ),
    );

  const parsed = yield* Effect.try({
    try: () => JSON.parse(raw) as Record<string, unknown>,
    catch: (cause) => new ReadPackageScriptsError("Failed to parse package.json", cause),
  });

  const rawScripts =
    parsed.scripts && typeof parsed.scripts === "object" && !Array.isArray(parsed.scripts)
      ? (parsed.scripts as Record<string, unknown>)
      : {};

  const scripts = Object.entries(rawScripts)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([name, command]) => ({ name, command }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const packageManager = yield* detectPackageManager(fileSystem, path, input.cwd);

  return { scripts, packageManager } satisfies ProjectReadPackageScriptsResult;
});

function detectPackageManager(
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  cwd: string,
): Effect.Effect<PackageManagerId, never, never> {
  const check = (filename: string) =>
    fileSystem.exists(path.join(cwd, filename)).pipe(Effect.orElseSucceed(() => false));

  return Effect.gen(function* () {
    if (yield* check("bun.lockb")) return "bun" as const;
    if (yield* check("bun.lock")) return "bun" as const;
    if (yield* check("yarn.lock")) return "yarn" as const;
    if (yield* check("pnpm-lock.yaml")) return "pnpm" as const;
    return "npm" as const;
  });
}
