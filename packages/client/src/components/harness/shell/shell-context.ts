import { createContext, useContext, type ReactNode } from "react";
import type {
  AgentConfig,
  ModelRef,
  ProviderConfig,
  Session,
  SessionMetadata,
} from "@carmel-agent/shared";
import type { ContentView, resolveShellRoute } from "@/lib/shell-route";

export type ShellRouteHandle = {
  view?: ContentView;
  homeView?: boolean;
};

export type HarnessShellContextValue = {
  view: ContentView;
  homeView: boolean;
  route: ReturnType<typeof resolveShellRoute>;
  activeAgent?: AgentConfig;
  activeSession?: Session;
  activeModel?: ModelRef;
  onNewSessionPage: boolean;
  canOpenTerminal: boolean;
  browserOpen: boolean;
  modelRefs: ModelRef[];
  providerConfigs: ProviderConfig[];
  visibleSessions: SessionMetadata[];
  runningSessionIds: Set<string>;
  runOverrides: Record<string, boolean>;
  browserRequest?: ReactNode;
  headerActionsTarget: HTMLDivElement | null;
  taskHeaderTarget: HTMLDivElement | null;
  setIssueTitle: (title?: string) => void;
  onActiveSessionStreamingChange: (streaming: boolean, hasStreamed: boolean) => void;
  onOpenImport: () => void;
  openFile: (path: string) => void;
  openChange: (change?: { path: string; area: string }) => void;
};

export const HarnessShellContext = createContext<HarnessShellContextValue | null>(null);

export function useHarnessShell() {
  const value = useContext(HarnessShellContext);
  if (!value) throw new Error("useHarnessShell must be used inside HarnessShell.");
  return value;
}
