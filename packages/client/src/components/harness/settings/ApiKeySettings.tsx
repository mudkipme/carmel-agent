import { useCallback, useEffect, useState } from "react";
import { CheckIcon, CopyIcon, KeySquareIcon, PlusIcon, Trash2Icon } from "lucide-react";
import type { ApiKey, ApiKeyCreated } from "@carmel-agent/shared";
import { SectionHeader } from "@/components/harness/form-primitives";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { confirmAction } from "@/lib/action-dialogs";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";

/**
 * Keys for the OpenAI-compatible `/v1` endpoint. A key is shown once, right
 * after it is created: the server keeps only a hash, so a lost key is revoked
 * and replaced, never recovered.
 */
export function ApiKeySettings() {
  const [keys, setKeys] = useState<ApiKey[] | undefined>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [draftName, setDraftName] = useState<string>();
  const [created, setCreated] = useState<ApiKeyCreated>();
  const baseUrl = `${window.location.origin}/v1`;

  const reload = useCallback(async () => {
    try {
      setKeys(await api.listApiKeys());
      setError(undefined);
    } catch (loadError) {
      setError(errorMessage(loadError, "Unable to load API keys"));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const createKey = async () => {
    const name = draftName?.trim();
    if (!name) {
      setError("A name is required.");
      return;
    }
    setBusy(true);
    try {
      setCreated(await api.createApiKey(name));
      setDraftName(undefined);
      await reload();
    } catch (createError) {
      setError(errorMessage(createError, "Unable to create API key"));
    } finally {
      setBusy(false);
    }
  };

  const revokeKey = async (key: ApiKey) => {
    const confirmed = await confirmAction({
      title: `Revoke ${key.name}?`,
      description: "Anything using this key stops working immediately.",
      actionLabel: "Revoke key",
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      await api.deleteApiKey(key.id);
      if (created?.id === key.id) setCreated(undefined);
      await reload();
    } catch (deleteError) {
      setError(errorMessage(deleteError, "Unable to revoke API key"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="grid gap-4">
      <SectionHeader
        title="API Keys"
        description="Use your models from any OpenAI-compatible client. Requests reach the models you can use here, with their provider credentials; tool calls are returned to your client to run."
      />

      <div className="grid gap-1 rounded-md border px-3 py-2 text-sm">
        <span className="text-muted-foreground">Base URL</span>
        <CopyableValue value={baseUrl} />
      </div>

      {created ? (
        <div className="grid gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-sm">
          <p className="font-medium">Copy your new key now — it will not be shown again.</p>
          <CopyableValue value={created.key} />
          <div className="flex justify-end">
            <Button variant="ghost" size="sm" onClick={() => setCreated(undefined)}>
              Done
            </Button>
          </div>
        </div>
      ) : null}

      {keys === undefined ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : keys.length === 0 ? (
        <p className="text-sm text-muted-foreground">No API keys yet.</p>
      ) : (
        <ul className="grid gap-2">
          {keys.map((key) => (
            <li key={key.id} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <KeySquareIcon className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="truncate text-sm">
                    {key.name} <span className="font-mono text-muted-foreground">{key.prefix}…</span>
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    Created {new Date(key.createdAt).toLocaleString()} ·{" "}
                    {key.lastUsedAt ? `last used ${new Date(key.lastUsedAt).toLocaleString()}` : "never used"}
                  </p>
                </div>
              </div>
              <Button variant="ghost" size="sm" disabled={busy} title="Revoke key" onClick={() => void revokeKey(key)}>
                <Trash2Icon data-icon="inline-start" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {draftName !== undefined ? (
        <div className="grid gap-3 rounded-md border p-3">
          <Field>
            <FieldLabel htmlFor="api-key-name">Name</FieldLabel>
            <Input
              id="api-key-name"
              autoFocus
              placeholder="Laptop editor"
              maxLength={100}
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void createKey();
              }}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDraftName(undefined)}>
              Cancel
            </Button>
            <Button size="sm" disabled={busy || !draftName.trim()} onClick={() => void createKey()}>
              Create key
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => setDraftName("")}>
            <PlusIcon data-icon="inline-start" />
            Create key
          </Button>
        </div>
      )}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </section>
  );
}

function CopyableValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access needs a secure context; the value is selectable anyway.
    }
  };
  return (
    <div className="flex min-w-0 items-center gap-2">
      <code className="min-w-0 flex-1 truncate font-mono text-sm select-all">{value}</code>
      <Button variant="ghost" size="icon-sm" title="Copy" onClick={() => void copy()}>
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  );
}
