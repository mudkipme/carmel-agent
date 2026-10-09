import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { useEffect, useRef } from "react";
import {
  editorTheme,
  languageExtension,
  themeExtensions,
  type EditorLanguage,
} from "@/components/harness/files/editor-extensions";

export type DiffLayout = "split" | "unified";

type DiffViewerProps = {
  original: string;
  modified: string;
  language: EditorLanguage;
  dark: boolean;
  layout: DiffLayout;
};

/** Unchanged runs longer than this fold away, keeping a few lines of context either side. */
const COLLAPSE_UNCHANGED = { margin: 3, minSize: 8 };

/**
 * A read-only diff of two texts. Split is two synced editors side by side;
 * unified is one editor showing the modified text with deletions inline.
 *
 * Rebuilt whenever an input changes -- the key on the caller does that -- since
 * a diff is cheap to recompute and a MergeView cannot swap layout in place.
 */
export function DiffViewer({ original, modified, language, dark, layout }: DiffViewerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const extensions = readOnlyExtensions(language, dark);

    if (layout === "split") {
      const view = new MergeView({
        a: { doc: original, extensions },
        b: { doc: modified, extensions },
        parent: host,
        gutter: true,
        highlightChanges: true,
        collapseUnchanged: COLLAPSE_UNCHANGED,
      });
      return () => view.destroy();
    }

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: modified,
        extensions: [
          extensions,
          unifiedMergeView({
            original,
            gutter: true,
            highlightChanges: true,
            mergeControls: false,
            collapseUnchanged: COLLAPSE_UNCHANGED,
          }),
        ],
      }),
    });
    return () => view.destroy();
  }, [dark, language, layout, modified, original]);

  return <div ref={hostRef} className="diff-viewer h-full min-h-0 w-full overflow-auto" />;
}

function readOnlyExtensions(language: EditorLanguage, dark: boolean): Extension {
  return [
    editorTheme,
    diffTheme,
    lineNumbers(),
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorView.lineWrapping,
    languageExtension(language),
    themeExtensions(dark),
  ];
}

/**
 * Change colors from the design tokens, so both themes read the same way:
 * green for what the modified side adds, red for what it removes.
 */
const diffTheme = EditorView.theme({
  "&": { height: "auto", minHeight: "100%" },
  ".cm-changedLine": {
    backgroundColor: "color-mix(in oklch, var(--color-green) 12%, transparent)",
  },
  ".cm-changedText": {
    backgroundColor: "color-mix(in oklch, var(--color-green) 30%, transparent)",
  },
  ".cm-deletedChunk, .cm-merge-a .cm-changedLine": {
    backgroundColor: "color-mix(in oklch, var(--destructive) 12%, transparent)",
  },
  ".cm-deletedChunk .cm-deletedText, .cm-merge-a .cm-changedText": {
    backgroundColor: "color-mix(in oklch, var(--destructive) 28%, transparent)",
  },
  ".cm-collapsedLines": {
    backgroundColor: "var(--muted)",
    color: "var(--muted-foreground)",
    fontSize: "12px",
    padding: "2px 12px",
  },
  ".cm-changeGutter": { width: "3px", paddingLeft: "1px" },
});
