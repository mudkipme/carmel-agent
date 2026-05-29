import { PanelLeftCloseIcon } from "lucide-react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { FileExplorerPanel } from "@/components/harness/files/FileExplorerPanel";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent } from "@/components/ui/tabs";
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

  const createSidebarAgent = async () => {
    try {
      await store.createAgent({
        name: `Agent ${visibleAgents.length + 1}`,
        defaultModelRefId: store.modelRefs[0]?.id,
      });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Unable to create agent");
    }
  };

  return (
    <aside
      className={cn(
        "fixed inset-y-0 left-0 z-30 flex min-h-0 flex-col border-r bg-muted/50 shadow-lg transition-transform duration-200 lg:static lg:z-auto lg:shrink-0 lg:shadow-none",
        sidebarOpen ? "translate-x-0" : "-translate-x-full lg:hidden",
      )}
      style={{ width: sidebarWidth }}
    >
      <div className="flex h-11 items-center gap-2 border-b px-3">
        <img src="/favicon.svg" alt="" className="size-7 rounded-md" draggable={false} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[13px] font-medium">Carmel Agent</h1>
          <p className="truncate text-xs text-muted-foreground">{activeUser?.email}</p>
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
          onCreateAgent={() => void createSidebarAgent()}
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
        className="absolute inset-y-0 right-[-3px] hidden w-2 cursor-col-resize touch-none bg-transparent transition-colors hover:bg-border/80 focus-visible:bg-border/80 focus-visible:outline-none lg:block"
        onPointerDown={onStartResize}
        onDoubleClick={onResetWidth}
      />
    </aside>
  );
}
