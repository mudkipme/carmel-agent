import { FileIcon, FolderIcon, MessageSquareIcon, ArrowLeftIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { AgentFileEntry, MessageReference } from "@carmel-agent/shared";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { useHarnessStore } from "@/store/harness-store";

export function ReferencePicker({
  agentId,
  sessionId,
  canReadFiles,
  open,
  onOpenChange,
  onSelect,
}: {
  agentId: string;
  sessionId?: string;
  canReadFiles: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (reference: MessageReference) => void;
}) {
  const sessions = useHarnessStore((state) => state.sessions);
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<AgentFileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const slash = query.lastIndexOf("/");
  const directory = slash >= 0 ? query.slice(0, slash) : "";

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  useEffect(() => {
    if (!open || !canReadFiles) return;
    let cancelled = false;
    setFiles([]);
    setError(undefined);
    setLoading(true);
    void api
      .listAgentFiles(agentId, directory, true)
      .then(
        (result) => {
          if (!cancelled) setFiles(result.entries);
        },
        (error) => {
          if (!cancelled) setError(errorMessage(error));
        },
      )
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, canReadFiles, directory, open]);

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Mention a reference"
      description="Choose a file, folder, or conversation to include with your message."
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder="Search conversations or type a file path…"
      />
      <CommandList aria-label="References">
        {loading ? (
          <div role="status" className="px-3 py-2 text-sm text-muted-foreground">
            Loading files…
          </div>
        ) : null}
        {error ? (
          <div role="status" className="px-3 py-2 text-sm text-muted-foreground">
            Files unavailable: {error}
          </div>
        ) : null}
        <CommandEmpty>No matching references.</CommandEmpty>
        {canReadFiles ? (
          <CommandGroup heading={directory || "Workspace files and folders"}>
            {directory && query.endsWith("/") ? (
              <CommandItem
                value={`back:${directory}`}
                forceMount
                onSelect={() =>
                  setQuery(
                    directory.split("/").slice(0, -1).join("/") +
                      (directory.includes("/") ? "/" : ""),
                  )
                }
              >
                <ArrowLeftIcon /> Back
              </CommandItem>
            ) : null}
            {!loading && !error && (!query || query.endsWith("/")) ? (
              <CommandItem
                value={`mention:${directory || "workspace"}`}
                forceMount
                onSelect={() => onSelect({ kind: "folder", path: directory || "." })}
              >
                <FolderIcon /> Mention {directory ? `${directory}/` : "workspace folder"}
              </CommandItem>
            ) : null}
            {files.map((file) => (
              <CommandItem
                key={file.path}
                value={`file:${file.path}`}
                onSelect={() => {
                  if (file.type === "directory") setQuery(`${file.path}/`);
                  else onSelect({ kind: "file", path: file.path });
                }}
              >
                {file.type === "directory" ? <FolderIcon /> : <FileIcon />}
                <span className="min-w-0 truncate">
                  {file.name}
                  {file.type === "directory" ? "/" : ""}
                </span>
                {file.type === "directory" ? (
                  <span className="ml-auto text-xs text-muted-foreground">Browse</span>
                ) : null}
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
        <CommandGroup heading="Conversations">
          {sessions
            .filter((session) => session.id !== sessionId && !session.taskId && !session.issueId)
            .map((session) => (
              <CommandItem
                key={session.id}
                value={`session:${session.id}:${session.title}`}
                onSelect={() =>
                  onSelect({
                    kind: "session",
                    sessionId: session.id,
                    agentId: session.agentId,
                    label: session.title,
                  })
                }
              >
                <MessageSquareIcon />
                <span className="min-w-0 truncate">{session.title}</span>
              </CommandItem>
            ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
