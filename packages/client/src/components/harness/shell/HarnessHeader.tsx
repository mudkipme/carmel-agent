import { PanelLeftIcon, SettingsIcon, SquareTerminalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AgentConfig, SessionMetadata } from "@carmel-agent/shared";

export function HarnessHeader({
  sidebarOpen,
  activeAgent,
  activeSession,
  terminalOpen,
  canOpenTerminal,
  onToggleSidebar,
  onToggleTerminal,
  onOpenSettings,
}: {
  sidebarOpen: boolean;
  activeAgent?: AgentConfig;
  activeSession?: SessionMetadata;
  terminalOpen: boolean;
  canOpenTerminal: boolean;
  onToggleSidebar: () => void;
  onToggleTerminal: () => void;
  onOpenSettings: () => void;
}) {
  /* The subtitle carries only what nothing else on screen says: the model is
     already named in the composer, and the working directory is worth the room
     just when the agent runs somewhere other than its own default. */
  const customWorkingDir =
    activeAgent?.workingDirMode === "manual" && activeAgent.workingDir !== activeAgent.defaultWorkingDir
      ? activeAgent.workingDir
      : "";

  return (
    <header className="flex h-[calc(var(--header-height)+var(--safe-top))] shrink-0 items-center justify-between gap-3 border-b bg-background px-3 pt-[var(--safe-top)]">
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
          <p className="text-ui-smaller truncate text-muted-foreground">
            {activeAgent?.name ?? "No agent"}
            {customWorkingDir ? ` · ${customWorkingDir}` : ""}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {canOpenTerminal ? (
          <Button
            variant={terminalOpen ? "secondary" : "ghost"}
            size="icon-sm"
            title={terminalOpen ? "Close terminal" : "Open terminal"}
            aria-pressed={terminalOpen}
            onClick={onToggleTerminal}
          >
            <SquareTerminalIcon />
          </Button>
        ) : null}
        <Button variant="ghost" size="icon-sm" title="Settings" onClick={onOpenSettings}>
          <SettingsIcon />
        </Button>
      </div>
    </header>
  );
}
