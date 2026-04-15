import type { ProjectListDirectoryResult, ProjectReadFileResult } from "@codewithme/contracts";
import { ensureNativeApi } from "../nativeApi";

export const fileExplorerQueryKeys = {
  all: ["file-explorer"] as const,
  directory: (cwd: string, dirPath: string) =>
    ["file-explorer", "directory", cwd, dirPath] as const,
  fileContent: (cwd: string, relativePath: string) =>
    ["file-explorer", "file", cwd, relativePath] as const,
};

export function directoryListingQueryOptions(cwd: string, dirPath?: string) {
  return {
    queryKey: fileExplorerQueryKeys.directory(cwd, dirPath ?? ""),
    queryFn: async (): Promise<ProjectListDirectoryResult> => {
      const api = ensureNativeApi();
      return api.projects.listDirectory({
        cwd,
        ...(dirPath ? { directoryPath: dirPath } : {}),
      });
    },
    staleTime: 15_000,
  };
}

export function fileContentQueryOptions(cwd: string, relativePath: string) {
  return {
    queryKey: fileExplorerQueryKeys.fileContent(cwd, relativePath),
    queryFn: async (): Promise<ProjectReadFileResult> => {
      const api = ensureNativeApi();
      return api.projects.readFile({ cwd, relativePath });
    },
    staleTime: 0, // Agent can modify files at any time
    gcTime: 5 * 60 * 1000, // Keep in cache 5min for tab switching
  };
}
