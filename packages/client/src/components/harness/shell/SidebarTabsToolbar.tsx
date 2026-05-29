import { MessageSquarePlusIcon, UploadIcon } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useHarnessStore } from "@/store/harness-store";
import type { AgentConfig } from "@carmel-agent/shared";
import type { SidebarMode } from "./sidebar-utils";

export function SidebarTabsToolbar({
  activeAgent,
  onSidebarModeChange,
  onAfterOpen,
  onOpenImport,
}: {
  activeAgent?: AgentConfig;
  onSidebarModeChange: (mode: SidebarMode) => void;
  onAfterOpen: () => void;
  onOpenImport: () => void;
}) {
  const navigate = useNavigate();
  const createSession = useHarnessStore((state) => state.createSession);

  return (
    <div className="flex items-center gap-2 px-2">
      <TabsList className="grid h-8 flex-1 grid-cols-2">
        <TabsTrigger value="sessions" className="text-xs">
          Sessions
        </TabsTrigger>
        <TabsTrigger value="files" className="text-xs">
          Files
        </TabsTrigger>
      </TabsList>
      <Button
        size="icon-sm"
        variant="ghost"
        title="New session"
        onClick={() => {
          if (!activeAgent) return;
          void createSession({
            agentId: activeAgent.id,
            modelRefId: activeAgent.defaultModelRefId,
            thinkingLevel: activeAgent.defaultThinkingLevel ?? "off",
          }).then((session) => {
            navigate(`/agents/${session.agentId}/sessions/${session.id}`);
          });
          onSidebarModeChange("sessions");
          onAfterOpen();
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
