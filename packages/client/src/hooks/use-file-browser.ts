import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentConfig, AgentFileEntry } from "@carmel-agent/shared";
import { api } from "@/lib/api";
import { confirmAction, promptText } from "@/lib/action-dialogs";
import { errorMessage, showError } from "@/lib/errors";

export type FileSortKey = "name" | "size" | "updatedAt";
export type FileSort = { key: FileSortKey; ascending: boolean };
export type FileClipboard = { operation: "move" | "copy"; paths: string[] };
export type FileUpload = { id: string; name: string; progress: number; error?: string };
/** A file plus where it should land, relative to the browsed directory. */
export type UploadCandidate = { file: File; relativePath: string };

/**
 * Every file operation the manager needs: listing, navigation, selection, and
 * the mutations. Kept apart from the view so the wire format and the
 * confirmation prompts stay in one place.
 */
export function useFileBrowser({
  agent,
  onOpenFile,
}: {
  agent?: AgentConfig;
  onOpenFile?: (path: string) => void;
}) {
  const agentId = agent?.id;
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<AgentFileEntry[]>([]);
  const [loading, setLoading] = useState(Boolean(agentId));
  const [error, setError] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<FileSort>({ key: "name", ascending: true });
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [clipboard, setClipboard] = useState<FileClipboard>();
  const [uploads, setUploads] = useState<FileUpload[]>([]);
  const requestIdRef = useRef(0);
  const pathRef = useRef("");
  const showHiddenRef = useRef(false);
  const anchorPathRef = useRef("");

  const loadEntries = useCallback(
    async (nextPath: string, hidden: boolean, showSpinner = true) => {
      if (!agentId) return;
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      if (showSpinner) {
        setLoading(true);
        setError("");
      }
      try {
        const result = await api.listAgentFiles(agentId, nextPath, hidden);
        if (requestId !== requestIdRef.current) return;
        setEntries(result.entries);
      } catch (loadError) {
        if (requestId !== requestIdRef.current) return;
        setEntries([]);
        setError(errorMessage(loadError, "Unable to load files"));
      } finally {
        if (requestId === requestIdRef.current) setLoading(false);
      }
    },
    [agentId],
  );

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadEntries(pathRef.current, showHiddenRef.current, false);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadEntries]);

  const refresh = useCallback(() => {
    void loadEntries(pathRef.current, showHiddenRef.current);
  }, [loadEntries]);

  const navigate = useCallback(
    (nextPath: string) => {
      pathRef.current = nextPath;
      requestIdRef.current += 1;
      anchorPathRef.current = "";
      setPath(nextPath);
      setEntries([]);
      setSelectedPaths([]);
      setError("");
      setLoading(true);
      void loadEntries(nextPath, showHiddenRef.current);
    },
    [loadEntries],
  );

  const toggleHidden = useCallback(
    (hidden: boolean) => {
      showHiddenRef.current = hidden;
      setShowHidden(hidden);
      void loadEntries(pathRef.current, hidden);
    },
    [loadEntries],
  );

  const visibleEntries = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matching = needle
      ? entries.filter((entry) => entry.name.toLowerCase().includes(needle))
      : entries;
    return [...matching].sort((left, right) => {
      // Folders lead in every sort order; only their neighbours reorder.
      if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
      const direction = sort.ascending ? 1 : -1;
      if (sort.key === "size") return direction * ((left.size ?? 0) - (right.size ?? 0));
      if (sort.key === "updatedAt") return direction * (left.updatedAt - right.updatedAt);
      return direction * left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    });
  }, [entries, filter, sort]);

  const selected = useMemo(() => {
    const visible = new Set(visibleEntries.map((entry) => entry.path));
    return selectedPaths.filter((selectedPath) => visible.has(selectedPath));
  }, [selectedPaths, visibleEntries]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const toggleSelected = useCallback(
    (entryPath: string, options: { extend?: boolean } = {}) => {
      const anchorIndex = visibleEntries.findIndex((entry) => entry.path === anchorPathRef.current);
      const targetIndex = visibleEntries.findIndex((entry) => entry.path === entryPath);
      // Shift-click fills in from the last row touched, the way every file
      // manager behaves; a plain click restarts the range there.
      if (options.extend && anchorIndex >= 0 && targetIndex >= 0) {
        const [from, to] =
          anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
        const range = visibleEntries.slice(from, to + 1).map((entry) => entry.path);
        setSelectedPaths((current) => [...new Set([...current, ...range])]);
        return;
      }
      anchorPathRef.current = entryPath;
      setSelectedPaths((current) =>
        current.includes(entryPath)
          ? current.filter((item) => item !== entryPath)
          : [...current, entryPath],
      );
    },
    [visibleEntries],
  );

  const selectAll = useCallback(() => {
    setSelectedPaths(visibleEntries.map((entry) => entry.path));
  }, [visibleEntries]);

  const clearSelection = useCallback(() => setSelectedPaths([]), []);

  const openEntry = useCallback(
    (entry: AgentFileEntry) => {
      if (entry.type === "directory") {
        navigate(entry.path);
        return;
      }
      onOpenFile?.(entry.path);
    },
    [navigate, onOpenFile],
  );

  const createEntry = useCallback(
    async (type: AgentFileEntry["type"]) => {
      if (!agentId) return;
      const name = await promptText({
        title: type === "directory" ? "Folder name" : "File name",
        actionLabel: type === "directory" ? "Create folder" : "Create file",
      });
      const cleanName = name?.trim();
      if (!cleanName) return;
      try {
        await api.createAgentFileEntry(agentId, joinPath(pathRef.current, cleanName), type);
        refresh();
      } catch (createError) {
        showError("Unable to create entry", createError);
      }
    },
    [agentId, refresh],
  );

  const renameEntry = useCallback(
    async (entry: AgentFileEntry) => {
      if (!agentId) return;
      const nextName = await promptText({
        title: `Rename ${entry.name}`,
        initialValue: entry.name,
      });
      const cleanName = nextName?.trim();
      if (!cleanName || cleanName === entry.name) return;
      try {
        await api.renameAgentFileEntry(
          agentId,
          entry.path,
          joinPath(parentPath(entry.path), cleanName),
        );
        refresh();
      } catch (renameError) {
        showError("Unable to rename entry", renameError);
      }
    },
    [agentId, refresh],
  );

  const deleteEntries = useCallback(
    async (targets: AgentFileEntry[]) => {
      if (!agentId || targets.length === 0) return;
      const label = targets.length === 1 ? `“${targets[0].name}”` : `${targets.length} items`;
      const confirmed = await confirmAction({
        title: `Delete ${label}?`,
        description:
          targets.length === 1 && targets[0].type === "directory"
            ? "The folder and everything inside it will be permanently deleted."
            : "The selected entries will be permanently deleted.",
        actionLabel: "Delete",
      });
      if (!confirmed) return;
      try {
        const result = await api.batchAgentFiles(agentId, {
          operation: "delete",
          paths: targets.map((entry) => entry.path),
        });
        reportFailures("Some entries could not be deleted", result.failed);
        setSelectedPaths((current) => current.filter((item) => !result.completed.includes(item)));
        refresh();
      } catch (deleteError) {
        showError("Unable to delete entries", deleteError);
      }
    },
    [agentId, refresh],
  );

  const download = useCallback(
    (paths: string[]) => {
      if (!agentId || paths.length === 0) return;
      // A hidden anchor keeps the browser's own download UI (and the session
      // cookie) instead of buffering the whole archive in memory here.
      const link = document.createElement("a");
      link.href = api.getAgentFileDownloadUrl(agentId, paths);
      link.rel = "noopener";
      document.body.append(link);
      link.click();
      link.remove();
    },
    [agentId],
  );

  const uploadFiles = useCallback(
    async (candidates: UploadCandidate[]) => {
      if (!agentId || candidates.length === 0) return;
      const directory = pathRef.current;
      const targets = candidates.map(({ file, relativePath }) => {
        const name = sanitizeUploadPath(relativePath) || file.name;
        return { file, name, targetPath: joinPath(directory, name) };
      });

      // Only names landing directly in this folder can be checked up front; a
      // nested one that already exists comes back as a 409 for that file alone.
      const existingNames = new Set(entries.map((entry) => entry.name));
      const clashes = targets.filter(({ name }) => !name.includes("/") && existingNames.has(name));
      let overwrite = false;
      if (clashes.length > 0) {
        overwrite = await confirmAction({
          title:
            clashes.length === 1
              ? `Replace “${clashes[0].name}”?`
              : `Replace ${clashes.length} files?`,
          description: "Files with the same name in this folder will be overwritten.",
          actionLabel: "Replace",
        });
        if (!overwrite) return;
      }

      const batchId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setUploads(
        targets.map(({ name }, index) => ({ id: `${batchId}-${index}`, name, progress: 0 })),
      );
      const failures: string[] = [];
      for (const [index, { file, name, targetPath }] of targets.entries()) {
        const id = `${batchId}-${index}`;
        try {
          await api.uploadAgentFile(agentId, targetPath, file, {
            overwrite,
            onProgress: (progress) => {
              setUploads((current) =>
                current.map((upload) => (upload.id === id ? { ...upload, progress } : upload)),
              );
            },
          });
        } catch (uploadError) {
          const message = errorMessage(uploadError, "Upload failed");
          failures.push(`${name}: ${message}`);
          setUploads((current) =>
            current.map((upload) => (upload.id === id ? { ...upload, error: message } : upload)),
          );
        }
      }
      if (failures.length > 0) {
        // Failed rows stay on screen so the reason keeps its place in the list.
        showError(
          failures.length === 1 ? "Upload failed" : `${failures.length} uploads failed`,
          new Error(failures.join("\n")),
        );
      } else {
        setUploads([]);
      }
      refresh();
    },
    [agentId, entries, refresh],
  );

  const cut = useCallback((paths: string[]) => setClipboard({ operation: "move", paths }), []);
  const copy = useCallback((paths: string[]) => setClipboard({ operation: "copy", paths }), []);

  const paste = useCallback(async () => {
    if (!agentId || !clipboard) return;
    try {
      const result = await api.batchAgentFiles(agentId, {
        operation: clipboard.operation,
        paths: clipboard.paths,
        destination: pathRef.current,
      });
      reportFailures(
        clipboard.operation === "move"
          ? "Some entries could not be moved"
          : "Some entries could not be copied",
        result.failed,
      );
      if (clipboard.operation === "move" || result.failed.length === 0) setClipboard(undefined);
      refresh();
    } catch (pasteError) {
      showError("Unable to paste entries", pasteError);
    }
  }, [agentId, clipboard, refresh]);

  return {
    agentId,
    path,
    entries: visibleEntries,
    loading,
    error,
    showHidden,
    setShowHidden: toggleHidden,
    filter,
    setFilter,
    sort,
    setSort,
    selected,
    selectedSet,
    selectedEntries: visibleEntries.filter((entry) => selectedSet.has(entry.path)),
    toggleSelected,
    selectAll,
    clearSelection,
    clipboard,
    uploads,
    navigate,
    refresh,
    openEntry,
    createEntry,
    renameEntry,
    deleteEntries,
    download,
    uploadFiles,
    cut,
    copy,
    paste,
  };
}

function joinPath(directoryPath: string, name: string) {
  return [directoryPath, name].filter(Boolean).join("/");
}

export function parentPath(path: string) {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

export function formatFileSize(bytes?: number) {
  if (bytes === undefined) return "";
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

const dayMs = 24 * 60 * 60 * 1000;

export function formatFileTimestamp(timestamp: number) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  const stamp = new Date(timestamp);
  const sameYear = stamp.getFullYear() === new Date().getFullYear();
  const recent = Date.now() - timestamp < dayMs;
  if (recent) return stamp.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return stamp.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
}

/** Reads a file picker's selection, keeping folder structure when present. */
export function toUploadCandidates(files: FileList | File[]): UploadCandidate[] {
  return [...files].map((file) => ({ file, relativePath: file.webkitRelativePath || file.name }));
}

/**
 * A drop only exposes folder contents through the entry API, so dropped
 * directories are walked here rather than silently arriving empty.
 */
export async function readDroppedFiles(dataTransfer: DataTransfer): Promise<UploadCandidate[]> {
  const roots = [...dataTransfer.items]
    .filter((item) => item.kind === "file")
    .map((item) => item.webkitGetAsEntry?.())
    .filter((entry): entry is FileSystemEntry => Boolean(entry));
  if (roots.length === 0) return toUploadCandidates(dataTransfer.files);

  const candidates: UploadCandidate[] = [];
  const visit = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isFile) {
      const file = await new Promise<File | undefined>((resolve) =>
        (entry as FileSystemFileEntry).file(resolve, () => resolve(undefined)),
      );
      if (file) candidates.push({ file, relativePath });
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      // readEntries returns at most a page at a time and signals the end with
      // an empty batch.
      const batch = await new Promise<FileSystemEntry[]>((resolve) =>
        reader.readEntries(resolve, () => resolve([])),
      );
      if (batch.length === 0) break;
      for (const child of batch) await visit(child, relativePath);
    }
  };
  for (const root of roots) await visit(root, "");
  return candidates;
}

/** Drops any `..` or absolute prefix a dropped folder path might carry. */
function sanitizeUploadPath(path: string) {
  return path
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
}

function reportFailures(title: string, failed: { path: string; error: string }[]) {
  if (failed.length === 0) return;
  showError(
    title,
    new Error(failed.map((failure) => `${failure.path}: ${failure.error}`).join("\n")),
  );
}
