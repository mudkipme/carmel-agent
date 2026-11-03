import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import {
  FolderIcon,
  GitCompareIcon,
  GlobeIcon,
  PanelLeftIcon,
  SearchIcon,
  SettingsIcon,
  SquareTerminalIcon,
  ArrowLeftIcon,
} from "lucide-react";
import type { ReactNode, Ref } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { AgentConfig, SessionMetadata } from "@carmel-agent/shared";
import type { ContentView } from "@/lib/shell-route";

export function HarnessHeader({
  sidebarOpen,
  activeAgent,
  activeSession,
  issueTitle,
  taskHeaderRef,
  contentView,
  homeView,
  companionVisible,
  conversationSwitcher,
  canOpenTerminal,
  browserOpen,
  browserNeedsHelp,
  onToggleBrowser,
  onToggleSidebar,
  onOpenSearch,
  onContentViewChange,
  onOpenAgentSettings,
}: {
  sidebarOpen: boolean;
  activeAgent?: AgentConfig;
  activeSession?: SessionMetadata;
  /** The open issue's title, when the issues pane is showing one. */
  issueTitle?: string;
  taskHeaderRef?: Ref<HTMLDivElement>;
  contentView: ContentView;
  homeView: boolean;
  companionVisible: boolean;
  conversationSwitcher?: ReactNode;
  canOpenTerminal: boolean;
  browserOpen: boolean;
  browserNeedsHelp: boolean;
  onToggleBrowser: () => void;
  onToggleSidebar: () => void;
  onOpenSearch: () => void;
  onContentViewChange: (view: ContentView) => void;
  onOpenAgentSettings: () => void;
}) {
  const { i18n } = useLingui();
  const navigationButtons = (
    <div
      className={cn(
        "flex shrink-0 items-center gap-1",
        taskHeaderRef && "mt-3",
        sidebarOpen && "hidden",
      )}
    >
      <Button
        size="icon-sm"
        variant="ghost"
        title={i18n._("Show sidebar")}
        onClick={onToggleSidebar}
      >
        <PanelLeftIcon />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        title={i18n._("Search")}
        aria-label={i18n._("Search")}
        aria-keyshortcuts="Control+Shift+F Meta+Shift+F"
        onClick={onOpenSearch}
      >
        <SearchIcon />
      </Button>
    </div>
  );
  if (taskHeaderRef)
    return (
      <header className="flex shrink-0 items-start gap-2 border-b bg-background px-2 pt-[var(--safe-top)] sm:px-5">
        {navigationButtons}
        <div ref={taskHeaderRef} className="min-w-0 flex-1" />
      </header>
    );
  /* In split view the workspace names itself, leaving the main header for chat. */
  const title = companionVisible
    ? activeSession?.home
      ? i18n._("Home")
      : (activeSession?.title ?? i18n._("New session"))
    : contentView === "sessions"
      ? i18n._("Sessions")
      : contentView === "knowledge"
        ? i18n._("Knowledge")
        : contentView === "schedules"
          ? i18n._("Schedules")
          : contentView === "files"
            ? i18n._("Files")
            : contentView === "changes"
              ? i18n._("Changes")
              : contentView === "browser"
                ? i18n._("Browser")
                : contentView === "terminal"
                  ? i18n._("Terminal")
                  : contentView === "tasks"
                    ? (issueTitle ?? i18n._("Tasks"))
                    : homeView || activeSession?.home
                      ? i18n._("Home")
                      : (activeSession?.title ?? i18n._("New session"));
  /* The subtitle carries only what nothing else on screen says: the model is
     already named in the composer, and the working directory is worth the room
     just when the agent runs somewhere other than its own default. */
  const customWorkingDir =
    activeAgent?.workingDirMode === "manual" &&
    activeAgent.workingDir !== activeAgent.defaultWorkingDir
      ? activeAgent.workingDir
      : "";

  return (
    <header className="flex h-[calc(var(--header-height)+var(--safe-top))] shrink-0 items-center justify-between gap-2 border-b bg-background px-2 pt-[var(--safe-top)] max-[360px]:h-auto max-[360px]:min-h-[calc(var(--header-height)+var(--safe-top))] max-[360px]:flex-wrap max-[360px]:pt-[calc(0.25rem+var(--safe-top))] max-[360px]:pb-1 sm:gap-3 sm:px-5">
      <div className="flex min-w-0 items-center gap-2">
        {navigationButtons}
        {conversationSwitcher}
        <div className="min-w-0">
          <h2 className="truncate text-sm font-medium">{title}</h2>
          {activeAgent && contentView === "chat" && !homeView && !activeSession?.home ? (
            <Link
              to={`/agents/${activeAgent.id}/sessions`}
              aria-label={i18n._("Back to sessions")}
              className="text-ui-smaller flex min-w-0 items-center gap-1 text-muted-foreground hover:text-foreground"
            >
              <ArrowLeftIcon className="size-3 shrink-0" />
              <span className="truncate">
                <Trans>
                  Sessions · {activeAgent.name}
                  {customWorkingDir ? ` · ${customWorkingDir}` : ""}
                </Trans>
              </span>
            </Link>
          ) : (
            <p className="text-ui-smaller truncate text-muted-foreground">
              {activeAgent?.name ?? i18n._("No agent")}
              {customWorkingDir ? ` · ${customWorkingDir}` : ""}
            </p>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-0 max-[360px]:ml-auto sm:gap-2">
        {/* Pressing the active tool returns to the companion conversation. */}
        {activeAgent ? (
          <Button
            variant={contentView === "files" ? "secondary" : "ghost"}
            size="icon-sm"
            title={contentView === "files" ? i18n._("Close files") : i18n._("Browse files")}
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
            title={
              contentView === "changes" ? i18n._("Close changes") : i18n._("Uncommitted changes")
            }
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
            title={contentView === "terminal" ? i18n._("Close terminal") : i18n._("Open terminal")}
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
            title={browserOpen ? i18n._("Close browser") : i18n._("Open browser")}
            aria-label={browserOpen ? i18n._("Close browser") : i18n._("Open browser")}
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
            title={i18n._("Agent settings")}
            aria-label={i18n._("Agent settings")}
            onClick={onOpenAgentSettings}
          >
            <SettingsIcon />
          </Button>
        ) : null}
      </div>
    </header>
  );
}
