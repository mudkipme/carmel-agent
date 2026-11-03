import { useEffect, useState } from "react";
import { useLingui } from "@lingui/react";
import type { CollaborationConnection, CollaborationGrant } from "@carmel-agent/shared";
import { FieldGroup, FieldSet, FieldLegend } from "@/components/ui/field";
import { ToggleRow } from "../form-primitives";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { useHarnessStore } from "@/store/harness-store";

const labels = {
  consult: /*i18n*/ "Consultations",
  createTask: /*i18n*/ "Create tasks",
  queueTask: /*i18n*/ "Run tasks with this agent's permissions",
};
export function AgentCollaborationSettings({ agentId }: { agentId: string }) {
  const { i18n } = useLingui();
  const agents = useHarnessStore((state) => state.agents);
  const [connections, setConnections] = useState<CollaborationConnection[] | null>(null);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    void api
      .getCollaborationConnections(agentId)
      .then((value) => {
        if (active) setConnections(value);
      })
      .catch((error) => {
        if (active) setError(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [agentId]);
  async function save(
    peerAgentId: string,
    direction: CollaborationConnection["direction"],
    capabilities: CollaborationGrant,
  ) {
    setSaving(true);
    setError(undefined);
    try {
      setConnections(
        await api.saveCollaborationConnection(agentId, { peerAgentId, direction, capabilities }),
      );
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }
  return (
    <FieldGroup>
      <p className="text-sm text-muted-foreground">
        {i18n._(
          "Both agents must allow a connection. Consultations have read-only tools. Delegated tasks use the receiving agent's configured permissions and credentials.",
        )}
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {!connections && !error ? <p>{i18n._("Loading...")}</p> : null}
      {connections
        ? agents
            .filter((agent) => agent.id !== agentId)
            .map((agent) => (
              <FieldSet key={agent.id} disabled={saving}>
                <FieldLegend>{agent.name}</FieldLegend>
                {(["outgoing", "incoming"] as const).map((direction) => {
                  const grant = connections.find(
                    (item) => item.peerAgentId === agent.id && item.direction === direction,
                  )?.capabilities ?? { consult: false, createTask: false, queueTask: false };
                  return (
                    <FieldSet key={direction}>
                      <FieldLegend variant="label">
                        {direction === "outgoing"
                          ? i18n._("Contact this agent")
                          : i18n._("Allow requests from this agent")}
                      </FieldLegend>
                      <FieldGroup>
                        {(Object.keys(labels) as Array<keyof CollaborationGrant>).map(
                          (capability) => (
                            <ToggleRow
                              key={capability}
                              label={i18n._(labels[capability])}
                              checked={grant[capability]}
                              onCheckedChange={(checked) => {
                                if (!saving)
                                  void save(agent.id, direction, {
                                    ...grant,
                                    [capability]: checked,
                                  });
                              }}
                            />
                          ),
                        )}
                      </FieldGroup>
                    </FieldSet>
                  );
                })}
              </FieldSet>
            ))
        : null}
    </FieldGroup>
  );
}
