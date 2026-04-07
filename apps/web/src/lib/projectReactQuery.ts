import type { ProjectSearchEntriesResult } from "@codewithme/contracts";
import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";

export const projectQueryKeys = {
  all: ["projects"] as const,
  searchEntries: (cwd: string | null, query: string, limit: number) =>
    ["projects", "search-entries", cwd, query, limit] as const,
  packageScripts: (cwd: string | null) => ["projects", "package-scripts", cwd] as const,
};

const DEFAULT_SEARCH_ENTRIES_LIMIT = 80;
const DEFAULT_SEARCH_ENTRIES_STALE_TIME = 15_000;
const EMPTY_SEARCH_ENTRIES_RESULT: ProjectSearchEntriesResult = {
  entries: [],
  truncated: false,
};

export function projectSearchEntriesQueryOptions(input: {
  cwd: string | null;
  query: string;
  enabled?: boolean;
  limit?: number;
  staleTime?: number;
}) {
  const limit = input.limit ?? DEFAULT_SEARCH_ENTRIES_LIMIT;
  return queryOptions({
    queryKey: projectQueryKeys.searchEntries(input.cwd, input.query, limit),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) {
        throw new Error("Workspace entry search is unavailable.");
      }
      return api.projects.searchEntries({
        cwd: input.cwd,
        query: input.query,
        limit,
      });
    },
    enabled: (input.enabled ?? true) && input.cwd !== null && input.query.length > 0,
    staleTime: input.staleTime ?? DEFAULT_SEARCH_ENTRIES_STALE_TIME,
    placeholderData: (previous) => previous ?? EMPTY_SEARCH_ENTRIES_RESULT,
  });
}

const PACKAGE_SCRIPTS_STALE_TIME = 30_000;

export function packageScriptsQueryOptions(input: { cwd: string | null }) {
  return queryOptions({
    queryKey: projectQueryKeys.packageScripts(input.cwd),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Package scripts query requires a cwd.");
      return api.projects.readPackageScripts({ cwd: input.cwd });
    },
    enabled: input.cwd !== null,
    staleTime: PACKAGE_SCRIPTS_STALE_TIME,
    retry: false,
  });
}

export function invalidatePackageScriptsQuery(queryClient: QueryClient, cwd: string | null) {
  return queryClient.invalidateQueries({
    queryKey: projectQueryKeys.packageScripts(cwd),
  });
}
