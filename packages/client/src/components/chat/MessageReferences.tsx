import { AtSignIcon } from "lucide-react";
import { useContext } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { getMessageReferences, referenceKey, referenceLabel } from "@carmel-agent/shared";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Badge } from "@/components/ui/badge";
import { agentFilesPath } from "@/lib/file-links";
import { workspaceChatPath } from "@/lib/workspace-layout";
import { WorkspaceFileLinkAgentContext } from "./workspace-file-links";

export function MessageReferences({ message }: { message: AgentMessage }) {
  const references = getMessageReferences(message);
  const agentId = useContext(WorkspaceFileLinkAgentContext);
  const { sessionId } = useParams();
  const [params] = useSearchParams();
  if (!references.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1" aria-label="Message references">
      {references.map((reference) => {
        const label = referenceLabel(reference);
        const href =
          reference.kind === "session"
            ? `/agents/${encodeURIComponent(reference.agentId)}/sessions/${encodeURIComponent(reference.sessionId)}`
            : agentId
              ? workspaceChatPath(
                  agentFilesPath(agentId, reference.path === "." ? "" : reference.path),
                  sessionId ?? params.get("chat") ?? undefined,
                )
              : undefined;
        return (
          <Badge
            key={referenceKey(reference)}
            variant="outline"
            className="max-w-full"
            asChild={Boolean(href)}
          >
            {href ? (
              <Link to={href} title={label}>
                <AtSignIcon />
                <span className="truncate">{label}</span>
              </Link>
            ) : (
              <span title={label}>{label}</span>
            )}
          </Badge>
        );
      })}
    </div>
  );
}
