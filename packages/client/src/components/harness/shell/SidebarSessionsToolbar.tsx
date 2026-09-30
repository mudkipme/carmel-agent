import { MessageSquarePlusIcon, SquarePenIcon, UploadIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AgentConfig } from "@carmel-agent/shared";
import type { SidebarList } from "./sidebar-utils";

export function SidebarSessionsToolbar({
  activeAgent,
  list,
  attentionCount,
  onListChange,
  onOpenSession,
  onOpenImport,
}: {
  activeAgent?: AgentConfig;
  list: SidebarList;
  /** Issues awaiting an answer, error recovery, or human review. */
  attentionCount: number;
  onListChange: (list: SidebarList) => void;
  onOpenSession: () => void;
  onOpenImport: () => void;
}) {
  const navigate = useNavigate();

  return (
    <div className="flex h-[var(--input-height)] items-center gap-2 px-2">
      <div role="tablist" aria-label="Sidebar list" className="flex flex-1 items-center gap-3">
        <ListTab selected={list === "sessions"} onSelect={() => { onListChange("sessions"); if (activeAgent) navigate(`/agents/${activeAgent.id}`); onOpenSession(); }}>
          Sessions
        </ListTab>
        <ListTab selected={list === "issues"} onSelect={() => { onListChange("issues"); if (activeAgent) navigate(`/agents/${activeAgent.id}/issues`); onOpenSession(); }}>
          Issues
          {attentionCount > 0 ? (
            <span className="ml-1 rounded-full bg-[var(--ui2)] px-1.5 text-[10px] tracking-normal text-foreground">
              {attentionCount}
            </span>
          ) : null}
        </ListTab>
      </div>
      {list === "sessions" ? (
        <>
          <Button
            size="icon-sm"
            variant="ghost"
            title="New session"
            disabled={!activeAgent}
            onClick={() => {
              if (!activeAgent) return;
              // The session itself is created when the composer's first message is sent.
              navigate(`/agents/${activeAgent.id}`);
              onOpenSession();
            }}
          >
            <MessageSquarePlusIcon />
          </Button>
          <Button size="icon-sm" variant="ghost" title="Import Open WebUI export" disabled={!activeAgent} onClick={onOpenImport}>
            <UploadIcon />
          </Button>
        </>
      ) : (
        <Button
          size="icon-sm"
          variant="ghost"
          title="New issue"
          disabled={!activeAgent}
          onClick={() => {
            if (!activeAgent) return;
            navigate(`/agents/${activeAgent.id}/issues/new`);
            onOpenSession();
          }}
        >
          <SquarePenIcon />
        </Button>
      )}
    </div>
  );
}

function ListTab({ selected, onSelect, children }: { selected: boolean; onSelect: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      className={cn(
        "nav-label flex h-6 items-center border-b-2 border-transparent transition-colors hover:text-foreground",
        selected && "border-foreground/70 text-foreground",
      )}
      onClick={onSelect}
    >
      {children}
    </button>
  );
}
