import { create } from "zustand";

// ── Types ────────────────────────────────────────────────────────────

export interface OpenFileEntry {
  relativePath: string;
  cwd: string;
  language: string;
  isDirty: boolean;
}

interface FileExplorerState {
  /** Whether the file explorer panel is open (cwd comes from the active project) */
  explorerOpen: boolean;
  /** Per-cwd expanded directories (plain object for Zustand serialisation) */
  expandedDirsByCwd: Record<string, Record<string, true>>;
  /** Currently open files */
  openFiles: OpenFileEntry[];
  /** Active file path (null = show chat) */
  activeFilePath: string | null;
  /** Files currently showing diff view instead of editor */
  diffViewPaths: Record<string, true>;
  /** Files currently showing markdown preview instead of editor */
  markdownViewPaths: Record<string, true>;
}

interface FileExplorerActions {
  toggleExplorer: () => void;
  closeExplorer: () => void;
  toggleDirectory: (cwd: string, dirPath: string) => void;
  openFile: (cwd: string, relativePath: string) => void;
  closeFile: (relativePath: string) => void;
  setActiveFile: (relativePath: string | null) => void;
  setFileDirty: (relativePath: string, dirty: boolean) => void;
  markFileSaved: (relativePath: string) => void;
  toggleDiffView: (relativePath: string) => void;
  toggleMarkdownView: (relativePath: string) => void;
}

// ── Language detection ───────────────────────────────────────────────

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  css: "css",
  scss: "css",
  html: "html",
  htm: "html",
  vue: "html",
  svelte: "html",
  md: "markdown",
  mdx: "markdown",
  py: "python",
  php: "php",
  yaml: "yaml",
  yml: "yaml",
  xml: "html",
  svg: "html",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
};

export function detectLanguage(relativePath: string): string {
  const ext = relativePath.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_TO_LANGUAGE[ext] ?? "text";
}

// ── Store ────────────────────────────────────────────────────────────

export const useFileExplorerStore = create<FileExplorerState & FileExplorerActions>()(
  (set, get) => ({
    explorerOpen: false,
    expandedDirsByCwd: {},
    openFiles: [],
    activeFilePath: null,
    diffViewPaths: {},
    markdownViewPaths: {},

    toggleExplorer: () =>
      set((state) => ({
        explorerOpen: !state.explorerOpen,
      })),

    closeExplorer: () => set({ explorerOpen: false }),

    toggleDirectory: (cwd, dirPath) =>
      set((state) => {
        const cwdDirs = state.expandedDirsByCwd[cwd] ?? {};
        const isExpanded = dirPath in cwdDirs;
        const nextCwdDirs = { ...cwdDirs };

        if (isExpanded) {
          delete nextCwdDirs[dirPath];
        } else {
          nextCwdDirs[dirPath] = true;
        }

        return {
          expandedDirsByCwd: {
            ...state.expandedDirsByCwd,
            [cwd]: nextCwdDirs,
          },
        };
      }),

    openFile: (cwd, relativePath) => {
      const state = get();
      const existing = state.openFiles.find(
        (f) => f.relativePath === relativePath && f.cwd === cwd,
      );
      if (existing) {
        set({ activeFilePath: relativePath });
        return;
      }

      set({
        openFiles: [
          ...state.openFiles,
          {
            relativePath,
            cwd,
            language: detectLanguage(relativePath),
            isDirty: false,
          },
        ],
        activeFilePath: relativePath,
      });
    },

    closeFile: (relativePath) =>
      set((state) => {
        const nextFiles = state.openFiles.filter((f) => f.relativePath !== relativePath);
        let nextActive = state.activeFilePath;

        if (state.activeFilePath === relativePath) {
          // Switch to previous tab or chat
          const closedIndex = state.openFiles.findIndex((f) => f.relativePath === relativePath);
          const fallback = nextFiles[Math.min(closedIndex, nextFiles.length - 1)];
          nextActive = fallback?.relativePath ?? null;
        }

        return { openFiles: nextFiles, activeFilePath: nextActive };
      }),

    setActiveFile: (relativePath) => set({ activeFilePath: relativePath }),

    setFileDirty: (relativePath, dirty) =>
      set((state) => ({
        openFiles: state.openFiles.map((f) =>
          f.relativePath === relativePath ? { ...f, isDirty: dirty } : f,
        ),
      })),

    markFileSaved: (relativePath) =>
      set((state) => ({
        openFiles: state.openFiles.map((f) =>
          f.relativePath === relativePath ? { ...f, isDirty: false } : f,
        ),
      })),

    toggleDiffView: (relativePath) =>
      set((state) => {
        const next = { ...state.diffViewPaths };
        if (relativePath in next) {
          delete next[relativePath];
        } else {
          next[relativePath] = true;
        }
        return { diffViewPaths: next };
      }),

    toggleMarkdownView: (relativePath) =>
      set((state) => {
        const next = { ...state.markdownViewPaths };
        if (relativePath in next) {
          delete next[relativePath];
        } else {
          next[relativePath] = true;
        }
        return { markdownViewPaths: next };
      }),
  }),
);
