import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { ArrowLeftIcon, CalendarClockIcon, FileTextIcon, ShieldIcon, SlidersHorizontalIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import { AgentGeneralSettings } from "@/components/harness/agent-settings/AgentGeneralSettings";
import { AgentPermissionsSettings } from "@/components/harness/agent-settings/AgentPermissionsSettings";
import { AgentTemplatesSettings } from "@/components/harness/agent-settings/AgentTemplatesSettings";
import { AgentTasksPanel } from "@/components/harness/AgentTasksPanel";
import { Button } from "@/components/ui/button";
import { confirmAction } from "@/lib/action-dialogs";
import { api } from "@/lib/api";
import { errorMessage, showError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { resolveModelRef, useHarnessStore } from "@/store/harness-store";
import type { AgentConfig, AgentThinkingLevel } from "@carmel-agent/shared";

const agentSettingsSections = [
  { id: "general", label: "General", icon: SlidersHorizontalIcon },
  { id: "templates", label: "Templates", icon: FileTextIcon },
  { id: "permissions", label: "Permissions", icon: ShieldIcon },
  { id: "tasks", label: "Tasks", icon: CalendarClockIcon },
] as const;
type AgentSettingsSection = (typeof agentSettingsSections)[number]["id"];

export function AgentSettingsPage() {
  const navigate = useNavigate();
  const { agentId = "", section } = useParams();
  const modelRefs = useHarnessStore((state) => state.modelRefs);
  const providerConfigs = useHarnessStore((state) => state.providerConfigs);
  const agent = useHarnessStore((state) => state.agents.find((item) => item.id === agentId));
  const activeUserId = useHarnessStore((state) => state.activeUserId);
  const canConfigureHostPaths = useHarnessStore(
    (state) => state.users.find((user) => user.id === state.activeUserId)?.role === "admin",
  );
  const upsertAgent = useHarnessStore((state) => state.upsertAgent);
  const deleteAgent = useHarnessStore((state) => state.deleteAgent);
  const owned = agent?.ownerUserId === activeUserId;
  const activeSection = agentSettingsSections.some((item) => item.id === section)
    ? (section as AgentSettingsSection)
    : "general";
  const [draft, setDraft] = useState<AgentConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const defaultModelRef = modelRefs.find((model) => model.id === draft?.defaultModelRefId);
  const thinkingLevels = useMemo<AgentThinkingLevel[]>(() => {
    if (!defaultModelRef) return ["off"];
    return getSupportedThinkingLevels(resolveModelRef(defaultModelRef)) as AgentThinkingLevel[];
  }, [defaultModelRef]);
  const selectedThinkingLevel =
    draft && thinkingLevels.includes(draft.defaultThinkingLevel)
      ? draft.defaultThinkingLevel
      : (thinkingLevels[0] ?? "off");

  useEffect(() => {
    if (section && !agentSettingsSections.some((item) => item.id === section)) {
      navigate(`/agents/${agentId}/settings/general`, { replace: true });
    }
  }, [agentId, navigate, section]);

  /* Only the owner configures an agent — a shared one is read-only to everyone
     else, and a stale link points at nothing at all. */
  useEffect(() => {
    if (!agent) navigate("/", { replace: true });
    else if (!owned) navigate(`/agents/${agent.id}`, { replace: true });
  }, [agent, navigate, owned]);

  /* The list in the store carries only what the sidebar renders; the full
     record — prompt, mounts, permissions — comes from the settings endpoint. */
  useEffect(() => {
    if (!agentId || !owned) return;
    let cancelled = false;
    setDraft(null);
    setLoadError(null);
    void api
      .getAgentSettings(agentId)
      .then((payload) => {
        if (!cancelled) setDraft(payload);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(errorMessage(error, "Unable to load agent settings"));
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, owned]);

  const updateDraft = (patch: Partial<AgentConfig>) => {
    setSaveMessage(null);
    setDraft((current) => (current ? { ...current, ...patch } : current));
  };

  const selectModel = (defaultModelRefId: string) => {
    const nextModelRef = modelRefs.find((model) => model.id === defaultModelRefId);
    updateDraft({
      defaultModelRefId,
      defaultThinkingLevel:
        nextModelRef && draft
          ? (clampThinkingLevel(resolveModelRef(nextModelRef), draft.defaultThinkingLevel) as AgentThinkingLevel)
          : "off",
    });
  };

  const saveAgent = async () => {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      await upsertAgent({ ...draft, defaultThinkingLevel: selectedThinkingLevel, updatedAt: Date.now() });
      setSaveMessage("Agent saved.");
    } catch (error) {
      setSaveError(errorMessage(error, "Unable to save agent"));
    } finally {
      setSaving(false);
    }
  };

  const removeAgent = async () => {
    if (!agent) return;
    const confirmed = await confirmAction({
      title: `Delete ${agent.name}?`,
      description: "This permanently deletes the agent and all of its sessions.",
      actionLabel: "Delete agent",
    });
    if (!confirmed) return;
    try {
      await deleteAgent(agent.id);
      navigate("/", { replace: true });
    } catch (error) {
      showError("Unable to delete agent", error);
    }
  };

  if (!agent || !owned) return null;

  return (
    <main className="flex h-[100dvh] min-h-0 flex-col bg-background pr-[var(--safe-right)] pl-[var(--safe-left)] text-foreground">
      <header className="flex h-[calc(var(--header-height)+var(--safe-top))] shrink-0 items-center gap-3 border-b px-3 pt-[var(--safe-top)]">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            title="Back to agent"
            onClick={() => navigate(`/agents/${agent.id}`)}
          >
            <ArrowLeftIcon />
          </Button>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-medium">Agent Settings</h1>
            <p className="text-ui-smaller truncate text-muted-foreground">{agent.name}</p>
          </div>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="shrink-0 border-b bg-sidebar p-2 md:w-56 md:border-r md:border-b-0">
          <nav className="grid grid-cols-2 gap-1 md:grid-cols-1">
            {agentSettingsSections.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.id}
                  to={`/agents/${agent.id}/settings/${item.id}`}
                  data-active={item.id === activeSection}
                  className={({ isActive }) =>
                    cn("nav-item flex h-8 items-center gap-2 rounded-md px-2.5 text-[13px]", isActive && "font-medium")
                  }
                >
                  <Icon data-icon="inline-start" />
                  <span className="truncate">{item.label}</span>
                </NavLink>
              );
            })}
          </nav>
        </aside>
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div
              data-settings-content
              className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-4 p-3 pb-[calc(0.75rem+var(--safe-bottom))] sm:p-4 sm:pb-[calc(1rem+var(--safe-bottom))] md:p-6 md:pb-[calc(1.5rem+var(--safe-bottom))]"
            >
              {loadError ? <p className="text-sm text-destructive">{loadError}</p> : null}
              {!draft && !loadError ? <p className="text-sm text-muted-foreground">Loading agent settings...</p> : null}
              {draft ? (
                <>
                  {activeSection === "general" ? (
                    <AgentGeneralSettings
                      draft={draft}
                      modelRefs={modelRefs}
                      providerConfigs={providerConfigs}
                      canConfigureHostPaths={canConfigureHostPaths}
                      thinkingLevels={thinkingLevels}
                      selectedThinkingLevel={selectedThinkingLevel}
                      onChange={updateDraft}
                      onSelectModel={selectModel}
                      onDelete={() => void removeAgent()}
                    />
                  ) : null}
                  {activeSection === "templates" ? (
                    <AgentTemplatesSettings
                      templates={draft.promptTemplates}
                      onChange={(promptTemplates) => updateDraft({ promptTemplates })}
                    />
                  ) : null}
                  {activeSection === "permissions" ? (
                    <AgentPermissionsSettings
                      permissions={draft.permissions}
                      onChange={(permissions) => updateDraft({ permissions })}
                    />
                  ) : null}
                  {activeSection === "tasks" ? <AgentTasksPanel agentId={agent.id} /> : null}
                </>
              ) : null}
            </div>
          </div>
          {/* Tasks save themselves, so the draft's save bar would only be a
              misleading no-op there. */}
          {draft && activeSection !== "tasks" ? (
            <footer className="flex shrink-0 items-center justify-end gap-3 border-t px-3 py-2 pb-[calc(0.5rem+var(--safe-bottom))]">
              {saveError ? <p className="text-sm text-destructive">{saveError}</p> : null}
              {saveMessage ? <p className="text-sm text-muted-foreground">{saveMessage}</p> : null}
              <Button type="button" onClick={() => void saveAgent()} disabled={saving}>
                {saving ? "Saving..." : "Save"}
              </Button>
            </footer>
          ) : null}
        </section>
      </div>
    </main>
  );
}
