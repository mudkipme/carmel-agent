import Editor, { loader } from "@monaco-editor/react";
import { RotateCcwIcon, SaveIcon } from "lucide-react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentConfig } from "@carmel-agent/shared";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useThemePreference } from "@/lib/theme";

const monacoGlobal = globalThis as typeof globalThis & {
  MonacoEnvironment?: { getWorker: () => Worker };
};

monacoGlobal.MonacoEnvironment ??= {
  getWorker: () => new editorWorker(),
};
loader.config({ monaco });

type FileEditorViewProps = {
  agent?: AgentConfig;
  filePath?: string;
};

export function FileEditorView({ agent, filePath }: FileEditorViewProps) {
  const themePreference = useThemePreference();
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [loading, setLoading] = useState(Boolean(agent && filePath));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const isDirty = content !== savedContent;
  const editorTheme = resolveEditorTheme(themePreference);

  const loadFile = useCallback(async () => {
    if (!agent || !filePath) return;
    try {
      const result = await api.readAgentFile(agent.id, filePath);
      setContent(result.content);
      setSavedContent(result.content);
    } catch (loadError) {
      setContent("");
      setSavedContent("");
      setError(loadError instanceof Error ? loadError.message : "Unable to open file");
    } finally {
      setLoading(false);
    }
  }, [agent, filePath]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadFile();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadFile]);

  const saveFile = async () => {
    if (!agent || !filePath) return;
    setSaving(true);
    setError("");
    try {
      const result = await api.saveAgentFile(agent.id, filePath, content);
      setContent(result.content);
      setSavedContent(result.content);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save file");
    } finally {
      setSaving(false);
    }
  };

  const language = useMemo(() => inferLanguage(filePath ?? ""), [filePath]);

  if (!agent) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        Select an agent to browse files.
      </div>
    );
  }

  if (!filePath) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        Select a file from the sidebar.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b px-4">
        <div className="min-w-0">
          <h2 className="truncate text-[13px] font-medium">{filePath}</h2>
          <p className="truncate text-xs text-muted-foreground">
            {isDirty ? "Unsaved changes" : "Saved"}
            {loading ? " · Loading..." : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="outline" disabled={!isDirty || saving || loading} onClick={() => setContent(savedContent)}>
            <RotateCcwIcon />
            Discard
          </Button>
          <Button size="sm" disabled={!isDirty || saving || loading} onClick={() => void saveFile()}>
            <SaveIcon />
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>
      {error ? <div className="border-b px-4 py-2 text-xs text-destructive">{error}</div> : null}
      <div className="min-h-0 flex-1">
        <Editor
          path={filePath}
          language={language}
          theme={editorTheme}
          value={content}
          loading={<div className="p-4 text-sm text-muted-foreground">Loading editor...</div>}
          options={{
            automaticLayout: true,
            fontSize: 13,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            wordWrap: "on",
          }}
          onChange={(value) => setContent(value ?? "")}
        />
      </div>
    </div>
  );
}

function resolveEditorTheme(themePreference: string) {
  if (themePreference === "dark") return "vs-dark";
  if (themePreference === "light") return "vs";
  return document.documentElement.dataset.theme === "dark" ? "vs-dark" : "vs";
}

function inferLanguage(filePath: string) {
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
      return "typescript";
    case "xml":
      return "xml";
    case "yaml":
    case "yml":
      return "yaml";
    default:
      return "plaintext";
  }
}
