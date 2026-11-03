import { useLingui } from "@lingui/react";
import { UploadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SessionList } from "./shell/SessionList";
import { NewSessionView } from "./NewSessionView";
import type { AgentConfig, ModelRef, ProviderConfig, SessionMetadata } from "@carmel-agent/shared";

export function AgentSessionsPage({
  agent,
  modelRefs,
  providerConfigs,
  sessions,
  runningSessionIds,
  runOverrides,
  onSelectSession,
  onOpenImport,
}: {
  agent: AgentConfig;
  modelRefs: ModelRef[];
  providerConfigs: ProviderConfig[];
  sessions: SessionMetadata[];
  runningSessionIds: Set<string>;
  runOverrides: Record<string, boolean>;
  onSelectSession: (session: SessionMetadata) => void;
  onOpenImport: () => void;
}) {
  const { i18n } = useLingui();
  return (
    <div className="flex h-full min-h-0 flex-col p-4 sm:p-6">
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-4">
        <div className="flex shrink-0 justify-end gap-2">
          <Button
            variant="outline"
            size="icon"
            title={i18n._("Import Open WebUI export")}
            onClick={onOpenImport}
          >
            <UploadIcon />
          </Button>
        </div>
        <div className="shrink-0">
          <NewSessionView
            agent={agent}
            modelRefs={modelRefs}
            providerConfigs={providerConfigs}
            inline
          />
        </div>
        <SessionList
          sessions={sessions}
          runningSessionIds={runningSessionIds}
          runOverrides={runOverrides}
          onSelectSession={onSelectSession}
          searchable={false}
        />
      </div>
    </div>
  );
}
