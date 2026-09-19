import { FolderIcon, GitCompareIcon, PanelLeftIcon, SettingsIcon, SquareTerminalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AgentConfig, SessionMetadata } from "@carmel-agent/shared";
import type { ContentView } from "./sidebar-utils";

export function HarnessHeader({
  sidebarOpen,
  activeAgent,
  activeSession,
  issueTitle,
  contentView,
  canOpenTerminal,
  onToggleSidebar,
  onContentViewChange,
  onOpenSettings,
}: {
  sidebarOpen: boolean;
  activeAgent?: AgentConfig;
  activeSession?: SessionMetadata;
  /** The open issue's title, when the issues pane is showing one. */
  issueTitle?: string;
  contentView: ContentView;
  canOpenTerminal: boolean;
  onToggleSidebar: () => void;
  onContentViewChange: (view: ContentView) => void;
  onOpenSettings: () => void;
}) {
  /* Files and the terminal replace the session in the main column, so the
     title names the pane you are actually looking at. */
  const title =
    contentView === "files"
      ? "Files"
      : contentView === "changes"
        ? "Changes"
        : contentView === "terminal"
          ? "Terminal"
          : contentView === "issues"
            ? (issueTitle ?? "New issue")
            : (activeSession?.title ?? "New session");
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
        {/* An open sidebar carries its own collapse button; on desktop it sits
            beside this header, so the toggle here would be a duplicate. */}
        <Button
          size="icon-sm"
          variant="ghost"
          title="Show sidebar"
          className={sidebarOpen ? "lg:hidden" : undefined}
          onClick={onToggleSidebar}
        >
          <PanelLeftIcon />
        </Button>
        <div className="min-w-0">
          <h2 className="truncate text-[13px] font-medium">{title}</h2>
          <p className="text-ui-smaller truncate text-muted-foreground">
            {activeAgent?.name ?? "No agent"}
            {customWorkingDir ? ` · ${customWorkingDir}` : ""}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {/* Each pane has its own route and the main column shows one at a
            time, so pressing the active one navigates back to the chat. */}
        {activeAgent ? (
          <Button
            variant={contentView === "files" ? "secondary" : "ghost"}
            size="icon-sm"
            title={contentView === "files" ? "Close files" : "Browse files"}
            aria-pressed={contentView === "files"}
            onClick={() => onContentViewChange(contentView === "files" ? "chat" : "files")}
          >
            <FolderIcon />
          </Button>
        ) : null}
        {activeAgent?.permissions.read ? (
          <Button
            variant={contentView === "changes" ? "secondary" : "ghost"}
            size="icon-sm"
            title={contentView === "changes" ? "Close changes" : "Uncommitted changes"}
            aria-pressed={contentView === "changes"}
            onClick={() => onContentViewChange(contentView === "changes" ? "chat" : "changes")}
          >
            <GitCompareIcon />
          </Button>
        ) : null}
        {canOpenTerminal ? (
          <Button
            variant={contentView === "terminal" ? "secondary" : "ghost"}
            size="icon-sm"
            title={contentView === "terminal" ? "Close terminal" : "Open terminal"}
            aria-pressed={contentView === "terminal"}
            onClick={() => onContentViewChange(contentView === "terminal" ? "chat" : "terminal")}
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
