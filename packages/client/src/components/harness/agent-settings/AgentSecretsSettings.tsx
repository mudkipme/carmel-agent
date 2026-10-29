import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { useCallback, useEffect, useState } from "react";
import { FileInputIcon, KeyRoundIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { agentSecretNameError, type AgentSecret } from "@carmel-agent/shared";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
  const { i18n } = useLingui();
  const [secrets, setSecrets] = useState<AgentSecret[] | undefined>();
  const [canImportEnv, setCanImportEnv] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<{ name: string; value: string }>();

  const reload = useCallback(async () => {
    try {
      const [secrets, dotEnv] = await Promise.all([
        api.listAgentSecrets(agentId),
        api.agentWorkspaceDotEnvStatus(agentId),
      ]);
      setSecrets(secrets);
      setCanImportEnv(dotEnv.available);
      setError(undefined);
    } catch (loadError) {
      setError(errorMessage(loadError, i18n._("Unable to load secrets")));
    }
  }, [agentId, i18n]);

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
      setError(i18n._("A secret value is required."));
      return;
    }
    const replacing = secrets?.some((secret) => secret.name === name);
    if (replacing) {
      const confirmed = await confirmAction({
        title: i18n._("Replace {name}?", { name: name }),
        description: i18n._("The current value is overwritten and cannot be recovered."),
        actionLabel: i18n._("Replace secret"),
      });
      if (!confirmed) return;
    }
    if (
      await act(
        () => api.writeAgentSecret(agentId, name, draft.value),
        i18n._("Unable to save secret"),
      )
    ) {
      setDraft(undefined);
    }
  };

  const removeSecret = async (name: string) => {
    const confirmed = await confirmAction({
      title: i18n._("Delete {name}?", { name: name }),
      description: i18n._("Commands this agent runs will no longer see this variable."),
      actionLabel: i18n._("Delete secret"),
    });
    if (!confirmed) return;
    await act(() => api.deleteAgentSecret(agentId, name), i18n._("Unable to delete secret"));
  };

  const importEnv = async () => {
    let result: Awaited<ReturnType<typeof api.importAgentWorkspaceDotEnv>> | undefined;
    if (
      await act(async () => {
        result = await api.importAgentWorkspaceDotEnv(agentId);
      }, i18n._("Unable to import .env"))
    ) {
      toast.success(
        i18n._(
          "{count, plural, one {Imported # secret from .env} other {Imported # secrets from .env}}",
          { count: result!.imported },
        ),
        {
          description:
            [
              result!.skippedExisting &&
                i18n._("{skippedExisting} already stored", {
                  skippedExisting: result!.skippedExisting,
                }),
              result!.skippedInvalid &&
                i18n._("{skippedInvalid} invalid or empty", {
                  skippedInvalid: result!.skippedInvalid,
                }),
            ]
              .filter(Boolean)
              .join(" · ") || undefined,
        },
      );
    }
  };

  return (
    <section className="grid gap-4">
      <p className="text-sm text-muted-foreground">
        <Trans>
          Secrets become environment variables in this agent's shell. Saved values can be replaced
          but cannot be viewed.
        </Trans>
      </p>

      {shared ? (
        <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
          <Trans>
            This agent is shared. Anyone who can run it runs commands with these secrets in their
            environment.
          </Trans>
        </p>
      ) : null}

      {secrets === undefined ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Loading…</Trans>
        </p>
      ) : secrets.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <Trans>No secrets yet.</Trans>
        </p>
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
                    <Trans>Set {new Date(secret.updatedAt).toLocaleString(i18n.locale)}</Trans>
                  </p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                title={i18n._("Delete secret")}
                onClick={() => void removeSecret(secret.name)}
              >
                <Trash2Icon data-icon="inline-start" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {draft ? (
        <FieldGroup className="gap-3 rounded-md border p-3">
          <Field>
            <FieldLabel htmlFor="agent-secret-name">
              <Trans>Name</Trans>
            </FieldLabel>
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
            <FieldLabel htmlFor="agent-secret-value">
              <Trans>Value</Trans>
            </FieldLabel>
            <Textarea
              id="agent-secret-value"
              className="max-h-48 font-mono"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              maxLength={8192}
              value={draft.value}
              onChange={(event) => setDraft({ ...draft, value: event.target.value })}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDraft(undefined)}>
              <Trans>Cancel</Trans>
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void saveDraft()}>
              <Trans>Save secret</Trans>
            </Button>
          </div>
        </FieldGroup>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => setDraft({ name: "", value: "" })}
          >
            <PlusIcon data-icon="inline-start" />
            <Trans>Add secret</Trans>
          </Button>
          {canImportEnv ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void importEnv()}>
              <FileInputIcon data-icon="inline-start" />
              <Trans>Import .env</Trans>
            </Button>
          ) : null}
        </div>
      )}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </section>
  );
}
