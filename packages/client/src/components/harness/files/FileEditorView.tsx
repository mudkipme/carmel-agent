import { RotateCcwIcon, SaveIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentConfig } from "@carmel-agent/shared";
import { CodeEditor, type EditorLanguage } from "@/components/harness/files/CodeEditor";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useThemePreference } from "@/lib/theme";

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
  const isImage = isImageFile(filePath ?? "");
  const isDirty = content !== savedContent;
  const darkEditor = isDarkTheme(themePreference);

  const loadFile = useCallback(async () => {
    if (!agent || !filePath) return;
    if (isImageFile(filePath)) {
      setContent("");
      setSavedContent("");
      setError("");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
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
            {isImage ? "Image preview" : isDirty ? "Unsaved changes" : "Saved"}
            {loading ? " · Loading..." : ""}
          </p>
        </div>
        {!isImage ? (
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
        ) : null}
      </div>
      {error ? <div className="border-b px-4 py-2 text-xs text-destructive">{error}</div> : null}
      <div className="min-h-0 flex-1">
        {isImage ? (
          <ImagePreview agentId={agent.id} filePath={filePath} />
        ) : (
          <CodeEditor language={language} dark={darkEditor} value={content} onChange={setContent} />
        )}
      </div>
    </div>
  );
}

function ImagePreview({ agentId, filePath }: { agentId: string; filePath: string }) {
  const [failedUrl, setFailedUrl] = useState("");
  const imageUrl = useMemo(() => api.getAgentFileRawUrl(agentId, filePath), [agentId, filePath]);
  const failed = failedUrl === imageUrl;

  if (failed) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        Unable to preview this image.
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center overflow-auto bg-muted/30 p-6">
      <img
        src={imageUrl}
        alt={filePath}
        className="max-h-full max-w-full rounded-md border bg-background object-contain shadow-sm"
        onError={() => setFailedUrl(imageUrl)}
      />
    </div>
  );
}

function isDarkTheme(themePreference: string) {
  if (themePreference === "dark") return true;
  if (themePreference === "light") return false;
  return document.documentElement.dataset.theme === "dark";
}

function inferLanguage(filePath: string): EditorLanguage {
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

function isImageFile(filePath: string) {
  return ["apng", "avif", "gif", "jpeg", "jpg", "png", "svg", "webp"].includes(
    filePath.split(".").pop()?.toLowerCase() ?? "",
  );
}
