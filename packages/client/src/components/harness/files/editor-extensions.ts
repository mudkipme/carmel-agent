import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

/**
 * What every CodeMirror surface in the app shares -- languages, theme, token
 * colors -- so the editor and the diff viewer cannot drift apart.
 */

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

export function languageExtension(language: EditorLanguage): Extension {
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

export function themeExtensions(dark: boolean): Extension {
  return [
    EditorView.darkTheme.of(dark),
    syntaxHighlighting(dark ? darkHighlightStyle : lightHighlightStyle),
  ];
}

// Chrome colors come from the app's design tokens so the editor tracks the
// light/dark theme without a second palette to keep in sync.
export const editorTheme = EditorView.theme({
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

export function isDarkTheme(themePreference: string) {
  if (themePreference === "dark") return true;
  if (themePreference === "light") return false;
  return document.documentElement.dataset.theme === "dark";
}

export function inferLanguage(filePath: string): EditorLanguage {
  const extension = filePath.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "css":
      return "css";
    case "html":
      return "html";
    case "js":
    case "mjs":
    case "cjs":
      return "javascript";
    case "jsx":
      return "jsx";
    case "json":
      return "json";
    case "md":
    case "markdown":
      return "markdown";
    case "py":
      return "python";
    case "ts":
    case "mts":
    case "cts":
      return "typescript";
    case "tsx":
      return "tsx";
    case "xml":
      return "xml";
    case "yaml":
    case "yml":
      return "yaml";
    default:
      return "plaintext";
  }
}
