import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { MessageSquarePlusIcon, UploadIcon } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { SessionList } from "./shell/SessionList";
import type { AgentConfig, SessionMetadata } from "@carmel-agent/shared";

export function AgentSessionsPage({
  agent,
  sessions,
  runningSessionIds,
  runOverrides,
  onSelectSession,
  onOpenImport,
}: {
  agent: AgentConfig;
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
          <Button asChild>
            <Link to={`/agents/${agent.id}/sessions/new`}>
              <MessageSquarePlusIcon data-icon="inline-start" />
              <Trans>New session</Trans>
            </Link>
          </Button>
        </div>
        <SessionList
          sessions={sessions}
          runningSessionIds={runningSessionIds}
          runOverrides={runOverrides}
          onSelectSession={onSelectSession}
        />
      </div>
    </div>
  );
}
