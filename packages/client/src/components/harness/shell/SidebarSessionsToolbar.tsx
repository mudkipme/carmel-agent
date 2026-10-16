import { MessageSquarePlusIcon, UploadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AgentConfig } from "@carmel-agent/shared";

export function SidebarSessionsToolbar({
  activeAgent,
  onOpenSession,
  onNewSession,
  onOpenImport,
}: {
  activeAgent?: AgentConfig;
  onOpenSession: () => void;
  onNewSession: () => void;
  onOpenImport: () => void;
}) {
  return (
    <div className="flex h-[var(--input-height)] items-center gap-2 px-2">
      <span className="text-ui-smaller flex-1 font-medium tracking-wide text-foreground uppercase">
        Sessions
      </span>
      <Button
        size="icon-sm"
        variant="ghost"
        title="New session"
        disabled={!activeAgent}
        onClick={() => {
          if (!activeAgent) return;
          // The session itself is created when the composer's first message is sent.
          onNewSession();
          onOpenSession();
        }}
      >
        <MessageSquarePlusIcon />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        title="Import Open WebUI export"
        disabled={!activeAgent}
        onClick={onOpenImport}
      >
        <UploadIcon />
      </Button>
    </div>
  );
}
