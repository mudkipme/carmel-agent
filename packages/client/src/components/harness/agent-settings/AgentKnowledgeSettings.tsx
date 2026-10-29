import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import type { KnowledgeSettings } from "@carmel-agent/shared";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel, FieldDescription, FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { showError } from "@/lib/errors";
import { useRemoteResource } from "@/hooks/use-remote-resource";
import { ResourceError, ResourceLoading } from "../ResourceFeedback";

export function AgentKnowledgeSettings({ agentId }: { agentId: string }) {
  const { i18n } = useLingui();
  const overview = useRemoteResource({
    key: `knowledge:${agentId}`,
    load: (signal) => api.knowledge(agentId, signal),
  });
  const [busy, setBusy] = useState(false);
  const save = async (settings: KnowledgeSettings) => {
    setBusy(true);
    try {
      await api.saveKnowledgeSettings(agentId, settings);
      await overview.refresh();
      toast.success(i18n._("Knowledge settings saved."));
    } catch (error) {
      showError(i18n._("Unable to save knowledge settings"), error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {overview.error ? <ResourceError error={overview.error} onRetry={overview.refresh} /> : null}
      {overview.loading ? <ResourceLoading label={i18n._("Loading knowledge settings")} /> : null}
      {overview.data ? (
        <KnowledgeSettingsForm
          key={agentId}
          agentId={agentId}
          initial={overview.data.settings}
          embeddingModel={overview.data.embeddingModel}
          busy={busy}
          onSave={(settings) => void save(settings)}
        />
      ) : null}
    </>
  );
}

function KnowledgeSettingsForm({
  agentId,
  initial,
  embeddingModel,
  busy,
  onSave,
}: {
  agentId: string;
  initial: KnowledgeSettings;
  embeddingModel: string;
  busy: boolean;
  onSave: (value: KnowledgeSettings) => void;
}) {
  const { i18n } = useLingui();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [acceleration, setAcceleration] = useState(initial.acceleration);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ enabled, acceleration });
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="knowledge-enabled">
            <Trans>Knowledge and memory</Trans>
          </FieldLabel>
          <Select
            value={enabled ? "on" : "off"}
            onValueChange={(value) => setEnabled(value === "on")}
          >
            <SelectTrigger id="knowledge-enabled">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="off">
                  <Trans>Off</Trans>
                </SelectItem>
                <SelectItem value="on">
                  <Trans>On</Trans>
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <FieldDescription>
            <Trans>
              Agents save memories only when asked. Existing memories are retained when switched
              off.
            </Trans>
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="knowledge-acceleration">
            <Trans>Acceleration</Trans>
          </FieldLabel>
          <Select
            value={acceleration}
            onValueChange={(value) => setAcceleration(value as typeof acceleration)}
          >
            <SelectTrigger id="knowledge-acceleration">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {["auto", "cpu", "vulkan", "cuda"].map((value) => (
                  <SelectItem key={value} value={value}>
                    {value === "auto" ? i18n._("Automatic") : value.toUpperCase()}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <FieldDescription>
            <Trans>
              Uses GPUs exposed to the runner. Vulkan works with compatible NVIDIA and AMD drivers.
            </Trans>
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="knowledge-model">
            <Trans>Embedding model</Trans>
          </FieldLabel>
          <Input id="knowledge-model" value={embeddingModel} readOnly />
          <FieldDescription>
            <Trans>Shared by all agents. The server administrator configures this model.</Trans>
          </FieldDescription>
        </Field>
      </FieldGroup>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} type="submit">
          {busy ? i18n._("Saving…") : i18n._("Save settings")}
        </Button>
        <Button asChild variant="outline">
          <Link to={`/agents/${agentId}/knowledge`}>
            <Trans>Open knowledge</Trans>
          </Link>
        </Button>
      </div>
    </form>
  );
}
