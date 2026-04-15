import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { type Extension, RangeSetBuilder, StateField } from "@codemirror/state";

// ── Diff line info ───────────────────────────────────────────────────

export interface DiffLineInfo {
  /** 1-based line numbers of added lines in the current file */
  addedLines: Set<number>;
  /** Deleted text blocks keyed by the 1-based line number AFTER which they appear */
  deletedBlocks: Map<number, string[]>;
}

// ── Parse unified diff → DiffLineInfo ────────────────────────────────

export function parseDiffForDecorations(diff: string): DiffLineInfo {
  const addedLines = new Set<number>();
  const deletedBlocks = new Map<number, string[]>();
  const lines = diff.split("\n");

  let newLineNo = 0;

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      newLineNo = Number.parseInt(hunkMatch[1]!, 10);
      continue;
    }
    if (newLineNo === 0) continue; // skip header lines

    if (line.startsWith("+") && !line.startsWith("+++")) {
      addedLines.add(newLineNo);
      newLineNo++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      // Deleted line: group at the line BEFORE it in the new file
      const anchor = newLineNo - 1; // line after which deletion appears
      const existing = deletedBlocks.get(anchor) ?? [];
      existing.push(line.slice(1));
      deletedBlocks.set(anchor, existing);
    } else if (line.startsWith(" ") || line === "") {
      newLineNo++;
    }
  }

  return { addedLines, deletedBlocks };
}

// ── Decoration styles ────────────────────────────────────────────────

const addedLineDecoration = Decoration.line({
  class: "cm-diff-added",
});

const addedGutterDecoration = Decoration.line({
  class: "cm-diff-added-gutter",
});

// ── Widget for deleted lines ─────────────────────────────────────────

class DeletedLinesWidget extends WidgetType {
  constructor(readonly lines: string[]) {
    super();
  }

  override toDOM(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "cm-diff-deleted-block";
    for (const text of this.lines) {
      const lineEl = document.createElement("div");
      lineEl.className = "cm-diff-deleted-line";
      lineEl.textContent = `− ${text}`;
      wrapper.appendChild(lineEl);
    }
    return wrapper;
  }

  override eq(other: DeletedLinesWidget): boolean {
    return (
      this.lines.length === other.lines.length && this.lines.every((l, i) => l === other.lines[i])
    );
  }

  override get estimatedHeight(): number {
    return this.lines.length * 20;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

// ── Build decorations from DiffLineInfo ──────────────────────────────

function buildDecorations(view: EditorView, diffInfo: DiffLineInfo): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;

  // We need to add decorations in document order (ascending position)
  // First collect all decorations with positions, then sort

  const decorations: Array<{ from: number; to?: number; decoration: Decoration }> = [];

  for (let lineNo = 1; lineNo <= doc.lines; lineNo++) {
    const line = doc.line(lineNo);

    // Deleted block widget BEFORE this line (anchored at lineNo-1)
    // For lineNo=1, anchor=0 means deletions at the very start
    const deletedBefore = diffInfo.deletedBlocks.get(lineNo - 1);
    if (deletedBefore) {
      decorations.push({
        from: line.from,
        decoration: Decoration.widget({
          widget: new DeletedLinesWidget(deletedBefore),
          block: true,
          side: -1, // before the line
        }),
      });
    }

    // Added line highlight
    if (diffInfo.addedLines.has(lineNo)) {
      decorations.push({ from: line.from, decoration: addedLineDecoration });
      decorations.push({ from: line.from, decoration: addedGutterDecoration });
    }
  }

  // Handle deletions after the last line
  const deletedAfterLast = diffInfo.deletedBlocks.get(doc.lines);
  if (deletedAfterLast) {
    const lastLine = doc.line(doc.lines);
    decorations.push({
      from: lastLine.to,
      decoration: Decoration.widget({
        widget: new DeletedLinesWidget(deletedAfterLast),
        block: true,
        side: 1, // after the line
      }),
    });
  }

  // Sort by position (required by RangeSetBuilder)
  decorations.sort((a, b) => a.from - b.from);

  for (const d of decorations) {
    builder.add(d.from, d.to ?? d.from, d.decoration);
  }

  return builder.finish();
}

// ── CodeMirror extension ─────────────────────────────────────────────

const diffTheme = EditorView.baseTheme({
  ".cm-diff-added": {
    backgroundColor: "rgba(16, 185, 129, 0.12)", // emerald
  },
  ".cm-diff-deleted-block": {
    borderLeft: "2px solid rgba(239, 68, 68, 0.5)",
    marginLeft: "4px",
  },
  ".cm-diff-deleted-line": {
    backgroundColor: "rgba(239, 68, 68, 0.08)",
    color: "rgba(239, 68, 68, 0.7)",
    padding: "0 16px 0 8px",
    fontFamily: "inherit",
    fontSize: "inherit",
    lineHeight: "inherit",
    whiteSpace: "pre",
    textDecoration: "line-through",
    textDecorationColor: "rgba(239, 68, 68, 0.3)",
  },
});

/**
 * Creates a CodeMirror extension that highlights diff changes inline.
 * Added lines get a green background, deleted lines appear as read-only
 * widgets with red background + strikethrough.
 */
export function createDiffExtension(diffInfo: DiffLineInfo): Extension {
  const field = StateField.define<DecorationSet>({
    create(state) {
      // Build initial decorations using a temporary EditorView-like interface
      // We can use the state's doc directly
      const builder = new RangeSetBuilder<Decoration>();
      const doc = state.doc;

      const decorations: Array<{ from: number; decoration: Decoration }> = [];

      for (let lineNo = 1; lineNo <= doc.lines; lineNo++) {
        const line = doc.line(lineNo);
        const deletedBefore = diffInfo.deletedBlocks.get(lineNo - 1);
        if (deletedBefore) {
          decorations.push({
            from: line.from,
            decoration: Decoration.widget({
              widget: new DeletedLinesWidget(deletedBefore),
              block: true,
              side: -1,
            }),
          });
        }
        if (diffInfo.addedLines.has(lineNo)) {
          decorations.push({ from: line.from, decoration: addedLineDecoration });
        }
      }

      const deletedAfterLast = diffInfo.deletedBlocks.get(doc.lines);
      if (deletedAfterLast) {
        const lastLine = doc.line(doc.lines);
        decorations.push({
          from: lastLine.to,
          decoration: Decoration.widget({
            widget: new DeletedLinesWidget(deletedAfterLast),
            block: true,
            side: 1,
          }),
        });
      }

      decorations.sort((a, b) => a.from - b.from);
      for (const d of decorations) {
        builder.add(d.from, d.from, d.decoration);
      }
      return builder.finish();
    },
    update(deco, tr) {
      if (!tr.docChanged) return deco;
      // On document changes, remap but don't rebuild (decorations become stale – acceptable)
      return deco.map(tr.changes);
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  return [field, diffTheme];
}
