import { ChevronsUpDownIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { cn, formatRelativeTime } from "@/lib/utils";
import { isListedSession } from "@/store/harness-state";
import { useHarnessStore } from "@/store/harness-store";
import type { AgentConfig, ModelRef, SessionMetadata } from "@carmel-agent/shared";
import { AgentAvatar } from "./AgentAvatar";

type AgentEntry = {
  agent: AgentConfig;
  sessionCount: number;
  lastActiveAt: number;
};

export function AgentSelector({
  activeAgent,
  visibleAgents,
  activeUserId,
  modelRefs,
  onCreateAgent,
}: {
  activeAgent?: AgentConfig;
  visibleAgents: AgentConfig[];
  activeUserId: string;
  modelRefs: ModelRef[];
  onCreateAgent: () => Promise<AgentConfig | undefined>;
}) {
  const navigate = useNavigate();
  const sessions = useHarnessStore((state) => state.sessions);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  const entries = useMemo(
    () => buildEntries(visibleAgents, sessions, activeUserId),
    [activeUserId, sessions, visibleAgents],
  );

  /* Switching agent swaps the whole workspace — sessions, files, working dir —
     so it deserves a shortcut rather than a trip to a dropdown. */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== "j")
        return;
      event.preventDefault();
      setSwitcherOpen((open) => !open);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const selectAgent = useCallback(
    (agentId: string) => {
      setSwitcherOpen(false);
      if (agentId === activeAgent?.id) return;
      navigate(`/agents/${agentId}`);
    },
    [activeAgent?.id, navigate],
  );

  const openAgentSettings = useCallback(
    (agentId: string, section = "general") => {
      setSwitcherOpen(false);
      navigate(`/agents/${agentId}/settings/${section}`);
    },
    [navigate],
  );

  /* A fresh agent has nothing configured yet, so it opens straight into its
     settings rather than an empty chat. */
  const createAgent = async () => {
    setSwitcherOpen(false);
    const createdAgent = await onCreateAgent();
    if (!createdAgent) return;
    openAgentSettings(createdAgent.id);
  };

  const owned = activeAgent?.ownerUserId === activeUserId;
  /* Anyone using an agent can reach its settings, but on a shared agent a
     non-owner only has their own archived sessions there. */
  const settingsSection = owned ? "general" : "archived";

  return (
    <section className="flex items-center gap-1">
      <button
        type="button"
        title="Switch agent"
        aria-haspopup="dialog"
        aria-expanded={switcherOpen}
        className="nav-item flex h-[var(--input-height)] min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left"
        onClick={() => setSwitcherOpen(true)}
      >
        <AgentAvatar agent={activeAgent} />
        <span className="truncate text-[13px] font-medium text-foreground">
          {activeAgent?.name ?? "Select agent"}
        </span>
        {activeAgent?.shared ? (
          <Badge variant="secondary" className="shrink-0">
            Shared
          </Badge>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-faint">
          <kbd className="text-ui-smaller hidden rounded border px-1 font-sans text-muted-foreground sm:inline">
            {shortcutHint()}
          </kbd>
          <ChevronsUpDownIcon className="size-3.5" />
        </span>
      </button>
      <CommandDialog
        open={switcherOpen}
        onOpenChange={setSwitcherOpen}
        title="Switch Agent"
        description="Search your agents, or create a new one."
      >
        <CommandInput placeholder="Search agents..." />
        <CommandList>
          <CommandEmpty>No agents found.</CommandEmpty>
          {entries.length ? (
            <CommandGroup heading="Recent">
              {entries.map(({ agent, sessionCount, lastActiveAt }) => (
                <CommandItem
                  key={agent.id}
                  value={`${agent.name} ${agent.description} ${agent.workingDir}`}
                  onSelect={() => selectAgent(agent.id)}
                >
                  <AgentAvatar
                    agent={agent}
                    className={cn(agent.id !== activeAgent?.id && "opacity-70")}
                  />
                  <div className="flex min-w-0 flex-col">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate">{agent.name}</span>
                      {agent.shared ? (
                        <Badge variant="secondary" className="shrink-0">
                          Shared
                        </Badge>
                      ) : null}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {agent.description || agent.workingDir || "No working directory"}
                    </span>
                  </div>
                  <span className="text-ui-smaller ml-auto shrink-0 text-faint">
                    {sessionCount
                      ? `${sessionCount} session${sessionCount === 1 ? "" : "s"}`
                      : "No sessions"}
                    {lastActiveAt ? ` · ${formatRelativeTime(lastActiveAt)}` : ""}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          <CommandSeparator />
          <CommandGroup heading="Actions">
            <CommandItem
              value="new agent create"
              disabled={!modelRefs.length}
              onSelect={() => void createAgent()}
            >
              <PlusIcon />
              New agent
            </CommandItem>
            {activeAgent ? (
              <CommandItem
                value="agent settings configure archived"
                onSelect={() => openAgentSettings(activeAgent.id, settingsSection)}
              >
                <SettingsIcon />
                Agent settings
              </CommandItem>
            ) : null}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </section>
  );
}

/** Most-recently-worked-in first: the order you actually think about agents in. */
function buildEntries(
  agents: AgentConfig[],
  sessions: SessionMetadata[],
  activeUserId: string,
): AgentEntry[] {
  const counts = new Map<string, { sessionCount: number; lastActiveAt: number }>();
  for (const session of sessions) {
    if (session.userId !== activeUserId || !isListedSession(session)) continue;
    const entry = counts.get(session.agentId) ?? { sessionCount: 0, lastActiveAt: 0 };
    entry.sessionCount += 1;
    entry.lastActiveAt = Math.max(entry.lastActiveAt, session.updatedAt);
    counts.set(session.agentId, entry);
  }

  return agents
    .map((agent) => ({ agent, ...(counts.get(agent.id) ?? { sessionCount: 0, lastActiveAt: 0 }) }))
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt || a.agent.name.localeCompare(b.agent.name));
}

function shortcutHint() {
  const isApple =
    typeof navigator !== "undefined" &&
    /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
  return isApple ? "⌘J" : "Ctrl J";
}
