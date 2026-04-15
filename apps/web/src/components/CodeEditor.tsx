import { Suspense, lazy, useCallback, useMemo } from "react";
import { Skeleton } from "./ui/skeleton";
import type { Extension } from "@codemirror/state";

const ReactCodeMirror = lazy(() => import("@uiw/react-codemirror"));

// Lazy language loaders – only loaded when needed
const languageLoaders: Record<string, () => Promise<{ extension: unknown }>> = {
  javascript: () =>
    import("@codemirror/lang-javascript").then((m) => ({ extension: m.javascript() })),
  typescript: () =>
    import("@codemirror/lang-javascript").then((m) => ({
      extension: m.javascript({ typescript: true }),
    })),
  tsx: () =>
    import("@codemirror/lang-javascript").then((m) => ({
      extension: m.javascript({ typescript: true, jsx: true }),
    })),
  jsx: () =>
    import("@codemirror/lang-javascript").then((m) => ({
      extension: m.javascript({ jsx: true }),
    })),
  json: () => import("@codemirror/lang-json").then((m) => ({ extension: m.json() })),
  css: () => import("@codemirror/lang-css").then((m) => ({ extension: m.css() })),
  html: () => import("@codemirror/lang-html").then((m) => ({ extension: m.html() })),
  markdown: () => import("@codemirror/lang-markdown").then((m) => ({ extension: m.markdown() })),
  python: () => import("@codemirror/lang-python").then((m) => ({ extension: m.python() })),
  php: () => import("@codemirror/lang-php").then((m) => ({ extension: m.php() })),
};

// Cache resolved extensions
const extensionCache = new Map<string, unknown>();

function useLanguageExtension(language: string) {
  return useMemo(() => {
    const cached = extensionCache.get(language);
    if (cached) return cached;

    const loader = languageLoaders[language];
    if (!loader) return null;

    // Start loading and cache the promise result
    const promise = loader().then((result) => {
      extensionCache.set(language, result.extension);
      return result.extension;
    });
    extensionCache.set(language, promise);
    return null; // Will be available on next render after load
  }, [language]);
}

interface CodeEditorProps {
  value: string;
  language: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  /** Additional CodeMirror extensions (e.g. diff decorations) */
  extraExtensions?: Extension[];
}

function CodeEditorInner({
  value,
  language,
  onChange,
  readOnly = false,
  extraExtensions,
}: CodeEditorProps) {
  const langExtension = useLanguageExtension(language);

  const extensions = useMemo(() => {
    const exts: unknown[] = [];
    if (langExtension && !(langExtension instanceof Promise)) {
      exts.push(langExtension);
    }
    if (extraExtensions) {
      exts.push(...extraExtensions);
    }
    return exts;
  }, [langExtension, extraExtensions]);

  const handleChange = useCallback(
    (val: string) => {
      onChange(val);
    },
    [onChange],
  );

  return (
    <ReactCodeMirror
      value={value}
      onChange={handleChange}
      extensions={extensions as never}
      readOnly={readOnly}
      height="100%"
      theme={
        typeof document !== "undefined" && document.documentElement.classList.contains("dark")
          ? "dark"
          : "light"
      }
      basicSetup={{
        lineNumbers: true,
        highlightActiveLineGutter: true,
        highlightActiveLine: true,
        bracketMatching: true,
        closeBrackets: true,
        autocompletion: false,
        foldGutter: true,
        indentOnInput: true,
      }}
      className="h-full [&_.cm-editor]:h-full [&_.cm-scroller]:overflow-auto"
    />
  );
}

export function CodeEditor(props: CodeEditorProps) {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <Skeleton className="h-8 w-48" />
        </div>
      }
    >
      <CodeEditorInner {...props} />
    </Suspense>
  );
}
