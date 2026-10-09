import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import type { KnowledgeSettings } from "@carmel-agent/shared";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
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
      toast.success("Knowledge settings saved.");
    } catch (error) {
      showError("Unable to save knowledge settings", error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {overview.error ? <ResourceError error={overview.error} onRetry={overview.refresh} /> : null}
      {overview.loading ? <ResourceLoading label="Loading knowledge settings" /> : null}
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
  const [enabled, setEnabled] = useState(initial.enabled);
  const [acceleration, setAcceleration] = useState(initial.acceleration);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ enabled, acceleration });
      }}
    >
      <Card>
        <CardHeader>
          <CardTitle>Knowledge settings</CardTitle>
          <CardDescription>
            Memory is shared by all users of this agent. Conversations remain separate.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="knowledge-enabled">Knowledge and memory</FieldLabel>
              <Select
                value={enabled ? "on" : "off"}
                onValueChange={(value) => setEnabled(value === "on")}
              >
                <SelectTrigger id="knowledge-enabled">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="off">Off</SelectItem>
                    <SelectItem value="on">On</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>
                Agents save memories only when asked. Existing memories are retained when switched
                off.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="knowledge-acceleration">Acceleration</FieldLabel>
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
                        {value === "auto" ? "Automatic" : value.toUpperCase()}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>
                Uses GPUs exposed to the runner. Vulkan works with compatible NVIDIA and AMD
                drivers.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="knowledge-model">Embedding model</FieldLabel>
              <Input id="knowledge-model" value={embeddingModel} readOnly />
              <FieldDescription>
                Shared by all agents. The server administrator configures this model.
              </FieldDescription>
            </Field>
          </FieldGroup>
        </CardContent>
        <CardFooter className="flex-wrap gap-2">
          <Button disabled={busy} type="submit">
            {busy ? "Saving…" : "Save settings"}
          </Button>
          <Button asChild variant="outline">
            <Link to={`/agents/${agentId}/knowledge`}>Open knowledge</Link>
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}
