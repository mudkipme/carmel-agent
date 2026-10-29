import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  ArchiveIcon,
  BookOpenIcon,
  CodeIcon,
  FileTextIcon,
  KeyRoundIcon,
  PlugIcon,
  ShieldIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AgentArchivedSessionsSettings } from "@/components/harness/agent-settings/AgentArchivedSessionsSettings";
import { AgentGeneralSettings } from "@/components/harness/agent-settings/AgentGeneralSettings";
import { AgentKnowledgeSettings } from "@/components/harness/agent-settings/AgentKnowledgeSettings";
import { AgentPermissionsSettings } from "@/components/harness/agent-settings/AgentPermissionsSettings";
import { AgentSecretsSettings } from "@/components/harness/agent-settings/AgentSecretsSettings";
import { AgentIntegrationsSettings } from "@/components/harness/agent-settings/AgentIntegrationsSettings";
import { AgentTemplatesSettings } from "@/components/harness/agent-settings/AgentTemplatesSettings";
import { AgentMcpSettings } from "@/components/harness/agent-settings/AgentMcpSettings";
import { AgentCodemodeSettings } from "@/components/harness/agent-settings/AgentCodemodeSettings";
import { Button } from "@/components/ui/button";
import { confirmAction } from "@/lib/action-dialogs";
import { api } from "@/lib/api";
import { errorMessage, showError } from "@/lib/errors";
import { SettingsLayout } from "./SettingsLayout";
import { UnsavedChangesDialog } from "./UnsavedChangesDialog";
import { useHarnessStore } from "@/store/harness-store";
import { resolveModelRef, type AgentConfig, type AgentThinkingLevel } from "@carmel-agent/shared";

const agentSettingsSections = [
  { id: "general", label: /*i18n*/ "General", icon: SlidersHorizontalIcon },
  { id: "knowledge", label: /*i18n*/ "Knowledge", icon: BookOpenIcon },
  { id: "templates", label: /*i18n*/ "Templates", icon: FileTextIcon },
  { id: "permissions", label: /*i18n*/ "Permissions", icon: ShieldIcon },
  { id: "codemode", label: /*i18n*/ "Codemode", icon: CodeIcon },
  { id: "secrets", label: /*i18n*/ "Secrets", icon: KeyRoundIcon },
  { id: "mcp", label: "MCP", icon: PlugIcon },
  { id: "integrations", label: /*i18n*/ "Integrations", icon: PlugIcon },
  { id: "archived", label: /*i18n*/ "Archived", icon: ArchiveIcon },
] as const;
type AgentSettingsSection = (typeof agentSettingsSections)[number]["id"];

/* A shared agent's settings belong to its owner. Everyone can manage their
   own archived sessions and IM integrations. */
const sharedAgentSettingsSections = agentSettingsSections.filter(
  (item) => item.id === "archived" || item.id === "integrations",
);

export function AgentSettingsPage() {
  const { i18n } = useLingui();
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
  const sections = owned ? agentSettingsSections : sharedAgentSettingsSections;
  const defaultSection: AgentSettingsSection = owned ? "general" : "archived";
  const activeSection = sections.some((item) => item.id === section)
    ? (section as AgentSettingsSection)
    : defaultSection;
  const callerSection = activeSection === "archived" || activeSection === "integrations";
  const [draft, setDraft] = useState<AgentConfig | null>(null);
  const [savedDraft, setSavedDraft] = useState<AgentConfig | null>(null);
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
    if (agent && section !== activeSection) {
      navigate(`/agents/${agentId}/settings/${activeSection}`, { replace: true });
    }
  }, [activeSection, agent, agentId, navigate, section]);

  /* Only the owner configures an agent. Other users manage their personal
     archived sessions and integrations; a stale link points at nothing. */
  useEffect(() => {
    if (!agent) navigate("/", { replace: true });
  }, [agent, navigate]);

  /* The list in the store carries only what the sidebar renders; the full
     record — prompt, mounts, permissions — comes from the settings endpoint. */
  useEffect(() => {
    if (!agentId || !owned) return;
    let cancelled = false;
    setDraft(null);
    setSavedDraft(null);
    setLoadError(null);
    void api
      .getAgentSettings(agentId)
      .then((payload) => {
        if (!cancelled) {
          setDraft(payload);
          setSavedDraft(payload);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(errorMessage(error, i18n._("Unable to load agent settings")));
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, owned, i18n]);

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
          ? (clampThinkingLevel(
              resolveModelRef(nextModelRef),
              draft.defaultThinkingLevel,
            ) as AgentThinkingLevel)
          : "off",
    });
  };

  const saveAgent = async () => {
    if (!draft || saving) return false;
    setSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      await upsertAgent({
        ...draft,
        defaultThinkingLevel: selectedThinkingLevel,
        updatedAt: Date.now(),
      });
      setSavedDraft(draft);
      setSaveMessage(i18n._("Agent saved."));
      return true;
    } catch (error) {
      setSaveError(errorMessage(error, i18n._("Unable to save agent")));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const removeAgent = async () => {
    if (!agent) return;
    const confirmed = await confirmAction({
      title: i18n._("Delete {name}?", { name: agent.name }),
      description: i18n._("This permanently deletes the agent and all of its sessions."),
      actionLabel: i18n._("Delete agent"),
    });
    if (!confirmed) return;
    try {
      await deleteAgent(agent.id);
      navigate("/", { replace: true });
    } catch (error) {
      showError(i18n._("Unable to delete agent"), error);
    }
  };

  if (!agent) return null;

  return (
    <SettingsLayout
      title={i18n._("Agent Settings")}
      subtitle={agent.name}
      backLabel={i18n._("Back to agent")}
      onBack={() => navigate(`/agents/${agent.id}`)}
      activeSection={activeSection}
      sections={sections.map((item) => ({
        ...item,
        label: i18n._(item.label),
        to: `/agents/${agent.id}/settings/${item.id}`,
      }))}
      footer={
        draft && !callerSection && activeSection !== "secrets" && activeSection !== "knowledge" ? (
          <footer className="flex shrink-0 flex-wrap items-center justify-end gap-3 border-t bg-muted/30 px-4 py-3 pb-[calc(0.75rem+var(--safe-bottom))] sm:px-8">
            {saveError ? <p className="text-sm text-destructive">{saveError}</p> : null}
            {saveMessage ? <p className="text-sm text-muted-foreground">{saveMessage}</p> : null}
            <Button type="button" onClick={() => void saveAgent()} disabled={saving}>
              {saving ? i18n._("Saving...") : i18n._("Save")}
            </Button>
          </footer>
        ) : null
      }
    >
      <UnsavedChangesDialog
        dirty={Boolean(draft && savedDraft && JSON.stringify(draft) !== JSON.stringify(savedDraft))}
        saving={saving}
        shouldBlock={({ nextLocation }) =>
          !nextLocation.pathname.startsWith(`/agents/${agentId}/settings/`)
        }
        onSave={saveAgent}
      />
      {/* Archived sessions are the caller's own, not part of the owner-only draft. */}
      {activeSection === "archived" ? <AgentArchivedSessionsSettings agentId={agent.id} /> : null}
      {activeSection === "integrations" ? (
        <AgentIntegrationsSettings key={`${agent.id}:${activeUserId}`} agentId={agent.id} />
      ) : null}
      {owned && !callerSection && loadError ? (
        <p className="text-sm text-destructive">{loadError}</p>
      ) : null}
      {owned && !callerSection && !draft && !loadError ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Loading agent settings...</Trans>
        </p>
      ) : null}
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
          {activeSection === "secrets" ? (
            <AgentSecretsSettings agentId={agent.id} shared={draft.shared} />
          ) : null}
          {activeSection === "knowledge" ? (
            <AgentKnowledgeSettings key={agent.id} agentId={agent.id} />
          ) : null}
          {activeSection === "codemode" ? (
            <AgentCodemodeSettings
              enabled={draft.codemodeEnabled ?? false}
              onChange={(codemodeEnabled) => updateDraft({ codemodeEnabled })}
            />
          ) : null}
          {activeSection === "mcp" ? (
            <AgentMcpSettings
              agentId={agent.id}
              servers={draft.mcpServers ?? []}
              permissions={draft.permissions}
              onChange={(mcpServers) => updateDraft({ mcpServers })}
            />
          ) : null}
        </>
      ) : null}
    </SettingsLayout>
  );
}
