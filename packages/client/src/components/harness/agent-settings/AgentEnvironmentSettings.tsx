import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { useEffect, useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PlusIcon, Trash2Icon } from "lucide-react";
import type {
  AgentConfig,
  AgentMount,
  Environment,
  EnvironmentCommand,
} from "@carmel-agent/shared";
import { SectionHeader, ToggleRow } from "@/components/harness/form-primitives";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRemoteResource } from "@/hooks/use-remote-resource";
import { confirmAction } from "@/lib/action-dialogs";
import { api } from "@/lib/api";
import { errorMessage, showError } from "@/lib/errors";
import { useHarnessStore } from "@/store/harness-store";
import { EnvironmentSecretsSettings } from "./EnvironmentSecretsSettings";

const newEnvironment = "__new__";

/**
 * Where the agent runs: its workspace, runner, network, and secrets. Several
 * agents can share one, so this section saves on its own rather than with the
 * agent draft, and says who else a change reaches.
 */
export function AgentEnvironmentSettings({
  agent,
  canConfigureHostPaths,
  onMove,
}: {
  agent: AgentConfig;
  canConfigureHostPaths: boolean;
  onMove: (environmentId: string) => Promise<void>;
}) {
  const { i18n } = useLingui();
  const navigate = useNavigate();
  const activeUserId = useHarnessStore((state) => state.activeUserId);
  const agents = useHarnessStore((state) => state.agents);
  const modelRefs = useHarnessStore((state) => state.modelRefs);
  const createAgent = useHarnessStore((state) => state.createAgent);
  const environments = useRemoteResource({
    key: `environments:${activeUserId}`,
    load: (signal) => api.listEnvironments(signal),
    topics: ["workspace"],
  });
  const [moving, setMoving] = useState(false);
  const environment = environments.data?.find((item) => item.id === agent.environmentId);
  const others = environment?.agents.filter((item) => item.id !== agent.id) ?? [];
  const sharedWith = others.map((item) => item.name).join(", ");
  const shared = agents.some((item) => item.environmentId === agent.environmentId && item.shared);

  const move = async (target: string) => {
    if (target === agent.environmentId || !environment) return;
    const destination = environments.data?.find((item) => item.id === target);
    const confirmed = await confirmAction({
      title: destination
        ? i18n._("Move {agent} to {environment}?", {
            agent: agent.name,
            environment: destination.name,
          })
        : i18n._("Give {agent} a new environment?", { agent: agent.name }),
      description:
        others.length === 0
          ? i18n._(
              "No other agent uses {environment}, so it is deleted with its secrets. Its workspace files stay on the server.",
              { environment: environment.name },
            )
          : i18n._("Conversations keep their history, but files in this workspace stay here."),
      actionLabel: destination ? i18n._("Move agent") : i18n._("Create environment"),
    });
    if (!confirmed) return;
    setMoving(true);
    let created: Environment | undefined;
    try {
      if (!destination)
        created = await api.createEnvironment({
          name: agent.name,
          workingDirMode: "default",
          workingDir: "",
          mounts: [],
          network: false,
        });
      await onMove(created?.id ?? target);
      await environments.refresh();
    } catch (error) {
      if (created) await api.deleteEnvironment(created.id).catch(() => undefined);
      showError(i18n._("Unable to move agent"), error);
    } finally {
      setMoving(false);
    }
  };

  const createSibling = async () => {
    try {
      const sibling = await createAgent({
        name: i18n._("Agent {number}", { number: agents.length + 1 }),
        defaultModelRefId: agent.defaultModelRefId ?? modelRefs[0]?.id,
        environmentId: agent.environmentId,
      });
      navigate(`/agents/${sibling.id}/settings/general`);
    } catch (error) {
      showError(i18n._("Unable to create agent"), error);
    }
  };

  if (environments.error) return <p className="text-sm text-destructive">{environments.error}</p>;
  if (!environment)
    return (
      <p className="text-sm text-muted-foreground">
        <Trans>Loading environment...</Trans>
      </p>
    );

  return (
    <div className="grid gap-6">
      <section className="grid gap-3">
        <Field>
          <FieldLabel htmlFor="agent-environment">
            <Trans>Environment</Trans>
          </FieldLabel>
          <Select value={agent.environmentId} onValueChange={(value) => void move(value)}>
            <SelectTrigger id="agent-environment" className="w-full" disabled={moving}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {environments.data!.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectGroup>
              <SelectSeparator />
              <SelectGroup>
                <SelectItem value={newEnvironment}>
                  <Trans>New environment</Trans>
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        {others.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            <Trans>Shared with {sharedWith}. Changes here apply to them too.</Trans>
          </p>
        ) : null}
        <div>
          <Button variant="outline" size="sm" onClick={() => void createSibling()}>
            <PlusIcon data-icon="inline-start" />
            <Trans>New agent in this environment</Trans>
          </Button>
        </div>
      </section>

      <EnvironmentForm
        key={`${environment.id}:${environment.updatedAt}`}
        environment={environment}
        canConfigureHostPaths={canConfigureHostPaths}
        onSaved={() => void environments.refresh()}
      />

      <section className="grid gap-4 border-t pt-6">
        <SectionHeader title={i18n._("Secrets")} />
        <EnvironmentSecretsSettings
          key={environment.id}
          environmentId={environment.id}
          shared={shared}
        />
      </section>
    </div>
  );
}

function EnvironmentForm({
  environment,
  canConfigureHostPaths,
  onSaved,
}: {
  environment: Environment;
  canConfigureHostPaths: boolean;
  onSaved: () => void;
}) {
  const { i18n } = useLingui();
  const fieldId = useId();
  const initial: EnvironmentCommand = {
    name: environment.name,
    workingDirMode: environment.workingDirMode,
    workingDir: environment.workingDirMode === "manual" ? environment.workingDir : "",
    mounts: environment.mounts,
    network: environment.network,
  };
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);

  useEffect(() => {
    if (dirty) setMessage(undefined);
  }, [dirty]);

  const update = (patch: Partial<EnvironmentCommand>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const updateMount = (index: number, patch: Partial<AgentMount>) =>
    update({
      mounts: draft.mounts.map((mount, at) => (at === index ? { ...mount, ...patch } : mount)),
    });

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      await api.updateEnvironment(environment.id, draft);
      setMessage(i18n._("Environment saved."));
      onSaved();
    } catch (saveError) {
      setError(errorMessage(saveError, i18n._("Unable to save environment")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="grid gap-4 border-t pt-6">
      <FieldGroup className="gap-4">
        <Field>
          <FieldLabel htmlFor={`${fieldId}-name`}>
            <Trans>Name</Trans>
          </FieldLabel>
          <Input
            id={`${fieldId}-name`}
            value={draft.name}
            onChange={(event) => update({ name: event.target.value })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${fieldId}-working-dir-mode`}>
            <Trans>Working dir</Trans>
          </FieldLabel>
          <div className="grid gap-2">
            <Select
              value={draft.workingDirMode}
              onValueChange={(workingDirMode: EnvironmentCommand["workingDirMode"]) =>
                update({ workingDirMode })
              }
            >
              <SelectTrigger id={`${fieldId}-working-dir-mode`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="default">
                    <Trans>Default environment folder</Trans>
                  </SelectItem>
                  {canConfigureHostPaths ? (
                    <SelectItem value="manual">
                      <Trans>Manual server folder</Trans>
                    </SelectItem>
                  ) : null}
                </SelectGroup>
              </SelectContent>
            </Select>
            {canConfigureHostPaths && draft.workingDirMode === "manual" ? (
              <Input
                aria-label={i18n._("Manual server folder")}
                value={draft.workingDir}
                onChange={(event) => update({ workingDir: event.target.value })}
                placeholder="/path/on/server"
              />
            ) : null}
          </div>
        </Field>
        {canConfigureHostPaths ? (
          <FieldSet>
            <FieldLegend variant="label">
              <Trans>Extra runner mounts</Trans>
            </FieldLegend>
            <div className="grid gap-2">
              <p className="text-xs text-muted-foreground">
                <Trans>
                  Host directories mounted into the bash sandbox in addition to the workspace.
                  Source is a path on the host.
                </Trans>
              </p>
              {draft.mounts.map((mount, index) => (
                <FieldSet key={index} className="rounded-md border p-2">
                  <FieldLegend variant="label">
                    <Trans>Mount {index + 1}</Trans>
                  </FieldLegend>
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor={`${fieldId}-mount-${index}-source`}>
                        <Trans>Host path</Trans>
                      </FieldLabel>
                      <div className="flex items-center gap-2">
                        <Input
                          id={`${fieldId}-mount-${index}-source`}
                          value={mount.source}
                          onChange={(event) => updateMount(index, { source: event.target.value })}
                          placeholder="/host/path"
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() =>
                            update({ mounts: draft.mounts.filter((_, at) => at !== index) })
                          }
                          title={i18n._("Remove mount")}
                        >
                          <Trash2Icon className="size-4" />
                        </Button>
                      </div>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={`${fieldId}-mount-${index}-target`}>
                        <Trans>Container path</Trans>
                      </FieldLabel>
                      <Input
                        id={`${fieldId}-mount-${index}-target`}
                        value={mount.target ?? ""}
                        onChange={(event) => updateMount(index, { target: event.target.value })}
                        placeholder={i18n._("Container path (defaults to source)")}
                      />
                    </Field>
                    <ToggleRow
                      label={i18n._("Read only")}
                      checked={mount.readOnly ?? false}
                      onCheckedChange={(readOnly) => updateMount(index, { readOnly })}
                    />
                  </FieldGroup>
                </FieldSet>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  update({ mounts: [...draft.mounts, { source: "", target: "", readOnly: false }] })
                }
                className="justify-self-start"
              >
                <PlusIcon className="size-4" /> <Trans>Add mount</Trans>
              </Button>
            </div>
          </FieldSet>
        ) : null}
        <ToggleRow
          label={i18n._("Sandbox network access")}
          checked={draft.network}
          onCheckedChange={(network) => update({ network })}
        />
      </FieldGroup>
      <div className="flex flex-wrap items-center justify-end gap-3">
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
        <Button onClick={() => void save()} disabled={saving || !dirty}>
          {saving ? i18n._("Saving...") : i18n._("Save environment")}
        </Button>
      </div>
    </section>
  );
}
