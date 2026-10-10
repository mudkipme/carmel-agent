import { ExternalLinkIcon, Trash2Icon } from "lucide-react";
import { SectionHeader } from "@/components/harness/form-primitives";
import { Field, FieldLabel } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useProviderConfigEditor } from "@/hooks/use-provider-config-editor";
import type { ModelRef, OAuthProviderSummary, ProviderConfig } from "@carmel-agent/shared";

export function ProviderSettings({
  providerConfigs,
  modelRefs,
  oauthProviders,
}: {
  providerConfigs: ProviderConfig[];
  modelRefs: ModelRef[];
  oauthProviders: OAuthProviderSummary[];
}) {
  const editor = useProviderConfigEditor(providerConfigs, modelRefs, oauthProviders);
  const {
    providers,
    selectedConfigId,
    selectedConfig,
    provider,
    authType,
    setAuthType,
    label,
    setLabel,
    baseUrl,
    setBaseUrl,
    apiKey,
    setApiKey,
    saved,
    oauthProvider,
    oauth,
  } = editor;

  return (
    <div className="grid gap-6">
      <section className="grid gap-4">
        <SectionHeader title="Provider Configs" />
        <div className="grid gap-2">
          {providerConfigs.map((item) => {
            const relatedModels = modelRefs.filter((model) => model.providerConfigId === item.id);
            return (
              <div key={item.id} className="rounded-md border bg-card p-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium">{item.label}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Badge variant="secondary">{item.provider}</Badge>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      title="Delete provider config"
                      onClick={() => void editor.remove(item)}
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {item.baseUrl ?? "default endpoint"} ·{" "}
                  {item.authType === "oauth"
                    ? item.hasOAuth
                      ? "oauth connected"
                      : "oauth not connected"
                    : item.hasApiKey
                      ? "key saved"
                      : "no key"}{" "}
                  · {relatedModels.length} models
                </p>
              </div>
            );
          })}
        </div>
      </section>

      <section className="grid gap-3 border-t pt-6">
        <Field>
          <FieldLabel>Provider config</FieldLabel>
          <Select value={selectedConfigId} onValueChange={editor.selectConfig}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="new">New provider config</SelectItem>
                {providerConfigs.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel>Provider type</FieldLabel>
          <Select value={provider} onValueChange={editor.selectProvider}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {providers.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel>Label</FieldLabel>
          <Input
            value={label}
            placeholder="Provider label"
            onChange={(event) => setLabel(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel>Base URL</FieldLabel>
          <Input
            value={baseUrl}
            placeholder="Optional API base URL"
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel>Authentication</FieldLabel>
          <Select
            value={authType}
            onValueChange={(value) => setAuthType(value as "api_key" | "oauth")}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="api_key">API key</SelectItem>
                {oauthProvider ? <SelectItem value="oauth">OAuth login</SelectItem> : null}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        {authType === "api_key" ? (
          <Field>
            <FieldLabel>API key</FieldLabel>
            <Input
              value={apiKey}
              type="password"
              placeholder="API key"
              onChange={(event) => setApiKey(event.target.value)}
            />
          </Field>
        ) : (
          <div className="grid gap-3 rounded-md border p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium">{oauthProvider?.name ?? provider}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {selectedConfig?.hasOAuth ? "Connected" : "Not connected"}
                </div>
              </div>
              <Button
                type="button"
                variant="secondary"
                onClick={() => void oauth.start()}
                disabled={!selectedConfig}
              >
                Login
              </Button>
            </div>
            {oauth.flow?.auth ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => window.open(oauth.flow?.auth?.url, "_blank", "noopener,noreferrer")}
              >
                <ExternalLinkIcon data-icon="inline-start" />
                Open login page
              </Button>
            ) : null}
            {oauth.flow?.auth?.instructions ? (
              <p className="text-xs text-muted-foreground">{oauth.flow.auth.instructions}</p>
            ) : null}
            {oauth.flow?.progress ? (
              <p className="text-xs text-muted-foreground">{oauth.flow.progress}</p>
            ) : null}
            {oauth.flow?.prompt ? (
              <div className="grid gap-2">
                <p className="text-xs text-muted-foreground">{oauth.flow.prompt.message}</p>
                {oauth.flow.prompt.kind === "select" ? (
                  <Select value={oauth.input} onValueChange={oauth.setInput}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {oauth.flow.prompt.options?.map((option) => (
                          <SelectItem key={option.id} value={option.id}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    value={oauth.input}
                    placeholder={oauth.flow.prompt.placeholder}
                    onChange={(event) => oauth.setInput(event.target.value)}
                  />
                )}
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void oauth.submit()}
                  disabled={!oauth.flow.prompt.allowEmpty && !oauth.input}
                >
                  Continue
                </Button>
              </div>
            ) : null}
            {oauth.flow?.status === "success" ? (
              <p className="text-xs text-muted-foreground">OAuth login completed.</p>
            ) : null}
            {oauth.flow?.error ? (
              <p className="text-xs text-destructive">{oauth.flow.error}</p>
            ) : null}
            {!selectedConfig ? (
              <p className="text-xs text-muted-foreground">
                Create the provider before logging in.
              </p>
            ) : null}
          </div>
        )}
        <Button onClick={() => void editor.save()}>
          {saved ? "Saved" : selectedConfig ? "Update provider" : "Create provider"}
        </Button>
      </section>
    </div>
  );
}
