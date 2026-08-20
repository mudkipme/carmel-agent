import { BotIcon } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AgentSettingsDialog } from "@/components/harness/AgentSettingsDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useHarnessStore } from "@/store/harness-store";
import type { AgentConfig, ModelRef, ProviderConfig } from "@carmel-agent/shared";

export function AgentSelector({
  activeAgent,
  visibleAgents,
  activeUserId,
  modelRefs,
  providerConfigs,
  onCreateAgent,
}: {
  activeAgent?: AgentConfig;
  visibleAgents: AgentConfig[];
  activeUserId: string;
  modelRefs: ModelRef[];
  providerConfigs: ProviderConfig[];
  onCreateAgent: () => Promise<AgentConfig | undefined>;
}) {
  const navigate = useNavigate();
  const setActiveAgent = useHarnessStore((state) => state.setActiveAgent);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const createAgent = async () => {
    const createdAgent = await onCreateAgent();
    if (!createdAgent) return;
    setActiveAgent(createdAgent.id);
    navigate(`/agents/${createdAgent.id}`);
    setSettingsOpen(true);
  };

  return (
    <section className="flex flex-col gap-1">
      <div className="flex items-center justify-between px-2">
        <h2 className="nav-label">Agent</h2>
        <span className="text-ui-smaller text-faint">{visibleAgents.length}</span>
      </div>
      <div className="flex items-center gap-1">
        <Select
          value={activeAgent?.id}
          disabled={!visibleAgents.length}
          onValueChange={(agentId) => {
            setActiveAgent(agentId);
            navigate(`/agents/${agentId}`);
          }}
        >
          <SelectTrigger className="h-[var(--input-height)] min-w-0 flex-1 px-2 text-[13px]">
            <SelectValue placeholder="Select agent" />
          </SelectTrigger>
          <SelectContent className="max-w-[280px]">
            <SelectGroup>
              {visibleAgents.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{agent.name}</span>
                    {agent.shared ? (
                      <Badge variant="secondary" className="shrink-0">
                        Shared
                      </Badge>
                    ) : null}
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {activeAgent?.ownerUserId === activeUserId ? (
          <AgentSettingsDialog
            agent={activeAgent}
            modelRefs={modelRefs}
            providerConfigs={providerConfigs}
            triggerClassName="opacity-100"
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
          />
        ) : null}
        <Button size="icon-sm" variant="ghost" disabled={!modelRefs.length} onClick={() => void createAgent()} title="New agent">
          <BotIcon />
        </Button>
      </div>
    </section>
  );
}
