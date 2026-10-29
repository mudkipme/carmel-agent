import { statusLabel } from "@/lib/labels";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import type { UserRequest, SessionSecret } from "@carmel-agent/shared";
import { KeyRoundIcon, MessageCircleQuestionIcon } from "lucide-react";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AgentRequestCard } from "./AgentRequestCard";
import { FieldGroup, Field, FieldLabel, FieldDescription } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export function UserRequestCards({
  requests,
  disabled,
  canManageAgentSecrets,
  sharedAgent,
  onChanged,
  onContinue,
}: {
  requests: UserRequest[];
  disabled: boolean;
  canManageAgentSecrets: boolean;
  sharedAgent: boolean;
  onChanged: () => Promise<void>;
  onContinue: () => Promise<unknown>;
}) {
  if (!requests.length) return null;
  return (
    <div className="flex flex-col gap-3">
      {requests.map((request) => (
        <UserRequestCard
          key={request.id}
          request={request}
          disabled={disabled}
          canManageAgentSecrets={canManageAgentSecrets}
          sharedAgent={sharedAgent}
          onChanged={onChanged}
          onContinue={onContinue}
        />
      ))}
    </div>
  );
}

function UserRequestCard({
  request,
  disabled,
  canManageAgentSecrets,
  sharedAgent,
  onChanged,
  onContinue,
}: {
  request: UserRequest;
  disabled: boolean;
  canManageAgentSecrets: boolean;
  sharedAgent: boolean;
  onChanged: () => Promise<void>;
  onContinue: () => Promise<unknown>;
}) {
  const { i18n } = useLingui();
  const [selected, setSelected] = useState<string[]>([]);
  const [text, setText] = useState("");
  // Component memory only: never shared with the composer, drafts, or client store.
  const [secretValue, setSecretValue] = useState("");
  const [existing, setExisting] = useState<SessionSecret>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pending = request.status === "pending";
  const locked = disabled || busy;
  const inputId = `request-${request.id}`;
  useEffect(() => {
    if (!pending) setSecretValue("");
    if (request.kind !== "secret" || !pending) return;
    let cancelled = false;
    void api
      .listSessionSecrets(request.sessionId)
      .then((secrets) => {
        if (!cancelled) setExisting(secrets.find((secret) => secret.name === request.secret?.name));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pending, request.kind, request.secret?.name, request.sessionId]);

  async function act(action: () => Promise<unknown>, resume = false) {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      setSecretValue("");
      await onChanged();
      if (resume) await onContinue();
    } catch (error) {
      setError(errorMessage(error, i18n._("Unable to respond to this request.")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AgentRequestCard
      label={
        request.kind === "secret"
          ? i18n._("Credential request: {value}", { value: request.secret?.name })
          : i18n._("Question from agent")
      }
      kind={request.kind}
      icon={
        request.kind === "secret" ? (
          <KeyRoundIcon aria-hidden="true" />
        ) : (
          <MessageCircleQuestionIcon aria-hidden="true" />
        )
      }
      title={request.kind === "secret" ? request.secret?.name : request.question?.question}
      status={
        pending
          ? i18n._("Waiting for you")
          : request.status === "answered"
            ? i18n._("Answered")
            : statusLabel(request.status)
      }
      description={
        request.kind === "secret"
          ? request.secret?.reason
          : pending
            ? i18n._("Choose an option or enter your answer.")
            : i18n._("Your response is saved with this conversation.")
      }
      actions={
        pending ? (
          <>
            <Button
              type="submit"
              form={inputId}
              size="sm"
              disabled={
                locked ||
                (request.kind === "secret" ? !secretValue : !selected.length && !text.trim())
              }
            >
              {request.kind === "secret" ? i18n._("Provide credential") : i18n._("Submit answer")}
            </Button>
            {existing ? (
              <Button
                variant="outline"
                size="sm"
                disabled={locked}
                onClick={() =>
                  void act(() => api.useRequestedSecret(request.sessionId, request.id), true)
                }
              >
                <Trans>Use saved credential</Trans>
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              disabled={locked}
              onClick={() =>
                void act(() => api.cancelUserRequest(request.sessionId, request.id), true)
              }
            >
              <Trans>Decline</Trans>
            </Button>
          </>
        ) : (
          <>
            {request.delivery === "pending" ? (
              <Button size="sm" disabled={locked} onClick={() => void act(onContinue)}>
                <Trans>Resume agent</Trans>
              </Button>
            ) : null}
            {request.credential ? (
              <>
                {canManageAgentSecrets ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={locked}
                    onClick={() =>
                      void act(() =>
                        request.credential!.scope === "session"
                          ? api.promoteSessionSecret(request.sessionId, request.credential!.id)
                          : api.demoteAgentSecret(request.sessionId, request.credential!.id),
                      )
                    }
                  >
                    {request.credential.scope === "session"
                      ? i18n._("Save for this agent")
                      : i18n._("Use in this session only")}
                  </Button>
                ) : null}
                {request.credential.scope === "session" || canManageAgentSecrets ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={locked}
                    onClick={() =>
                      void act(() =>
                        api.revokeSessionSecret(request.sessionId, request.credential!.id),
                      )
                    }
                  >
                    <Trans>Revoke credential</Trans>
                  </Button>
                ) : null}
              </>
            ) : null}
          </>
        )
      }
    >
      {pending ? (
        <form
          id={inputId}
          onSubmit={(event) => {
            event.preventDefault();
            if (locked) return;
            void act(
              () =>
                request.kind === "secret"
                  ? api.provideRequestedSecret(request.sessionId, request.id, secretValue)
                  : api.answerQuestion(request.sessionId, request.id, { selected, text }),
              true,
            );
          }}
        >
          <FieldGroup>
            {request.kind === "secret" ? (
              <Field data-invalid={Boolean(error)}>
                <FieldLabel htmlFor={`${inputId}-secret`}>
                  <Trans>Secret value</Trans>
                </FieldLabel>
                <Textarea
                  id={`${inputId}-secret`}
                  className="max-h-48 font-mono"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  value={secretValue}
                  disabled={locked}
                  aria-invalid={Boolean(error)}
                  maxLength={65536}
                  onChange={(event) => setSecretValue(event.target.value)}
                />
                <FieldDescription>
                  <Trans>
                    Available to this session’s shell. The submitted value is stored separately and
                    is not sent as a chat message.
                  </Trans>
                </FieldDescription>
              </Field>
            ) : (
              <>
                {request.question!.options.length ? (
                  <Field>
                    <FieldLabel>
                      <Trans>Options</Trans>
                    </FieldLabel>
                    {request.question!.multiple ? (
                      <ToggleGroup
                        type="multiple"
                        variant="outline"
                        spacing={2}
                        value={selected}
                        onValueChange={setSelected}
                        disabled={locked}
                        className="flex-wrap"
                        aria-label={i18n._("Answer options")}
                      >
                        {request.question!.options.map((option) => (
                          <ToggleGroupItem
                            key={option.id}
                            value={option.id}
                            aria-label={option.label}
                            title={option.description}
                          >
                            {option.label}
                          </ToggleGroupItem>
                        ))}
                      </ToggleGroup>
                    ) : (
                      <ToggleGroup
                        type="single"
                        variant="outline"
                        spacing={2}
                        value={selected[0] ?? ""}
                        onValueChange={(value) => setSelected(value ? [value] : [])}
                        disabled={locked}
                        className="flex-wrap"
                        aria-label={i18n._("Answer options")}
                      >
                        {request.question!.options.map((option) => (
                          <ToggleGroupItem
                            key={option.id}
                            value={option.id}
                            aria-label={option.label}
                            title={option.description}
                          >
                            {option.label}
                          </ToggleGroupItem>
                        ))}
                      </ToggleGroup>
                    )}
                  </Field>
                ) : null}
                {request.question!.allowFreeText ? (
                  <Field data-invalid={Boolean(error)}>
                    <FieldLabel htmlFor={`${inputId}-text`}>
                      <Trans>Your answer</Trans>
                    </FieldLabel>
                    <Textarea
                      id={`${inputId}-text`}
                      value={text}
                      onChange={(event) => setText(event.target.value)}
                      disabled={locked}
                      maxLength={12000}
                      aria-invalid={Boolean(error)}
                    />
                  </Field>
                ) : null}
              </>
            )}
          </FieldGroup>
        </form>
      ) : request.kind === "secret" ? (
        <p className="text-sm text-muted-foreground">
          {request.credential
            ? i18n._("Credential provided · {value}", {
                value:
                  request.credential.scope === "agent"
                    ? i18n._("Saved for this agent")
                    : i18n._("This session only"),
              })
            : request.status === "answered"
              ? i18n._("Credential revoked.")
              : i18n._("No credential was provided.")}
        </p>
      ) : request.answer ? (
        <p className="text-sm whitespace-pre-wrap">
          {[
            ...request.answer.selected.map(
              (id) => request.question!.options.find((option) => option.id === id)?.label,
            ),
            request.answer.text,
          ]
            .filter(Boolean)
            .join("\n")}
        </p>
      ) : null}
      {sharedAgent && request.kind === "secret" && request.credential?.scope === "agent" ? (
        <p className="mt-2 text-sm text-muted-foreground">
          <Trans>People who can run this shared agent can use this credential.</Trans>
        </p>
      ) : null}
      {error ? (
        <Alert variant="destructive" className="mt-3">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </AgentRequestCard>
  );
}
