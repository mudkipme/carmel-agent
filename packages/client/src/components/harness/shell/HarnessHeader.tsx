import { PanelLeftIcon, SettingsIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AgentConfig, ModelRef, SessionMetadata } from "@carmel-agent/shared";

export function HarnessHeader({
  sidebarOpen,
  activeAgent,
  activeModel,
  activeSession,
  onToggleSidebar,
  onOpenSettings,
}: {
  sidebarOpen: boolean;
  activeAgent?: AgentConfig;
  activeModel?: ModelRef;
  activeSession?: SessionMetadata;
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <header className="flex h-11 items-center justify-between gap-3 border-b bg-background px-4">
      <div className="flex min-w-0 items-center gap-2">
        <Button
          size="icon-sm"
          variant="ghost"
          title={sidebarOpen ? "Collapse sidebar" : "Show sidebar"}
          onClick={onToggleSidebar}
        >
          <PanelLeftIcon />
        </Button>
        <div className="min-w-0">
          <h2 className="truncate text-[13px] font-medium">{activeSession?.title ?? "No session"}</h2>
          <p className="truncate text-xs text-muted-foreground">
            {activeAgent?.workingDir ?? "No working directory"} · {activeModel?.label ?? "No model"}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Badge variant="secondary">{activeSession?.thinkingLevel ?? "off"}</Badge>
        <Badge variant="secondary">{activeAgent?.permissions.bash ? "bash on" : "bash off"}</Badge>
        <Button variant="outline" size="icon-sm" title="Settings" onClick={onOpenSettings}>
          <SettingsIcon />
        </Button>
      </div>
    </header>
  );
}
