import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
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
import { useEffect, useRef } from "react";
import {
  editorTheme,
  languageExtension,
  themeExtensions,
  type EditorLanguage,
} from "./editor-extensions";

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
