import { ArchiveIcon, EllipsisIcon, LoaderCircleIcon, PencilIcon, Pin, PinOff, SearchIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { groupSessions, limitGroups, matchesSessionQuery } from "@/lib/session-groups";
import { sessionPath } from "@/lib/shell-route";
import { useHarnessStore } from "@/store/harness-store";
import type { SessionMetadata } from "@carmel-agent/shared";

/** Rows rendered before "Show more": a few hundred at once is what makes a long list slow. */
const PAGE_SIZE = 50;
/** Short lists do not need a search box. */
const SEARCH_THRESHOLD = 8;

export function SessionList({
  sessions,
  runningSessionIds,
  runOverrides,
  activeSessionId,
  onOpenSession,
}: {
  sessions: SessionMetadata[];
  runningSessionIds: Set<string>;
  runOverrides: Record<string, boolean>;
  activeSessionId?: string;
  onOpenSession: () => void;
}) {
  const navigate = useNavigate();
  const [openSessionMenuId, setOpenSessionMenuId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const { groups, hidden } = useMemo(() => {
    const matching = query.trim() ? sessions.filter((session) => matchesSessionQuery(session, query)) : sessions;
    return limitGroups(groupSessions(matching), limit);
  }, [limit, query, sessions]);
  const showSearch = sessions.length > SEARCH_THRESHOLD || query.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {showSearch ? (
        <div className="relative mx-1 mb-2 shrink-0">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            aria-label="Search sessions"
            placeholder="Search sessions"
            value={query}
            className="h-8 pl-8 text-[13px] md:text-[13px]"
            onChange={(event) => {
              setQuery(event.target.value);
              setLimit(PAGE_SIZE);
            }}
          />
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {groups.map((group) => (
          <section key={group.label} aria-label={group.label} className="flex flex-col">
            <h3 className="nav-label shrink-0 px-2.5 pt-3 pb-1 first:pt-1">{group.label}</h3>
            {group.sessions.map((session) => (
              <div
                key={session.id}
                data-active={session.id === activeSessionId}
                className="nav-item group flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5"
              >
                <button
                  className="flex h-full min-w-0 flex-1 items-center text-left"
                  onClick={() => {
                    navigate(sessionPath(session));
                    onOpenSession();
                  }}
                >
                  <span className="sr-only">Open session</span>
                  <span className="flex min-w-0 items-center gap-1.5">
                    {(runOverrides[session.id] ?? runningSessionIds.has(session.id)) ? (
                      <LoaderCircleIcon aria-hidden="true" className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none text-[var(--color-blue)]" />
                    ) : null}
                    {session.pinnedAt ? <Pin className="size-3 shrink-0 text-faint" /> : null}
                    <span className="truncate text-[13px]">{session.title}</span>
                  </span>
                  {(runOverrides[session.id] ?? runningSessionIds.has(session.id)) ? <span className="sr-only">Running</span> : null}
                </button>
                <SessionActions
                  session={session}
                  isOpen={session.id === activeSessionId}
                  open={openSessionMenuId === session.id}
                  onOpenChange={(open) => setOpenSessionMenuId(open ? session.id : null)}
                />
              </div>
            ))}
          </section>
        ))}
        {query.trim() && groups.length === 0 ? (
          <p className="px-2.5 py-2 text-[13px] text-muted-foreground">No sessions match “{query.trim()}”.</p>
        ) : null}
        {hidden > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            className="mx-1 my-1 shrink-0 justify-start text-muted-foreground"
            onClick={() => setLimit((current) => current + PAGE_SIZE)}
          >
            Show {Math.min(hidden, PAGE_SIZE)} more
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function SessionActions({
  session,
  isOpen,
  open,
  onOpenChange,
}: {
  session: SessionMetadata;
  /** The session is the one showing in the main column. */
  isOpen: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const updateSession = useHarnessStore((state) => state.updateSession);
  const deleteSession = useHarnessStore((state) => state.deleteSession);
  const archiveSession = useHarnessStore((state) => state.archiveSession);
  const restoreSession = useHarnessStore((state) => state.restoreSession);

  const archive = async () => {
    try {
      await archiveSession(session.id);
    } catch (error) {
      showError("Unable to archive session", error);
      return;
    }
    // An archived session leaves the list, so the chat it was showing moves on
    // to the composer; undoing brings both back.
    if (isOpen) navigate(`/agents/${session.agentId}`);
    toast.success("Session archived", {
      description: "Archived sessions are listed in agent settings.",
      // Long enough to notice and reach for; the default is gone before that.
      duration: 10_000,
      action: {
        label: "Undo",
        onClick: () => {
          void restoreSession(session.id)
            .then(() => {
              if (isOpen) navigate(sessionPath(session));
            })
            .catch((error) => showError("Unable to restore session", error));
        },
      },
    });
  };

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
                }).catch((error) => showError(session.pinnedAt ? "Unable to unpin session" : "Unable to pin session", error));
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
            <DropdownMenuItem
              onSelect={() => void archive()}
            >
              <ArchiveIcon />
              Archive
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
