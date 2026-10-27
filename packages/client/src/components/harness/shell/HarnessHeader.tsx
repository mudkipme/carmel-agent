import {
  FolderIcon,
  GitCompareIcon,
  GlobeIcon,
  PanelLeftIcon,
  SettingsIcon,
  SquareTerminalIcon,
  ArrowLeftIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { AgentConfig, SessionMetadata } from "@carmel-agent/shared";
import type { ContentView } from "@/lib/shell-route";

export function HarnessHeader({
  sidebarOpen,
  activeAgent,
  activeSession,
  issueTitle,
  contentView,
  homeView,
  companionVisible,
  conversationSwitcher,
  canOpenTerminal,
  browserOpen,
  browserNeedsHelp,
  onToggleBrowser,
  onToggleSidebar,
  onContentViewChange,
  onOpenAgentSettings,
}: {
  sidebarOpen: boolean;
  activeAgent?: AgentConfig;
  activeSession?: SessionMetadata;
  /** The open issue's title, when the issues pane is showing one. */
  issueTitle?: string;
  contentView: ContentView;
  homeView: boolean;
  companionVisible: boolean;
  conversationSwitcher?: ReactNode;
  canOpenTerminal: boolean;
  browserOpen: boolean;
  browserNeedsHelp: boolean;
  onToggleBrowser: () => void;
  onToggleSidebar: () => void;
  onContentViewChange: (view: ContentView) => void;
  onOpenAgentSettings: () => void;
}) {
  /* In split view the workspace names itself, leaving the main header for chat. */
  const title = companionVisible
    ? activeSession?.home
      ? "Home"
      : (activeSession?.title ?? "New session")
    : contentView === "sessions"
      ? "Sessions"
      : contentView === "knowledge"
        ? "Knowledge"
        : contentView === "tasks"
          ? "Tasks"
          : contentView === "files"
            ? "Files"
            : contentView === "changes"
              ? "Changes"
              : contentView === "browser"
                ? "Browser"
                : contentView === "terminal"
                  ? "Terminal"
                  : contentView === "issues"
                    ? (issueTitle ?? "Issues")
                    : homeView || activeSession?.home
                      ? "Home"
                      : (activeSession?.title ?? "New session");
  /* The subtitle carries only what nothing else on screen says: the model is
     already named in the composer, and the working directory is worth the room
     just when the agent runs somewhere other than its own default. */
  const customWorkingDir =
    activeAgent?.workingDirMode === "manual" &&
    activeAgent.workingDir !== activeAgent.defaultWorkingDir
      ? activeAgent.workingDir
      : "";

  return (
    <header className="flex h-[calc(var(--header-height)+var(--safe-top))] shrink-0 items-center justify-between gap-2 border-b bg-background px-2 pt-[var(--safe-top)] sm:gap-3 sm:px-5">
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
        {conversationSwitcher}
        <div className="min-w-0">
          <h2 className="truncate text-sm font-medium">{title}</h2>
          {activeAgent && contentView === "chat" && !homeView && !activeSession?.home ? (
            <Link
              to={`/agents/${activeAgent.id}/sessions`}
              aria-label="Back to sessions"
              className="text-ui-smaller flex min-w-0 items-center gap-1 text-muted-foreground hover:text-foreground"
            >
              <ArrowLeftIcon className="size-3 shrink-0" />
              <span className="truncate">
                Sessions · {activeAgent.name}
                {customWorkingDir ? ` · ${customWorkingDir}` : ""}
              </span>
            </Link>
          ) : (
            <p className="text-ui-smaller truncate text-muted-foreground">
              {activeAgent?.name ?? "No agent"}
              {customWorkingDir ? ` · ${customWorkingDir}` : ""}
            </p>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-0 sm:gap-2">
        {/* Pressing the active tool returns to the companion conversation. */}
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
        {activeAgent?.permissions.bash ? (
          <Button
            variant={browserOpen ? "secondary" : "ghost"}
            size="icon-sm"
            className="relative"
            title={browserOpen ? "Close browser" : "Open browser"}
            aria-label={browserOpen ? "Close browser" : "Open browser"}
            aria-pressed={browserOpen}
            onClick={onToggleBrowser}
          >
            <GlobeIcon />
            {browserNeedsHelp ? (
              <Badge variant="secondary" className="absolute top-0 right-0">
                !
              </Badge>
            ) : null}
          </Button>
        ) : null}
        {activeAgent ? (
          <Button
            variant="ghost"
            size="icon-sm"
            title="Agent settings"
            aria-label="Agent settings"
            onClick={onOpenAgentSettings}
          >
            <SettingsIcon />
          </Button>
        ) : null}
      </div>
    </header>
  );
}
