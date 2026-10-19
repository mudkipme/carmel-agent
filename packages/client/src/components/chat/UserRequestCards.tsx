import { useEffect, useState } from "react";
import type { UserRequest, SessionSecret } from "@carmel-agent/shared";
import { KeyRoundIcon, MessageCircleQuestionIcon } from "lucide-react";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { FieldGroup, Field, FieldLabel, FieldDescription } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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
    <div className="flex flex-col gap-3 py-3" aria-label="Agent requests">
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
      setError(errorMessage(error, "Unable to respond to this request."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      aria-label={
        request.kind === "secret"
          ? `Credential request: ${request.secret?.name}`
          : "Question from agent"
      }
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {request.kind === "secret" ? (
            <KeyRoundIcon aria-hidden="true" />
          ) : (
            <MessageCircleQuestionIcon aria-hidden="true" />
          )}
          {request.kind === "secret" ? request.secret?.name : request.question?.question}
          <Badge variant="secondary">
            {pending
              ? "Waiting for you"
              : request.status === "answered"
                ? "Answered"
                : request.status}
          </Badge>
        </CardTitle>
        <CardDescription>
          {request.kind === "secret"
            ? request.secret?.reason
            : pending
              ? "Choose an option or enter your answer."
              : "Your response is saved with this conversation."}
        </CardDescription>
      </CardHeader>
      <CardContent>
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
                  <FieldLabel htmlFor={`${inputId}-secret`}>Secret value</FieldLabel>
                  <Input
                    id={`${inputId}-secret`}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={secretValue}
                    disabled={locked}
                    aria-invalid={Boolean(error)}
                    maxLength={65536}
                    onChange={(event) => setSecretValue(event.target.value)}
                  />
                  <FieldDescription>
                    Available to this session’s shell. The submitted value is stored separately and
                    is not sent as a chat message.
                  </FieldDescription>
                </Field>
              ) : (
                <>
                  {request.question!.options.length ? (
                    <Field>
                      <FieldLabel>Options</FieldLabel>
                      {request.question!.multiple ? (
                        <ToggleGroup
                          type="multiple"
                          variant="outline"
                          spacing={2}
                          value={selected}
                          onValueChange={setSelected}
                          disabled={locked}
                          className="flex-wrap"
                          aria-label="Answer options"
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
                          aria-label="Answer options"
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
                      <FieldLabel htmlFor={`${inputId}-text`}>Your answer</FieldLabel>
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
              ? `Credential provided · ${request.credential.scope === "agent" ? "Saved for this agent" : "This session only"}`
              : request.status === "answered"
                ? "Credential revoked."
                : "No credential was provided."}
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
            People who can run this shared agent can use this credential.
          </p>
        ) : null}
        {error ? (
          <Alert variant="destructive" className="mt-3">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
      <CardFooter className="flex-wrap gap-2">
        {pending ? (
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
              {request.kind === "secret" ? "Provide credential" : "Submit answer"}
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
                Use saved credential
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
              Decline
            </Button>
          </>
        ) : (
          <>
            {request.delivery === "pending" ? (
              <Button size="sm" disabled={locked} onClick={() => void act(onContinue)}>
                Continue agent
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
                      ? "Save for this agent"
                      : "Use in this session only"}
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
                    Revoke credential
                  </Button>
                ) : null}
              </>
            ) : null}
          </>
        )}
      </CardFooter>
    </Card>
  );
}
