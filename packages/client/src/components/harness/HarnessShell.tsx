import {
  BotIcon,
  MessageSquarePlusIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import { PiChat } from "@/components/PiChat";
import { AgentSettingsDialog } from "@/components/harness/AgentSettingsDialog";
import { SettingsDialog } from "@/components/harness/SettingsDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn, formatRelativeTime } from "@/lib/utils";
import { useHarnessStore } from "@/store/harness-store";

export function HarnessShell() {
  const store = useHarnessStore();
  const activeUser = store.users.find((user) => user.id === store.activeUserId);
  const selectedSession = store.sessions.find(
    (session) => session.id === store.activeSessionId && session.userId === store.activeUserId,
  );
  const visibleAgents = store.agents.filter((agent) => agent.shared || agent.ownerUserId === store.activeUserId);
  const selectedAgent = visibleAgents.find((agent) => agent.id === store.activeAgentId);
  const activeAgent = selectedAgent ?? visibleAgents.find((agent) => agent.id === selectedSession?.agentId);
  const activeSession =
    selectedSession?.userId === store.activeUserId && selectedSession.agentId === activeAgent?.id
      ? selectedSession
      : undefined;
  const activeModel = store.modelRefs.find((model) => model.id === activeSession?.modelRefId);
  const visibleSessions = store.sessions
    .filter((session) => session.userId === store.activeUserId && session.agentId === activeAgent?.id)
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt);

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
    <main className="grid h-screen min-h-0 grid-cols-1 overflow-hidden bg-background text-foreground lg:grid-cols-[298px_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col border-b bg-muted/50 lg:border-b-0 lg:border-r">
        <div className="flex h-11 items-center gap-2 border-b px-3">
          <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <BotIcon className="size-4" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-[13px] font-medium">Carmel Agent</h1>
            <p className="truncate text-xs text-muted-foreground">{activeUser?.email}</p>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-2">
          <section className="flex flex-col gap-1">
            <div className="flex items-center justify-between px-2">
              <h2 className="text-xs font-normal text-muted-foreground">Agents</h2>
              <div className="flex items-center gap-1">
                <Badge variant="secondary">{visibleAgents.length}</Badge>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  disabled={!store.modelRefs.length}
                  onClick={() => void createSidebarAgent()}
                  title="New agent"
                >
                  <BotIcon />
                </Button>
              </div>
            </div>
            <div className="flex flex-col gap-1">
              {visibleAgents.map((agent) => {
                const owned = agent.ownerUserId === store.activeUserId;
                return (
                  <div
                    key={agent.id}
                    className={cn(
                      "group flex items-start gap-1 rounded-md px-2 py-1.5 text-[13px] transition-colors hover:bg-accent hover:text-accent-foreground",
                      agent.id === activeAgent?.id && "bg-accent text-accent-foreground",
                    )}
                  >
                    <button className="min-w-0 flex-1 text-left" onClick={() => store.setActiveAgent(agent.id)}>
                      <span className="block truncate text-[13px]">{agent.name}</span>
                      <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
                        {agent.shared ? <span className="shrink-0">Shared</span> : null}
                        {agent.shared && agent.description ? <span className="shrink-0">·</span> : null}
                        <span className="truncate">{agent.description}</span>
                      </p>
                    </button>
                    {owned ? (
                      <AgentSettingsDialog
                        agent={agent}
                        modelRefs={store.modelRefs}
                        providerConfigs={store.providerConfigs}
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>

          <section className="flex min-h-0 flex-1 flex-col gap-1">
            <div className="flex items-center justify-between px-2">
              <h2 className="text-xs font-normal text-muted-foreground">Sessions</h2>
              <Button
                size="icon-xs"
                variant="ghost"
                onClick={() => {
                  if (!activeAgent) return;
                  void store.createSession({
                    agentId: activeAgent.id,
                    modelRefId: activeAgent.defaultModelRefId,
                    thinkingLevel: "off",
                  });
                }}
              >
                <MessageSquarePlusIcon />
              </Button>
            </div>
            <div className="flex min-h-0 flex-col gap-1 overflow-auto">
              {visibleSessions.map((session) => (
                <div
                  key={session.id}
                  className={cn(
                    "group flex items-start gap-1 rounded-md px-2 py-1.5 transition-colors hover:bg-accent hover:text-accent-foreground",
                    session.id === activeSession?.id && "bg-accent text-accent-foreground",
                  )}
                >
                  <button className="min-w-0 flex-1 text-left" onClick={() => store.setActiveSession(session.id)}>
                    <span className="block truncate text-[13px]">{session.title}</span>
                    <p className="mt-0.5 text-xs text-muted-foreground">{formatRelativeTime(session.updatedAt)}</p>
                  </button>
                  <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      title="Rename session"
                      onClick={() => {
                        const nextTitle = window.prompt("Rename session", session.title);
                        const title = nextTitle?.trim();
                        if (!title || title === session.title) return;
                        void store.updateSession(session.id, { title });
                      }}
                    >
                      <PencilIcon />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      title="Delete session"
                      onClick={() => {
                        const confirmed = window.confirm(`Delete "${session.title}"?`);
                        if (!confirmed) return;
                        void store.deleteSession(session.id);
                      }}
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </aside>

      <section className="flex min-h-0 flex-col">
        <header className="flex h-11 items-center justify-between gap-3 border-b bg-background px-4">
          <div className="min-w-0">
            <h2 className="truncate text-[13px] font-medium">{activeSession?.title ?? "No session"}</h2>
            <p className="truncate text-xs text-muted-foreground">
              {activeAgent?.workingDir ?? "No working directory"} · {activeModel?.label ?? "No model"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary">{activeSession?.thinkingLevel ?? "off"}</Badge>
            <Badge variant="secondary">{activeAgent?.permissions.bash ? "bash on" : "bash off"}</Badge>
            <SettingsDialog modelRefs={store.modelRefs} providerConfigs={store.providerConfigs} />
          </div>
        </header>
        <div className="min-h-0 flex-1">
          {activeSession && activeAgent && activeModel ? (
            <PiChat
              key={activeSession.id}
              agentConfig={activeAgent}
              session={activeSession}
              modelRef={activeModel}
              modelRefs={store.modelRefs}
              providerConfigs={store.providerConfigs}
            />
          ) : (
            <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
              Create a session to start chatting.
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
