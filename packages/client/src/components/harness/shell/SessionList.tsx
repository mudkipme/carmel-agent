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
import { useHarnessStore } from "@/store/harness-store";
import type { SessionMetadata } from "@carmel-agent/shared";
import type { SidebarMode } from "./sidebar-utils";

export function SessionList({
  sessions,
  activeSessionId,
  onSidebarModeChange,
  onAfterOpen,
}: {
  sessions: SessionMetadata[];
  activeSessionId?: string;
  onSidebarModeChange: (mode: SidebarMode) => void;
  onAfterOpen: () => void;
}) {
  const navigate = useNavigate();
  const store = useHarnessStore();
  const [openSessionMenuId, setOpenSessionMenuId] = useState<string | null>(null);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto">
      {sessions.map((session) => (
        <div
          key={session.id}
          className={cn(
            "group flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 transition-colors hover:bg-accent hover:text-accent-foreground",
            session.id === activeSessionId && "bg-accent text-accent-foreground",
          )}
        >
          <button
            className="flex h-full min-w-0 flex-1 items-center text-left"
            onClick={() => {
              store.setActiveSession(session.id);
              navigate(`/agents/${session.agentId}/sessions/${session.id}`);
              onSidebarModeChange("sessions");
              onAfterOpen();
            }}
          >
            <span className="sr-only">Open session</span>
            <span className="flex min-w-0 items-center gap-1.5">
              {session.pinnedAt ? <Pin className="size-3 shrink-0 text-muted-foreground" /> : null}
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
          "text-xs text-muted-foreground transition-opacity group-hover:opacity-0 group-focus-within:opacity-0",
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
            className="absolute right-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100"
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
                const nextTitle = window.prompt("Rename session", session.title);
                const title = nextTitle?.trim();
                if (!title || title === session.title) return;
                void updateSession(session.id, { title });
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
                const confirmed = window.confirm(`Delete "${session.title}"?`);
                if (!confirmed) return;
                void deleteSession(session.id);
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
