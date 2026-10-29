import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { LanguagePicker } from "@/components/harness/settings/LanguagePicker";
import { LogInIcon } from "lucide-react";
import { FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel, FieldSeparator } from "@/components/ui/field";
import { OidcLoginButton } from "@/components/harness/OidcLoginButton";
import { useHarnessStore } from "@/store/harness-store";

export function LoginScreen() {
  const { i18n } = useLingui();
  const login = useHarnessStore((state) => state.login);
  const error = useHarnessStore((state) => state.error);
  const authOptions = useHarnessStore((state) => state.authOptions);
  // Without auth options (the status request failed), fall back to the form:
  // it is what every server offers unless an operator turned it off.
  const passwordLogin = authOptions?.passwordLogin ?? true;
  const oidc = authOptions?.oidc;
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    try {
      await login(username, password);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Carmel Agent</CardTitle>
          <CardDescription>
            {passwordLogin
              ? i18n._("Sign in with a server-created account.")
              : i18n._("Sign in with {value}.", {
                  value: oidc?.providerName ?? i18n._("single sign-on"),
                })}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <LanguagePicker />
          {oidc ? (
            <OidcLoginButton
              providerName={oidc.providerName}
              variant={passwordLogin ? "outline" : "default"}
            />
          ) : null}
          {oidc && passwordLogin ? (
            <FieldSeparator className="[&>span]:bg-card">
              <Trans>or</Trans>
            </FieldSeparator>
          ) : null}
          {passwordLogin ? (
            <form className="flex flex-col gap-4" onSubmit={submit}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="login-username">
                    <Trans>Username</Trans>
                  </FieldLabel>
                  <Input
                    id="login-username"
                    value={username}
                    autoComplete="username"
                    onChange={(event) => setUsername(event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="login-password">
                    <Trans>Password</Trans>
                  </FieldLabel>
                  <Input
                    id="login-password"
                    value={password}
                    type="password"
                    autoComplete="current-password"
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </Field>
              </FieldGroup>
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
              <Button type="submit" disabled={!username || !password || submitting}>
                <LogInIcon data-icon="inline-start" />
                {submitting ? i18n._("Signing in") : i18n._("Sign in")}
              </Button>
            </form>
          ) : error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}
