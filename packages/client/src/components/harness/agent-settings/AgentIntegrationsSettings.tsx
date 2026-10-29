import { statusLabel } from "@/lib/labels";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { CopyIcon, ExternalLinkIcon } from "lucide-react";
import type { ImDelivery, ImIntegration, ImPlatform, ImSetup } from "@carmel-agent/shared";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SectionHeader } from "@/components/harness/form-primitives";
import { ResourceError, ResourceLoading } from "@/components/harness/ResourceFeedback";
import { useRemoteResource } from "@/hooks/use-remote-resource";
import { api } from "@/lib/api";
import { confirmAction } from "@/lib/action-dialogs";
import { errorMessage, showError } from "@/lib/errors";

const names: Record<ImPlatform, string> = {
  telegram: "Telegram",
  feishu: /*i18n*/ "Feishu",
  lark: "Lark",
};

export function AgentIntegrationsSettings({ agentId }: { agentId: string }) {
  const { i18n } = useLingui();
  const resource = useRemoteResource({
    key: `im-integrations:${agentId}`,
    load: async (signal) => {
      const [integrations, setups, deliveries] = await Promise.all([
        api.listImIntegrations(agentId, signal),
        api.listImSetups(agentId, signal),
        api.listImDeliveries(agentId, signal),
      ]);
      return { integrations, setups, deliveries };
    },
    pollInterval: (data) =>
      data?.setups.some((setup) => ["authorizing", "pairing"].includes(setup.status))
        ? 2000
        : 10_000,
  });
  const data = resource.data;
  return (
    <section className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        <Trans>
          Connections belong to you, including on shared agents. Use a dedicated bot for each.
        </Trans>
      </p>
      {resource.error ? (
        <ResourceError
          error={resource.error}
          title={i18n._("Unable to load integrations")}
          onRetry={resource.refresh}
        />
      ) : null}
      {resource.loading ? (
        <ResourceLoading label={i18n._("Loading integrations")} />
      ) : data ? (
        <>
          {(["telegram", "feishu", "lark"] as const).map((platform) => (
            <PlatformSettings
              key={platform}
              agentId={agentId}
              platform={platform}
              integration={data.integrations.find((item) => item.platform === platform)}
              setup={data.setups.find((item) => item.platform === platform)}
              onChange={resource.refresh}
            />
          ))}
          {data.deliveries.length ? <DeliveryHistory deliveries={data.deliveries} /> : null}
        </>
      ) : null}
    </section>
  );
}
function PlatformSettings({
  agentId,
  platform,
  integration,
  setup,
  onChange,
}: {
  agentId: string;
  platform: ImPlatform;
  integration?: ImIntegration;
  setup?: ImSetup;
  onChange: () => Promise<unknown>;
}) {
  const { i18n } = useLingui();
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState("");
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pending = setup && ["authorizing", "pairing"].includes(setup.status);
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      await onChange();
      return true;
    } catch (error) {
      setError(errorMessage(error, i18n._("Unable to update integration")));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const connect = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (
      await act(() =>
        api.connectIm(
          agentId,
          platform === "telegram" ? { platform, token } : { platform, appId, appSecret },
        ),
      )
    ) {
      setToken("");
      setAppSecret("");
      setAppId("");
      setEditing(false);
    }
  };
  const disconnect = async () => {
    if (
      !integration ||
      !(await confirmAction({
        title: i18n._("Disconnect {value}?", { value: i18n._(names[platform]) }),
        description: i18n._(
          "Removes this connection and its credentials. Your Carmel conversations are kept.",
        ),
        actionLabel: i18n._("Disconnect"),
      }))
    )
      return;
    await act(() => api.disconnectIm(agentId, integration.id));
  };
  return (
    <section
      aria-label={i18n._("{platform} integration", { platform: i18n._(names[platform]) })}
      className="flex flex-col gap-4 border-b pb-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{i18n._(names[platform])}</h3>
        <Badge variant={integration?.status === "error" ? "destructive" : "secondary"}>
          {integration ? statusLabel(integration.status) : i18n._("Not connected")}
        </Badge>
      </div>
      {integration ? (
        <>
          <p className="break-words text-sm text-muted-foreground">
            <Trans>
              {integration.botName} · Paired account {integration.senderId}
            </Trans>
          </p>
          {integration.error ? (
            <Alert variant="destructive">
              <AlertTitle>
                <Trans>Connection needs attention</Trans>
              </AlertTitle>
              <AlertDescription>{integration.error}</AlertDescription>
            </Alert>
          ) : null}
          <FieldGroup>
            <Field orientation="horizontal">
              <Switch
                id={`${platform}-enabled`}
                checked={integration.enabled}
                disabled={busy}
                onCheckedChange={(enabled) =>
                  void act(() => api.updateIm(agentId, integration.id, { enabled }))
                }
              />
              <FieldLabel htmlFor={`${platform}-enabled`}>
                <Trans>Receive and send messages</Trans>
              </FieldLabel>
            </Field>
            <Field orientation="horizontal">
              <Switch
                id={`${platform}-proactive`}
                checked={integration.proactive}
                disabled={busy}
                onCheckedChange={(proactive) =>
                  void act(() => api.updateIm(agentId, integration.id, { proactive }))
                }
              />
              <FieldLabel htmlFor={`${platform}-proactive`}>
                <Trans>Allow proactive messages, including scheduled task alerts</Trans>
              </FieldLabel>
            </Field>
            <Field orientation="horizontal">
              <Switch
                id={`${platform}-default`}
                checked={integration.notificationDefault}
                disabled={busy || !integration.enabled || !integration.proactive}
                onCheckedChange={(notificationDefault) =>
                  void act(() => api.updateIm(agentId, integration.id, { notificationDefault }))
                }
              />
              <FieldLabel htmlFor={`${platform}-default`}>
                <Trans>Default notification destination</Trans>
              </FieldLabel>
            </Field>
          </FieldGroup>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy || Boolean(pending)}
              onClick={() => setEditing(!editing)}
            >
              <Trans>Replace credentials</Trans>
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void act(() => api.updateIm(agentId, integration.id, { enabled: true }))
              }
            >
              <Trans>Reconnect</Trans>
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void disconnect()}>
              <Trans>Disconnect</Trans>
            </Button>
            {integration.sessionId ? (
              <Button asChild variant="ghost" size="sm">
                <Link to={`/agents/${agentId}/sessions/${integration.sessionId}`}>
                  <Trans>Open conversation</Trans>
                </Link>
              </Button>
            ) : null}
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          {platform === "telegram"
            ? i18n._("Create a dedicated bot with BotFather, then connect its token.")
            : i18n._("Scan a QR code to create and authorize a bot, or connect an existing app.")}
        </p>
      )}
      {setup ? <SetupProgress agentId={agentId} setup={setup} busy={busy} act={act} /> : null}
      {!pending && !editing && !integration ? (
        <div className="flex flex-wrap gap-2">
          {platform !== "telegram" ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void act(() => api.beginImQr(agentId, platform))}
            >
              <Trans>Scan QR code</Trans>
            </Button>
          ) : null}
          <Button
            variant={platform === "telegram" ? "default" : "outline"}
            size="sm"
            disabled={busy}
            onClick={() => setEditing(true)}
          >
            {platform === "telegram" ? i18n._("Connect Telegram") : i18n._("Use existing app")}
          </Button>
        </div>
      ) : null}
      {editing && !pending ? (
        <form onSubmit={(event) => void connect(event)} className="flex flex-col gap-3">
          <FieldGroup>
            {platform === "telegram" ? (
              <Field>
                <FieldLabel htmlFor={`${platform}-token`}>
                  <Trans>Bot token</Trans>
                </FieldLabel>
                <Input
                  id={`${platform}-token`}
                  required
                  type="password"
                  autoComplete="new-password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                />
                <FieldDescription>
                  <Trans>
                    Get this from @BotFather. Carmel stores it encrypted and never shows it again.
                  </Trans>
                </FieldDescription>
              </Field>
            ) : (
              <>
                <Field>
                  <FieldLabel htmlFor={`${platform}-app-id`}>
                    <Trans>App ID</Trans>
                  </FieldLabel>
                  <Input
                    id={`${platform}-app-id`}
                    required
                    value={appId}
                    onChange={(event) => setAppId(event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${platform}-app-secret`}>
                    <Trans>App Secret</Trans>
                  </FieldLabel>
                  <Input
                    id={`${platform}-app-secret`}
                    required
                    type="password"
                    autoComplete="new-password"
                    value={appSecret}
                    onChange={(event) => setAppSecret(event.target.value)}
                  />
                  <FieldDescription>
                    <Trans>
                      Enable the bot, publish the app, and subscribe to message events using a long
                      connection.
                    </Trans>
                  </FieldDescription>
                </Field>
              </>
            )}
          </FieldGroup>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? i18n._("Connecting…") : i18n._("Connect")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setToken("");
                setAppSecret("");
              }}
            >
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </form>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>
            <Trans>Unable to update integration</Trans>
          </AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}
function SetupProgress({
  agentId,
  setup,
  busy,
  act,
}: {
  agentId: string;
  setup: ImSetup;
  busy: boolean;
  act: (action: () => Promise<unknown>) => Promise<boolean>;
}) {
  const { i18n } = useLingui();
  const pending = ["authorizing", "pairing"].includes(setup.status);
  return (
    <div className="flex flex-col gap-3">
      {setup.status === "authorizing" ? (
        <>
          <p className="text-sm">
            <Trans>Scan with the Feishu or Lark mobile app and approve creation of your bot.</Trans>
          </p>
          {setup.qrDataUrl ? (
            <img
              src={setup.qrDataUrl}
              alt={i18n._("Scan to create your Feishu or Lark bot")}
              className="size-56 max-w-full self-start rounded-md"
            />
          ) : null}
          {setup.verificationUrl ? (
            <Button asChild variant="outline" size="sm">
              <a href={setup.verificationUrl} target="_blank" rel="noreferrer">
                <Trans>Open authorization link</Trans>
                <ExternalLinkIcon data-icon="inline-end" />
              </a>
            </Button>
          ) : null}
        </>
      ) : setup.status === "pairing" ? (
        <>
          <p className="text-sm">
            <Trans>
              Finish connecting {setup.botName}: open the bot and send the command below from your
              private account.
            </Trans>
          </p>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${setup.id}-pair`}>
                <Trans>Pairing command</Trans>
              </FieldLabel>
              <Input
                id={`${setup.id}-pair`}
                value={setup.pairCommand ?? ""}
                readOnly
                className="font-mono"
              />
            </Field>
          </FieldGroup>
          <div className="flex flex-wrap gap-2">
            {setup.botUrl ? (
              <Button asChild size="sm">
                <a href={setup.botUrl} target="_blank" rel="noreferrer">
                  <Trans>Open bot</Trans>
                  <ExternalLinkIcon data-icon="inline-end" />
                </a>
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void navigator.clipboard
                  .writeText(setup.pairCommand ?? "")
                  .catch((error) => showError(i18n._("Unable to copy command"), error))
              }
            >
              <CopyIcon data-icon="inline-start" />
              <Trans>Copy command</Trans>
            </Button>
          </div>
        </>
      ) : (
        <Alert>
          <AlertTitle>
            {setup.status === "expired"
              ? i18n._("Setup expired")
              : setup.status === "denied"
                ? i18n._("Authorization declined")
                : i18n._("Setup needs attention")}
          </AlertTitle>
          <AlertDescription>
            {setup.error ?? i18n._("Start again when you are ready.")}
          </AlertDescription>
        </Alert>
      )}
      {pending ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            <Trans>Expires {new Date(setup.expiresAt).toLocaleTimeString(i18n.locale)}</Trans>
          </p>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void act(() => api.cancelImSetup(agentId, setup.id))}
          >
            <Trans>Cancel setup</Trans>
          </Button>
        </div>
      ) : null}
      {pending && setup.error ? (
        <Alert variant="destructive">
          <AlertTitle>
            <Trans>Check bot configuration</Trans>
          </AlertTitle>
          <AlertDescription>{setup.error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
function DeliveryHistory({ deliveries }: { deliveries: ImDelivery[] }) {
  const { i18n } = useLingui();
  return (
    <section className="flex flex-col gap-3">
      <SectionHeader
        title={i18n._("Recent deliveries")}
        description={i18n._(
          "Task execution and notification delivery are tracked separately. An uncertain delivery may already be in your chat; check before resending.",
        )}
      />
      <ul className="flex flex-col gap-2">
        {deliveries.slice(0, 10).map((delivery) => (
          <li
            key={delivery.id}
            className="flex flex-wrap items-start justify-between gap-2 text-sm"
          >
            <div>
              <p>
                {i18n._(names[delivery.platform])} ·{" "}
                {new Date(delivery.createdAt).toLocaleString(i18n.locale)}
              </p>
              {delivery.error ? (
                <p className="break-words text-muted-foreground">{delivery.error}</p>
              ) : null}
            </div>
            <Badge
              variant={
                delivery.status === "failed" || delivery.status === "uncertain"
                  ? "destructive"
                  : "secondary"
              }
            >
              {statusLabel(delivery.status)}
            </Badge>
          </li>
        ))}
      </ul>
    </section>
  );
}
