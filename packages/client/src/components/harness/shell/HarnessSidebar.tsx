import { PanelLeftCloseIcon } from "lucide-react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { FileExplorerPanel } from "@/components/harness/files/FileExplorerPanel";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { showError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { useHarnessStore } from "@/store/harness-store";
import type { AgentConfig, SessionMetadata, User } from "@carmel-agent/shared";
import { AgentSelector } from "./AgentSelector";
import { SessionList } from "./SessionList";
import { SidebarTabsToolbar } from "./SidebarTabsToolbar";
import { MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, type SidebarMode } from "./sidebar-utils";

export function HarnessSidebar({
  activeUser,
  activeAgent,
  activeSession,
  visibleAgents,
  visibleSessions,
  selectedFilePath,
  sidebarMode,
  sidebarOpen,
  sidebarWidth,
  onClose,
  onSidebarModeChange,
  onOpenFile,
  onAfterOpen,
  onStartResize,
  onResetWidth,
  onOpenImport,
}: {
  activeUser?: User;
  activeAgent?: AgentConfig;
  activeSession?: SessionMetadata;
  visibleAgents: AgentConfig[];
  visibleSessions: SessionMetadata[];
  selectedFilePath: string;
  sidebarMode: SidebarMode;
  sidebarOpen: boolean;
  sidebarWidth: number;
  onClose: () => void;
  onSidebarModeChange: (mode: SidebarMode) => void;
  onOpenFile: (path: string) => void;
  onAfterOpen: () => void;
  onStartResize: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onResetWidth: () => void;
  onOpenImport: () => void;
}) {
  const store = useHarnessStore();

  const createSidebarAgent = async (): Promise<AgentConfig | undefined> => {
    try {
      return await store.createAgent({
        name: `Agent ${visibleAgents.length + 1}`,
        defaultModelRefId: store.modelRefs[0]?.id,
      });
    } catch (error) {
      showError("Unable to create agent", error);
      return undefined;
    }
  };

  return (
    <aside
      className={cn(
        "fixed inset-y-0 left-0 z-30 flex min-h-0 max-w-[85vw] flex-col border-r bg-sidebar pt-[var(--safe-top)] pb-[var(--safe-bottom)] pl-[var(--safe-left)] shadow-lg transition-transform duration-200 lg:static lg:z-auto lg:max-w-none lg:shrink-0 lg:pl-0 lg:shadow-none",
        sidebarOpen ? "translate-x-0" : "-translate-x-full lg:hidden",
      )}
      style={{ width: sidebarWidth }}
    >
      <div className="flex h-[var(--header-height)] shrink-0 items-center gap-2 px-3">
        <img src="/apple-touch-icon.png" alt="" className="size-6 rounded" draggable={false} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[13px] font-medium">Carmel Agent</h1>
          <p className="text-ui-smaller truncate text-muted-foreground">{activeUser?.email}</p>
        </div>
        <Button size="icon-sm" variant="ghost" title="Collapse sidebar" onClick={onClose}>
          <PanelLeftCloseIcon />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
        <AgentSelector
          activeAgent={activeAgent}
          visibleAgents={visibleAgents}
          activeUserId={store.activeUserId}
          modelRefs={store.modelRefs}
          providerConfigs={store.providerConfigs}
          onCreateAgent={createSidebarAgent}
        />
        <Tabs
          value={sidebarMode}
          onValueChange={(value) => onSidebarModeChange(value as SidebarMode)}
          className="flex min-h-0 flex-1 flex-col gap-2"
        >
          <SidebarTabsToolbar
            activeAgent={activeAgent}
            onSidebarModeChange={onSidebarModeChange}
            onAfterOpen={onAfterOpen}
            onOpenImport={onOpenImport}
          />
          <TabsContent value="sessions" className="min-h-0 flex-1 overflow-hidden">
            <SessionList
              sessions={visibleSessions}
              activeSessionId={activeSession?.id}
              onSidebarModeChange={onSidebarModeChange}
              onAfterOpen={onAfterOpen}
            />
          </TabsContent>
          <TabsContent value="files" className="min-h-0 flex-1 overflow-hidden">
            <FileExplorerPanel
              key={activeAgent?.id ?? "no-agent"}
              agent={activeAgent}
              selectedFilePath={selectedFilePath}
              onOpenFile={onOpenFile}
              onAfterOpen={onAfterOpen}
            />
          </TabsContent>
        </Tabs>
      </div>
      <button
        type="button"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        aria-valuenow={sidebarWidth}
        className="absolute inset-y-0 right-[-3px] hidden w-2 cursor-col-resize touch-none bg-transparent transition-colors hover:bg-[var(--ui2)] focus-visible:bg-[var(--ui2)] focus-visible:outline-none lg:block"
        onPointerDown={onStartResize}
        onDoubleClick={onResetWidth}
      />
    </aside>
  );
}
