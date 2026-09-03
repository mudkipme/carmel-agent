import {
  ArrowDownUpIcon,
  ClipboardPasteIcon,
  CopyIcon,
  DownloadIcon,
  EyeIcon,
  EyeOffIcon,
  FileIcon,
  FilePlusIcon,
  FolderIcon,
  FolderPlusIcon,
  HomeIcon,
  MoreHorizontalIcon,
  PencilIcon,
  RefreshCwIcon,
  ScissorsIcon,
  Trash2Icon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import { useRef, useState, type DragEvent, type MouseEvent } from "react";
import type { AgentConfig, AgentFileEntry } from "@carmel-agent/shared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  formatFileSize,
  formatFileTimestamp,
  parentPath,
  readDroppedFiles,
  toUploadCandidates,
  useFileBrowser,
  type FileSortKey,
} from "@/hooks/use-file-browser";
import { cn } from "@/lib/utils";

type FileManagerViewProps = {
  agent?: AgentConfig;
  onOpenFile: (path: string) => void;
};

const sortLabels: Record<FileSortKey, string> = { name: "Name", size: "Size", updatedAt: "Modified" };

export function FileManagerView({ agent, onOpenFile }: FileManagerViewProps) {
  const browser = useFileBrowser({ agent, onOpenFile });
  const [dragDepth, setDragDepth] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  if (!agent) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        Select an agent to browse files.
      </div>
    );
  }

  const canWrite = agent.permissions.write;
  const canRename = agent.permissions.write || agent.permissions.edit;
  const canRead = agent.permissions.read;
  const { entries, selected, selectedEntries, selectedSet, clipboard, uploads } = browser;
  const allSelected = entries.length > 0 && selected.length === entries.length;

  const handleDrop = async (event: DragEvent) => {
    event.preventDefault();
    setDragDepth(0);
    if (!canWrite) return;
    await browser.uploadFiles(await readDroppedFiles(event.dataTransfer));
  };

  const rowClick = (event: MouseEvent, entry: AgentFileEntry) => {
    // A plain click always opens, even mid-selection: cutting a few files and
    // then clicking into the destination folder has to keep working. Selection
    // is the checkbox, or a modifier click.
    if (event.metaKey || event.ctrlKey || event.shiftKey) {
      browser.toggleSelected(entry.path, { extend: event.shiftKey });
      return;
    }
    browser.openEntry(entry);
  };

  return (
    <div
      className="relative flex h-full min-h-0 flex-col bg-background"
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes("Files")) setDragDepth((depth) => depth + 1);
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDragLeave={() => setDragDepth((depth) => Math.max(0, depth - 1))}
      onDrop={(event) => void handleDrop(event)}
    >
      <div className="flex min-h-[var(--header-height)] shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-1.5">
        <Breadcrumbs path={browser.path} onNavigate={browser.navigate} />
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="outline" disabled={!canWrite} onClick={() => fileInputRef.current?.click()}>
            <UploadIcon />
            Upload
          </Button>
          <Button size="icon-sm" variant="ghost" title="New file" disabled={!canWrite} onClick={() => void browser.createEntry("file")}>
            <FilePlusIcon />
          </Button>
          <Button size="icon-sm" variant="ghost" title="New folder" disabled={!canWrite} onClick={() => void browser.createEntry("directory")}>
            <FolderPlusIcon />
          </Button>
          <Button size="icon-sm" variant="ghost" title="Refresh" onClick={browser.refresh}>
            <RefreshCwIcon />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" title="View options">
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem disabled={!canWrite} onSelect={() => folderInputRef.current?.click()}>
                <UploadIcon />
                Upload folder
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!canRead} onSelect={() => browser.download([browser.path])}>
                <DownloadIcon />
                Download this folder
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => browser.setShowHidden(!browser.showHidden)}>
                {browser.showHidden ? <EyeOffIcon /> : <EyeIcon />}
                {browser.showHidden ? "Hide hidden files" : "Show hidden files"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {(Object.keys(sortLabels) as FileSortKey[]).map((key) => (
                <DropdownMenuItem
                  key={key}
                  onSelect={() =>
                    browser.setSort({ key, ascending: browser.sort.key === key ? !browser.sort.ascending : true })
                  }
                >
                  <ArrowDownUpIcon />
                  Sort by {sortLabels[key].toLowerCase()}
                  {browser.sort.key === key ? (
                    <span className="ml-auto text-xs text-muted-foreground">{browser.sort.ascending ? "A→Z" : "Z→A"}</span>
                  ) : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        <Input
          value={browser.filter}
          placeholder="Filter this folder"
          className="h-8 max-w-64 flex-1"
          onChange={(event) => browser.setFilter(event.target.value)}
        />
        {clipboard ? (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <span>
              {clipboard.paths.length} item{clipboard.paths.length === 1 ? "" : "s"} to{" "}
              {clipboard.operation === "move" ? "move" : "copy"}
            </span>
            <Button size="xs" variant="outline" disabled={!canWrite} onClick={() => void browser.paste()}>
              <ClipboardPasteIcon />
              Paste here
            </Button>
          </div>
        ) : null}
      </div>

      {selected.length > 0 ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-accent/40 px-3 py-2">
          <span className="text-xs font-medium">{selected.length} selected</span>
          <Button size="xs" variant="outline" disabled={!canRead} onClick={() => browser.download(selected)}>
            <DownloadIcon />
            Download
          </Button>
          <Button size="xs" variant="outline" disabled={!canWrite} onClick={() => browser.copy(selected)}>
            <CopyIcon />
            Copy
          </Button>
          <Button size="xs" variant="outline" disabled={!canWrite} onClick={() => browser.cut(selected)}>
            <ScissorsIcon />
            Cut
          </Button>
          <Button size="xs" variant="destructive" disabled={!canWrite} onClick={() => void browser.deleteEntries(selectedEntries)}>
            <Trash2Icon />
            Delete
          </Button>
          <Button size="xs" variant="ghost" className="ml-auto" onClick={browser.clearSelection}>
            <XIcon />
            Clear
          </Button>
        </div>
      ) : null}

      {browser.error ? <p className="shrink-0 border-b px-3 py-2 text-xs break-words text-destructive">{browser.error}</p> : null}

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="flex h-8 items-center gap-3 border-b px-3 text-ui-smaller text-muted-foreground">
          <Checkbox
            className="shrink-0"
            aria-label="Select all"
            disabled={entries.length === 0}
            checked={allSelected ? true : selected.length > 0 ? "indeterminate" : false}
            onCheckedChange={(checked) => (checked ? browser.selectAll() : browser.clearSelection())}
          />
          <span className="flex-1">Name</span>
          <span className="hidden w-20 text-right sm:block">Size</span>
          <span className="hidden w-24 text-right sm:block">Modified</span>
          <span className="w-6" />
        </div>
        {browser.path ? (
          <button
            type="button"
            className="nav-item flex w-full items-center gap-3 px-3 py-2 text-left text-[13px]"
            onClick={() => browser.navigate(parentPath(browser.path))}
          >
            <span className="size-4 shrink-0" />
            <FolderIcon className="size-4 shrink-0 text-faint" />
            <span className="flex-1">..</span>
          </button>
        ) : null}
        {browser.loading ? <p className="px-3 py-3 text-xs text-muted-foreground">Loading files...</p> : null}
        {!browser.loading && entries.length === 0 ? (
          <p className="px-3 py-3 text-xs text-muted-foreground">
            {browser.filter ? "Nothing matches this filter." : "This folder is empty. Drop files here to upload."}
          </p>
        ) : null}
        {entries.map((entry) => (
          <div
            key={entry.path}
            data-active={selectedSet.has(entry.path)}
            className="nav-item group flex cursor-default items-center gap-3 px-3 py-2"
            role="button"
            tabIndex={0}
            onClick={(event) => rowClick(event, entry)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              browser.openEntry(entry);
            }}
          >
            <Checkbox
              className="shrink-0"
              aria-label={`Select ${entry.name}`}
              checked={selectedSet.has(entry.path)}
              onClick={(event) => {
                event.stopPropagation();
                browser.toggleSelected(entry.path, { extend: event.shiftKey });
              }}
            />
            {entry.type === "directory" ? (
              <FolderIcon className="size-4 shrink-0 text-faint" />
            ) : (
              <FileIcon className="size-4 shrink-0 text-faint" />
            )}
            <span className={cn("flex-1 truncate text-[13px]", entry.hidden && "text-muted-foreground")}>{entry.name}</span>
            <span className="hidden w-20 text-right text-xs text-muted-foreground tabular-nums sm:block">
              {entry.type === "directory" ? "—" : formatFileSize(entry.size)}
            </span>
            <span className="hidden w-24 text-right text-xs text-muted-foreground tabular-nums sm:block">
              {formatFileTimestamp(entry.updatedAt)}
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild onClick={(event) => event.stopPropagation()}>
                <Button size="icon-xs" variant="ghost" title={`Actions for ${entry.name}`}>
                  <MoreHorizontalIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onSelect={() => browser.openEntry(entry)}>
                  {entry.type === "directory" ? <FolderIcon /> : <FileIcon />}
                  Open
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!canRead} onSelect={() => browser.download([entry.path])}>
                  <DownloadIcon />
                  Download
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={!canRename} onSelect={() => void browser.renameEntry(entry)}>
                  <PencilIcon />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!canWrite} onSelect={() => browser.copy([entry.path])}>
                  <CopyIcon />
                  Copy
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!canWrite} onSelect={() => browser.cut([entry.path])}>
                  <ScissorsIcon />
                  Cut
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" disabled={!canWrite} onSelect={() => void browser.deleteEntries([entry])}>
                  <Trash2Icon />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ))}
      </div>

      {uploads.length > 0 ? (
        <div className="max-h-40 shrink-0 space-y-1.5 overflow-auto border-t px-3 py-2">
          {uploads.map((upload) => (
            <div key={upload.id} className="flex items-center gap-2 text-xs">
              <span className="w-40 truncate">{upload.name}</span>
              {upload.error ? (
                <span className="flex-1 truncate text-destructive">{upload.error}</span>
              ) : (
                <span className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--ui2)]">
                  <span
                    className="block h-full bg-primary transition-[width] duration-150"
                    style={{ width: `${Math.round(upload.progress * 100)}%` }}
                  />
                </span>
              )}
              <span className="w-10 shrink-0 text-right text-muted-foreground tabular-nums">
                {upload.error ? "" : `${Math.round(upload.progress * 100)}%`}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {dragDepth > 0 && canWrite ? (
        <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-background/80 text-sm font-medium">
          Drop to upload into {browser.path || "the working directory"}
        </div>
      ) : null}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = event.target.files;
          if (files?.length) void browser.uploadFiles(toUploadCandidates(files));
          event.target.value = "";
        }}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        // Not in the JSX types, but the only way to offer a folder picker.
        {...({ webkitdirectory: "" } as Record<string, string>)}
        className="hidden"
        onChange={(event) => {
          const files = event.target.files;
          if (files?.length) void browser.uploadFiles(toUploadCandidates(files));
          event.target.value = "";
        }}
      />
    </div>
  );
}

function Breadcrumbs({ path, onNavigate }: { path: string; onNavigate: (path: string) => void }) {
  const segments = path.split("/").filter(Boolean);

  return (
    <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-[13px]">
      <Button size="icon-xs" variant="ghost" title="Working directory" onClick={() => onNavigate("")}>
        <HomeIcon />
      </Button>
      {segments.map((segment, index) => (
        <div key={`${segment}-${index}`} className="flex shrink-0 items-center gap-1">
          <span className="text-muted-foreground">/</span>
          <button
            type="button"
            className="rounded px-1 py-0.5 font-mono hover:bg-accent"
            onClick={() => onNavigate(segments.slice(0, index + 1).join("/"))}
          >
            {segment}
          </button>
        </div>
      ))}
    </nav>
  );
}
