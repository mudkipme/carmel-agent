import { useCallback, useEffect, useState } from "react";
import { KeyRoundIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { agentSecretNameError, type AgentSecret } from "@carmel-agent/shared";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SectionHeader } from "@/components/harness/form-primitives";
import { confirmAction } from "@/lib/action-dialogs";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";

/**
 * Environment variables for this agent's sandboxed shell.
 *
 * Like tasks, secrets are their own resource rather than fields of the agent
 * draft, so they save immediately instead of waiting for the page's Save --
 * which is also what keeps them out of the agent payload the browser holds.
 * Values are write-only: the server never sends one back, so a stored secret
 * can be replaced here but never read.
 */
export function AgentSecretsSettings({ agentId, shared }: { agentId: string; shared: boolean }) {
  const [secrets, setSecrets] = useState<AgentSecret[] | undefined>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<{ name: string; value: string }>();

  const reload = useCallback(async () => {
    try {
      setSecrets(await api.listAgentSecrets(agentId));
      setError(undefined);
    } catch (loadError) {
      setError(errorMessage(loadError, "Unable to load secrets"));
    }
  }, [agentId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const act = async (action: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    try {
      await action();
      setError(undefined);
      await reload();
      return true;
    } catch (actionError) {
      setError(errorMessage(actionError, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveDraft = async () => {
    if (!draft) return;
    const name = draft.name.trim();
    const nameError = agentSecretNameError(name);
    if (nameError) {
      setError(nameError);
      return;
    }
    if (!draft.value) {
      setError("A secret value is required.");
      return;
    }
    const replacing = secrets?.some((secret) => secret.name === name);
    if (replacing) {
      const confirmed = await confirmAction({
        title: `Replace ${name}?`,
        description: "The current value is overwritten and cannot be recovered.",
        actionLabel: "Replace secret",
      });
      if (!confirmed) return;
    }
    if (
      await act(() => api.writeAgentSecret(agentId, name, draft.value), "Unable to save secret")
    ) {
      setDraft(undefined);
    }
  };

  const removeSecret = async (name: string) => {
    const confirmed = await confirmAction({
      title: `Delete ${name}?`,
      description: "Commands this agent runs will no longer see this variable.",
      actionLabel: "Delete secret",
    });
    if (!confirmed) return;
    await act(() => api.deleteAgentSecret(agentId, name), "Unable to delete secret");
  };

  return (
    <section className="grid gap-4">
      <SectionHeader
        title="Secrets"
        description="Exported as environment variables into this agent's sandboxed shell, and nowhere else. Values are write-only — once saved, they can be replaced but not read back."
      />

      {shared ? (
        <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
          This agent is shared. Anyone who can run it runs commands with these secrets in their
          environment.
        </p>
      ) : null}

      {secrets === undefined ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : secrets.length === 0 ? (
        <p className="text-sm text-muted-foreground">No secrets yet.</p>
      ) : (
        <ul className="grid gap-2">
          {secrets.map((secret) => (
            <li
              key={secret.name}
              className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
            >
              <div className="flex min-w-0 items-center gap-2">
                <KeyRoundIcon className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="truncate font-mono text-sm">{secret.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    Set {new Date(secret.updatedAt).toLocaleString()}
                  </p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                title="Delete secret"
                onClick={() => void removeSecret(secret.name)}
              >
                <Trash2Icon data-icon="inline-start" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {draft ? (
        <div className="grid gap-3 rounded-md border p-3">
          <Field>
            <FieldLabel htmlFor="agent-secret-name">Name</FieldLabel>
            <Input
              id="agent-secret-name"
              autoFocus
              className="font-mono"
              placeholder="GITHUB_TOKEN"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="agent-secret-value">Value</FieldLabel>
            <Input
              id="agent-secret-value"
              type="password"
              autoComplete="off"
              value={draft.value}
              onChange={(event) => setDraft({ ...draft, value: event.target.value })}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDraft(undefined)}>
              Cancel
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void saveDraft()}>
              Save secret
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => setDraft({ name: "", value: "" })}
          >
            <PlusIcon data-icon="inline-start" />
            Add secret
          </Button>
        </div>
      )}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </section>
  );
}
