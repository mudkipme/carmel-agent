import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";

export type EditorLanguage =
  | "css"
  | "html"
  | "javascript"
  | "json"
  | "jsx"
  | "markdown"
  | "plaintext"
  | "python"
  | "tsx"
  | "typescript"
  | "xml"
  | "yaml";

type CodeEditorProps = {
  value: string;
  language: EditorLanguage;
  dark: boolean;
  onChange: (value: string) => void;
};

const languageCompartment = new Compartment();
const themeCompartment = new Compartment();

export function CodeEditor({ value, language, dark, onChange }: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Read through a ref so the editor is built exactly once: a new onChange
  // identity must not tear it down, and the props only seed the initial state
  // (the effects below push later changes in through transactions).
  const propsRef = useRef({ value, language, dark, onChange });
  propsRef.current = { value, language, dark, onChange };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: propsRef.current.value,
        extensions: [
          baseExtensions(),
          languageCompartment.of(languageExtension(propsRef.current.language)),
          themeCompartment.of(themeExtensions(propsRef.current.dark)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) propsRef.current.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || value === view.state.doc.toString()) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: languageCompartment.reconfigure(languageExtension(language)),
    });
  }, [language]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: themeCompartment.reconfigure(themeExtensions(dark)) });
  }, [dark]);

  return <div ref={hostRef} className="h-full min-h-0 w-full overflow-hidden" />;
}

function baseExtensions(): Extension {
  return [
    editorTheme,
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    highlightSpecialChars(),
    highlightSelectionMatches(),
    foldGutter(),
    history(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    indentOnInput(),
    indentUnit.of("  "),
    bracketMatching(),
    closeBrackets(),
    search({ top: true }),
    EditorState.allowMultipleSelections.of(true),
    EditorView.lineWrapping,
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      indentWithTab,
    ]),
  ];
}

function languageExtension(language: EditorLanguage): Extension {
  switch (language) {
    case "css":
      return css();
    case "html":
      return html();
    case "javascript":
      return javascript();
    case "json":
      return json();
    case "jsx":
      return javascript({ jsx: true });
    case "markdown":
      return markdown();
    case "python":
      return python();
    case "tsx":
      return javascript({ jsx: true, typescript: true });
    case "typescript":
      return javascript({ typescript: true });
    case "xml":
      return xml();
    case "yaml":
      return yaml();
    default:
      return [];
  }
}

function themeExtensions(dark: boolean): Extension {
  return [
    EditorView.darkTheme.of(dark),
    syntaxHighlighting(dark ? darkHighlightStyle : lightHighlightStyle),
  ];
}

// Chrome colors come from the app's design tokens so the editor tracks the
// light/dark theme without a second palette to keep in sync.
const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "13px",
    backgroundColor: "var(--background)",
    color: "var(--foreground)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    lineHeight: "1.6",
  },
  ".cm-content": { padding: "8px 0", caretColor: "var(--foreground)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "color-mix(in oklch, var(--primary) 22%, transparent)",
  },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklch, var(--muted-foreground) 8%, transparent)" },
  ".cm-selectionMatch": {
    backgroundColor: "color-mix(in oklch, var(--primary) 16%, transparent)",
  },
  ".cm-gutters": {
    backgroundColor: "var(--background)",
    color: "var(--muted-foreground)",
    border: "none",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--foreground)",
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--muted)",
    color: "var(--muted-foreground)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-sm)",
    padding: "0 4px",
  },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "color-mix(in oklch, var(--primary) 18%, transparent)",
    outline: "none",
  },
  ".cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket": {
    backgroundColor: "color-mix(in oklch, var(--destructive) 22%, transparent)",
  },
  ".cm-panels": {
    backgroundColor: "var(--card)",
    color: "var(--card-foreground)",
    borderColor: "var(--border)",
  },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },
  ".cm-panel input, .cm-panel button, .cm-panel select": {
    backgroundColor: "var(--background)",
    color: "var(--foreground)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-sm)",
    padding: "1px 4px",
  },
  ".cm-panel label": { color: "var(--muted-foreground)" },
  ".cm-searchMatch": {
    backgroundColor: "color-mix(in oklch, var(--chart-4) 40%, transparent)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "color-mix(in oklch, var(--chart-4) 70%, transparent)",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-md)",
  },
});

// Token colors need concrete hues that the neutral design tokens don't provide;
// these track GitHub's light/dark syntax palettes.
const lightHighlightStyle = HighlightStyle.define([
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "#6e7781", fontStyle: "italic" },
  { tag: [tags.keyword, tags.moduleKeyword, tags.modifier, tags.self, tags.null], color: "#cf222e" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "#0a3069" },
  { tag: [tags.number, tags.bool, tags.atom, tags.constant(tags.variableName)], color: "#0550ae" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.labelName], color: "#8250df" },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.tagName], color: "#953800" },
  { tag: [tags.propertyName, tags.attributeName], color: "#0550ae" },
  { tag: [tags.variableName, tags.definition(tags.variableName)], color: "#24292f" },
  { tag: [tags.operator, tags.operatorKeyword, tags.derefOperator], color: "#0550ae" },
  { tag: [tags.punctuation, tags.separator, tags.bracket], color: "#24292f" },
  { tag: [tags.heading, tags.strong], color: "#0550ae", fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: [tags.link, tags.url], color: "#0a3069", textDecoration: "underline" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.meta, tags.processingInstruction], color: "#6e7781" },
  { tag: tags.invalid, color: "#82071e" },
]);

const darkHighlightStyle = HighlightStyle.define([
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "#8b949e", fontStyle: "italic" },
  { tag: [tags.keyword, tags.moduleKeyword, tags.modifier, tags.self, tags.null], color: "#ff7b72" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "#a5d6ff" },
  { tag: [tags.number, tags.bool, tags.atom, tags.constant(tags.variableName)], color: "#79c0ff" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.labelName], color: "#d2a8ff" },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.tagName], color: "#ffa657" },
  { tag: [tags.propertyName, tags.attributeName], color: "#79c0ff" },
  { tag: [tags.variableName, tags.definition(tags.variableName)], color: "#e6edf3" },
  { tag: [tags.operator, tags.operatorKeyword, tags.derefOperator], color: "#79c0ff" },
  { tag: [tags.punctuation, tags.separator, tags.bracket], color: "#c9d1d9" },
  { tag: [tags.heading, tags.strong], color: "#79c0ff", fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: [tags.link, tags.url], color: "#a5d6ff", textDecoration: "underline" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.meta, tags.processingInstruction], color: "#8b949e" },
  { tag: tags.invalid, color: "#ffa198" },
]);
