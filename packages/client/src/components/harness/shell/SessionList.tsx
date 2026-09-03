import { EllipsisIcon, PencilIcon, Pin, PinOff, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn, formatRelativeTime } from "@/lib/utils";
import { confirmAction, promptText } from "@/lib/action-dialogs";
import { showError } from "@/lib/errors";
import { useHarnessStore } from "@/store/harness-store";
import type { SessionMetadata } from "@carmel-agent/shared";

export function SessionList({
  sessions,
  activeSessionId,
  onOpenSession,
}: {
  sessions: SessionMetadata[];
  activeSessionId?: string;
  onOpenSession: () => void;
}) {
  const navigate = useNavigate();
  const [openSessionMenuId, setOpenSessionMenuId] = useState<string | null>(null);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto">
      {sessions.map((session) => (
        <div
          key={session.id}
          data-active={session.id === activeSessionId}
          className="nav-item group flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5"
        >
          <button
            className="flex h-full min-w-0 flex-1 items-center text-left"
            onClick={() => {
              navigate(`/agents/${session.agentId}/sessions/${session.id}`);
              onOpenSession();
            }}
          >
            <span className="sr-only">Open session</span>
            <span className="flex min-w-0 items-center gap-1.5">
              {session.pinnedAt ? <Pin className="size-3 shrink-0 text-faint" /> : null}
              <span className="truncate text-[13px]">{session.title}</span>
            </span>
          </button>
          <SessionActions
            session={session}
            open={openSessionMenuId === session.id}
            onOpenChange={(open) => setOpenSessionMenuId(open ? session.id : null)}
          />
        </div>
      ))}
    </div>
  );
}

function SessionActions({
  session,
  open,
  onOpenChange,
}: {
  session: SessionMetadata;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const updateSession = useHarnessStore((state) => state.updateSession);
  const deleteSession = useHarnessStore((state) => state.deleteSession);

  return (
    <div className="relative flex h-full w-8 shrink-0 items-center justify-end">
      <span
        className={cn(
          "coarse-pointer-hidden text-ui-smaller text-muted-foreground transition-opacity group-hover:opacity-0 group-focus-within:opacity-0",
          open && "opacity-0",
        )}
      >
        {formatRelativeTime(session.updatedAt)}
      </span>
      <DropdownMenu open={open} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon-xs"
            variant="ghost"
            title="Session actions"
            className="coarse-pointer-visible absolute right-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100"
          >
            <EllipsisIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-36">
          <DropdownMenuGroup>
            <DropdownMenuItem
              onSelect={() => {
                void updateSession(session.id, {
                  pinnedAt: session.pinnedAt ? null : Date.now(),
                });
              }}
            >
              {session.pinnedAt ? <PinOff /> : <Pin />}
              {session.pinnedAt ? "Unpin" : "Pin"}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                void promptText({ title: "Rename session", initialValue: session.title }).then((nextTitle) => {
                  const title = nextTitle?.trim();
                  if (!title || title === session.title) return;
                  void updateSession(session.id, { title }).catch((error) => showError("Unable to rename session", error));
                });
              }}
            >
              <PencilIcon />
              Rename
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => {
                void confirmAction({
                  title: `Delete “${session.title}”?`,
                  description: "This session and its message history will be permanently deleted.",
                  actionLabel: "Delete session",
                }).then((confirmed) => {
                  if (confirmed) void deleteSession(session.id).catch((error) => showError("Unable to delete session", error));
                });
              }}
            >
              <Trash2Icon />
              Delete
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
