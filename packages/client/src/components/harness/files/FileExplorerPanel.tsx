import {
  ChevronLeftIcon,
  FileIcon,
  FilePlusIcon,
  FolderIcon,
  FolderPlusIcon,
  PencilIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { AgentConfig, AgentFileEntry } from "@carmel-agent/shared";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { confirmAction, promptText } from "@/lib/action-dialogs";
import { errorMessage, showError } from "@/lib/errors";

type FileExplorerPanelProps = {
  agent?: AgentConfig;
  selectedFilePath?: string;
  onOpenFile: (path: string) => void;
  onAfterOpen?: () => void;
};

export function FileExplorerPanel({ agent, selectedFilePath, onOpenFile, onAfterOpen }: FileExplorerPanelProps) {
  const agentId = agent?.id;
  const [currentPath, setCurrentPath] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [entries, setEntries] = useState<AgentFileEntry[]>([]);
  const [loading, setLoading] = useState(Boolean(agentId));
  const [error, setError] = useState("");
  const loadRequestIdRef = useRef(0);
  const currentPathRef = useRef("");
  const showHiddenRef = useRef(false);

  const loadEntries = useCallback(async (path: string, hidden: boolean, immediateLoading = true) => {
    if (!agentId) return;
    const requestId = loadRequestIdRef.current + 1;
    loadRequestIdRef.current = requestId;
    if (immediateLoading) {
      setLoading(true);
      setError("");
    }
    try {
      const result = await api.listAgentFiles(agentId, path, hidden);
      if (requestId !== loadRequestIdRef.current) return;
      setEntries(result.entries);
    } catch (loadError) {
      if (requestId !== loadRequestIdRef.current) return;
      setError(errorMessage(loadError, "Unable to load files"));
    } finally {
      if (requestId === loadRequestIdRef.current) setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadEntries("", showHiddenRef.current, false);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadEntries]);

  const refreshEntries = () => {
    void loadEntries(currentPathRef.current, showHiddenRef.current);
  };

  const toggleShowHidden = (hidden: boolean) => {
    showHiddenRef.current = hidden;
    setShowHidden(hidden);
    void loadEntries(currentPathRef.current, hidden);
  };

  const openEntry = (entry: AgentFileEntry) => {
    if (entry.type === "directory") {
      openDirectory(entry.path);
      return;
    }
    onOpenFile(entry.path);
    onAfterOpen?.();
  };

  const handleEntryKeyDown = (event: KeyboardEvent<HTMLDivElement>, entry: AgentFileEntry) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openEntry(entry);
  };

  const createEntry = async (type: AgentFileEntry["type"]) => {
    if (!agent) return;
    const label = type === "directory" ? "Folder name" : "File name";
    const name = await promptText({
      title: label,
      actionLabel: type === "directory" ? "Create folder" : "Create file",
    });
    const cleanName = name?.trim();
    if (!cleanName) return;
    try {
      await api.createAgentFileEntry(agent.id, joinPath(currentPath, cleanName), type);
      await loadEntries(currentPathRef.current, showHiddenRef.current);
    } catch (createError) {
      showError("Unable to create entry", createError);
    }
  };

  const openDirectory = (path: string) => {
    currentPathRef.current = path;
    loadRequestIdRef.current += 1;
    setCurrentPath(path);
    setEntries([]);
    setError("");
    setLoading(true);
    void loadEntries(path, showHiddenRef.current);
  };

  const renameEntry = async (entry: AgentFileEntry) => {
    if (!agent) return;
    const nextName = await promptText({ title: `Rename ${entry.name}`, initialValue: entry.name });
    const cleanName = nextName?.trim();
    if (!cleanName || cleanName === entry.name) return;
    try {
      await api.renameAgentFileEntry(agent.id, entry.path, joinPath(parentPath(entry.path), cleanName));
      await loadEntries(currentPathRef.current, showHiddenRef.current);
    } catch (renameError) {
      showError("Unable to rename entry", renameError);
    }
  };

  const deleteEntry = async (entry: AgentFileEntry) => {
    if (!agent) return;
    const confirmed = await confirmAction({
      title: `Delete “${entry.name}”?`,
      description: "This filesystem entry will be permanently deleted.",
      actionLabel: "Delete",
    });
    if (!confirmed) return;
    try {
      await api.deleteAgentFileEntry(agent.id, entry.path);
      if (entry.path === selectedFilePath) onOpenFile("");
      await loadEntries(currentPathRef.current, showHiddenRef.current);
    } catch (deleteError) {
      showError("Unable to delete entry", deleteError);
    }
  };

  if (!agent) {
    return <p className="px-2 text-xs text-muted-foreground">Select an agent to browse files.</p>;
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center justify-between gap-2 px-2">
        <div className="flex min-w-0 items-center gap-1">
          <Button
            size="icon-xs"
            variant="ghost"
            title="Parent folder"
            disabled={!currentPath}
            onClick={() => openDirectory(parentPath(currentPath))}
          >
            <ChevronLeftIcon />
          </Button>
          <span className="text-ui-smaller truncate font-mono text-muted-foreground">{currentPath || "."}</span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button size="icon-xs" variant="ghost" title="New file" onClick={() => void createEntry("file")}>
            <FilePlusIcon />
          </Button>
          <Button size="icon-xs" variant="ghost" title="New folder" onClick={() => void createEntry("directory")}>
            <FolderPlusIcon />
          </Button>
          <Button size="icon-xs" variant="ghost" title="Refresh" onClick={refreshEntries}>
            <RefreshCwIcon />
          </Button>
        </div>
      </div>
      <label className="flex items-center justify-between px-2 text-xs text-muted-foreground">
        <span>Show hidden files</span>
        <Switch size="sm" checked={showHidden} onCheckedChange={toggleShowHidden} />
      </label>
      {error ? <p className="px-2 text-xs break-words text-destructive">{error}</p> : null}
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto">
        {loading ? <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading files...</p> : null}
        {!loading && entries.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">No files</p>
        ) : null}
        {entries.map((entry) => (
          <div
            key={entry.path}
            data-active={entry.path === selectedFilePath}
            className="nav-item group flex cursor-default items-center gap-1 rounded-md px-2 py-1.5"
            role="button"
            tabIndex={0}
            onClick={() => openEntry(entry)}
            onKeyDown={(event) => handleEntryKeyDown(event, entry)}
          >
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {entry.type === "directory" ? (
                <FolderIcon className="size-3.5 shrink-0 text-faint" />
              ) : (
                <FileIcon className="size-3.5 shrink-0 text-faint" />
              )}
              <span className="truncate text-[13px]">{entry.name}</span>
            </div>
            <div className="coarse-pointer-visible flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
              <Button
                size="icon-xs"
                variant="ghost"
                title="Rename"
                onClick={(event) => {
                  event.stopPropagation();
                  void renameEntry(entry);
                }}
              >
                <PencilIcon />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                title="Delete"
                onClick={(event) => {
                  event.stopPropagation();
                  void deleteEntry(entry);
                }}
              >
                <Trash2Icon />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function joinPath(directoryPath: string, name: string) {
  return [directoryPath, name].filter(Boolean).join("/");
}

function parentPath(path: string) {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}
