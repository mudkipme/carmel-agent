import { MessageSquarePlusIcon, UploadIcon } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useHarnessStore } from "@/store/harness-store";
import type { AgentConfig } from "@carmel-agent/shared";

export function SidebarSessionsToolbar({
  activeAgent,
  onOpenSession,
  onOpenImport,
}: {
  activeAgent?: AgentConfig;
  onOpenSession: () => void;
  onOpenImport: () => void;
}) {
  const navigate = useNavigate();
  const createSession = useHarnessStore((state) => state.createSession);

  return (
    <div className="flex h-[var(--input-height)] items-center gap-2 px-2">
      <span className="nav-label flex-1">Sessions</span>
      <Button
        size="icon-sm"
        variant="ghost"
        title="New session"
        disabled={!activeAgent}
        onClick={() => {
          if (!activeAgent) return;
          void createSession({
            agentId: activeAgent.id,
            modelRefId: activeAgent.defaultModelRefId,
            thinkingLevel: activeAgent.defaultThinkingLevel ?? "off",
          }).then((session) => {
            navigate(`/agents/${session.agentId}/sessions/${session.id}`);
          });
          onOpenSession();
        }}
      >
        <MessageSquarePlusIcon />
      </Button>
      <Button size="icon-sm" variant="ghost" title="Import Open WebUI export" disabled={!activeAgent} onClick={onOpenImport}>
        <UploadIcon />
      </Button>
    </div>
  );
}
