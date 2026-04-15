import { useCallback, useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { CodeEditor } from "./CodeEditor";
import { useFileExplorerStore } from "../fileExplorerStore";
import { fileContentQueryOptions } from "../lib/fileExplorerReactQuery";
import { gitFileDiffQueryOptions } from "../lib/gitReactQuery";
import { createDiffExtension, parseDiffForDecorations } from "../lib/diffDecorations";
import { ensureNativeApi } from "../nativeApi";
import { toastManager } from "./ui/toast";
import { Spinner } from "./ui/spinner";

export function EditorView({ relativePath }: { relativePath: string }) {
  const openFiles = useFileExplorerStore((s) => s.openFiles);
  const setFileDirty = useFileExplorerStore((s) => s.setFileDirty);
  const markFileSaved = useFileExplorerStore((s) => s.markFileSaved);
  const showDiff = useFileExplorerStore((s) => relativePath in s.diffViewPaths);

  const file = openFiles.find((f) => f.relativePath === relativePath);
  const cwd = file?.cwd ?? "";
  const language = file?.language ?? "text";

  const { data, isLoading, error } = useQuery({
    ...fileContentQueryOptions(cwd, relativePath),
    enabled: !!cwd,
  });

  // Fetch diff data when diff mode is active
  const { data: diffData } = useQuery({
    ...gitFileDiffQueryOptions({ cwd, filePath: relativePath }),
    enabled: showDiff && !!cwd,
  });

  // Build diff decorations extension when diff toggle is on
  const diffExtensions = useMemo(() => {
    if (!showDiff || !diffData?.diff) return [];
    const info = parseDiffForDecorations(diffData.diff);
    return [createDiffExtension(info)];
  }, [showDiff, diffData?.diff]);

  // Track the current editor value in a ref (CodeMirror owns state)
  const editorValueRef = useRef<string>("");
  const originalValueRef = useRef<string>("");

  useEffect(() => {
    if (data?.contents != null) {
      editorValueRef.current = data.contents;
      originalValueRef.current = data.contents;
    }
  }, [data?.contents]);

  const handleChange = useCallback(
    (value: string) => {
      editorValueRef.current = value;
      const isDirty = value !== originalValueRef.current;
      setFileDirty(relativePath, isDirty);
    },
    [relativePath, setFileDirty],
  );

  const handleSave = useCallback(async () => {
    if (!cwd) return;
    try {
      const api = ensureNativeApi();
      await api.projects.writeFile({
        cwd,
        relativePath,
        contents: editorValueRef.current,
      });
      originalValueRef.current = editorValueRef.current;
      markFileSaved(relativePath);
      toastManager.add({
        type: "success",
        title: `Saved ${relativePath.split("/").pop()}`,
      });
    } catch (err) {
      toastManager.add({
        type: "error",
        title: "Failed to save file",
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }, [cwd, markFileSaved, relativePath]);

  // Keyboard shortcut: Cmd/Ctrl+S to save
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSave]);

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner className="size-6" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-red-500">
        <p>Failed to load file</p>
        <p className="text-xs text-muted-foreground">{error.message}</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <CodeEditor
        value={data?.contents ?? ""}
        language={language}
        onChange={handleChange}
        extraExtensions={diffExtensions}
      />
    </div>
  );
}
