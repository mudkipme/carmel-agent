import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { ArrowLeftIcon, DownloadIcon, RotateCcwIcon, SaveIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentConfig } from "@carmel-agent/shared";
import { CodeEditor } from "@/components/harness/files/CodeEditor";
import { inferLanguage, isDarkTheme } from "@/components/harness/files/editor-extensions";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MarkdownContent } from "@/components/chat/MarkdownContent";
import {
  WorkspaceFileLinkAgentContext,
  WorkspaceFilePathContext,
} from "@/components/chat/workspace-file-links";
import { api } from "@/lib/api";
import { useThemePreference } from "@/lib/theme";
import { errorMessage } from "@/lib/errors";
import { UnsavedChangesDialog } from "@/components/harness/UnsavedChangesDialog";

type FileEditorViewProps = {
  agent?: AgentConfig;
  filePath?: string;
  onClose?: () => void;
};

export function FileEditorView({ agent, filePath, onClose }: FileEditorViewProps) {
  const { i18n } = useLingui();
  const themePreference = useThemePreference();
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [loading, setLoading] = useState(Boolean(agent && filePath));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [markdownMode, setMarkdownMode] = useState("preview");
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
      setError(errorMessage(loadError, i18n._("Unable to open file")));
    } finally {
      setLoading(false);
    }
  }, [agent, filePath, i18n]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadFile();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadFile]);

  const saveFile = async () => {
    if (!agent || !filePath || saving) return false;
    setSaving(true);
    setError("");
    try {
      const result = await api.saveAgentFile(agent.id, filePath, content);
      setContent((current) => (current === content ? result.content : current));
      setSavedContent(result.content);
      return true;
    } catch (saveError) {
      setError(errorMessage(saveError, i18n._("Unable to save file")));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const language = useMemo(() => inferLanguage(filePath ?? ""), [filePath]);
  const isMarkdown = language === "markdown";

  if (!agent) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        <Trans>Select an agent to browse files.</Trans>
      </div>
    );
  }

  if (!filePath) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        <Trans>Select a file from the sidebar.</Trans>
      </div>
    );
  }

  const header = (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
      <div className="flex min-w-0 flex-1 basis-full items-center gap-2 @[48rem]/file-editor:basis-0">
        {onClose ? (
          <Button size="icon-sm" variant="ghost" title={i18n._("Back to files")} onClick={onClose}>
            <ArrowLeftIcon />
          </Button>
        ) : null}
        <div className="min-w-0">
          <h2 className="truncate text-[13px] font-medium" title={filePath}>
            {filePath}
          </h2>
          <p className="truncate text-xs text-muted-foreground">
            {isImage
              ? i18n._("Image preview")
              : isDirty
                ? i18n._("Unsaved changes")
                : i18n._("Saved")}
            {loading ? " · Loading..." : ""}
          </p>
        </div>
      </div>
      <div className="flex max-w-full flex-wrap items-center gap-2">
        {isMarkdown ? (
          <TabsList aria-label={i18n._("Markdown view")}>
            <TabsTrigger value="preview">
              <Trans>Preview</Trans>
            </TabsTrigger>
            <TabsTrigger value="edit" disabled={loading}>
              <Trans>Edit</Trans>
            </TabsTrigger>
          </TabsList>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          title={i18n._("Download this file")}
          aria-label={i18n._("Download this file")}
          onClick={() => downloadFile(agent.id, filePath)}
        >
          <DownloadIcon />
          <span className="hidden @[32rem]/file-editor:inline">
            <Trans>Download</Trans>
          </span>
        </Button>
        {!isImage ? (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={!isDirty || saving || loading}
              aria-label={i18n._("Discard")}
              title={i18n._("Discard unsaved changes")}
              onClick={() => setContent(savedContent)}
            >
              <RotateCcwIcon />
              <span className="hidden @[32rem]/file-editor:inline">
                <Trans>Discard</Trans>
              </span>
            </Button>
            <Button
              size="sm"
              disabled={!isDirty || saving || loading}
              aria-label={saving ? i18n._("Saving...") : i18n._("Save")}
              title={i18n._("Save file")}
              onClick={() => void saveFile()}
            >
              <SaveIcon />
              <span className="hidden @[32rem]/file-editor:inline">
                {saving ? i18n._("Saving...") : i18n._("Save")}
              </span>
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
  const feedback = error ? (
    <div role="alert" className="border-b px-4 py-2 text-xs text-destructive">
      {error}
    </div>
  ) : null;
  const editor = (
    <CodeEditor language={language} dark={darkEditor} value={content} onChange={setContent} />
  );
  const rootClassName = "@container/file-editor flex h-full min-h-0 flex-col gap-0 bg-background";
  const navigationGuard = (
    <UnsavedChangesDialog
      dirty={isDirty}
      saving={saving}
      shouldBlock={({ currentLocation, nextLocation }) =>
        currentLocation.pathname !== nextLocation.pathname
      }
      onSave={saveFile}
    />
  );

  if (isMarkdown) {
    return (
      <Tabs value={markdownMode} onValueChange={setMarkdownMode} className={rootClassName}>
        {navigationGuard}
        {header}
        {feedback}
        <TabsContent
          value="preview"
          className="min-h-0 overflow-auto p-4 data-[state=inactive]:hidden sm:p-6"
        >
          {loading ? (
            <p className="text-sm text-muted-foreground">
              <Trans>Loading Markdown…</Trans>
            </p>
          ) : (
            <div className="mx-auto max-w-[var(--line-width)]">
              <WorkspaceFileLinkAgentContext value={agent.id}>
                <WorkspaceFilePathContext value={filePath}>
                  <MarkdownContent content={content} preserveLineBreaks={false} />
                </WorkspaceFilePathContext>
              </WorkspaceFileLinkAgentContext>
            </div>
          )}
        </TabsContent>
        <TabsContent value="edit" forceMount className="min-h-0 data-[state=inactive]:hidden">
          {loading ? null : editor}
        </TabsContent>
      </Tabs>
    );
  }

  return (
    <div className={rootClassName}>
      {navigationGuard}
      {header}
      {feedback}
      <div className="min-h-0 flex-1">
        {isImage ? <ImagePreview agentId={agent.id} filePath={filePath} /> : editor}
      </div>
    </div>
  );
}

function downloadFile(agentId: string, filePath: string) {
  const link = document.createElement("a");
  link.href = api.getAgentFileDownloadUrl(agentId, [filePath]);
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

function ImagePreview({ agentId, filePath }: { agentId: string; filePath: string }) {
  const [failedUrl, setFailedUrl] = useState("");
  const imageUrl = useMemo(() => api.getAgentFileRawUrl(agentId, filePath), [agentId, filePath]);
  const failed = failedUrl === imageUrl;

  if (failed) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        <Trans>Unable to preview this image.</Trans>
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

function isImageFile(filePath: string) {
  return ["apng", "avif", "gif", "jpeg", "jpg", "png", "svg", "webp"].includes(
    filePath.split(".").pop()?.toLowerCase() ?? "",
  );
}
