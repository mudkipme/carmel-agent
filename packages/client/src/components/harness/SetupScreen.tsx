import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { LanguagePicker } from "@/components/harness/settings/LanguagePicker";
import { ShieldCheckIcon } from "lucide-react";
import { FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel, FieldSeparator } from "@/components/ui/field";
import { OidcLoginButton } from "@/components/harness/OidcLoginButton";
import { useHarnessStore } from "@/store/harness-store";

export function SetupScreen() {
  const { i18n } = useLingui();
  const setup = useHarnessStore((state) => state.setup);
  const error = useHarnessStore((state) => state.error);
  const authOptions = useHarnessStore((state) => state.authOptions);
  const passwordLogin = authOptions?.passwordLogin ?? true;
  const oidc = authOptions?.oidc;
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    try {
      await setup({ username, password, email: email || undefined });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <Trans>Welcome to Carmel Agent</Trans>
          </CardTitle>
          <CardDescription>
            {passwordLogin
              ? i18n._("Create the first account. It will be the administrator.")
              : i18n._("The first person to sign in with {value} becomes the administrator.", {
                  value: oidc?.providerName ?? i18n._("single sign-on"),
                })}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <LanguagePicker />
          {oidc ? (
            <OidcLoginButton
              providerName={oidc.providerName}
              label={i18n._("Continue with {providerName}", { providerName: oidc.providerName })}
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
                  <FieldLabel htmlFor="setup-username">
                    <Trans>Username</Trans>
                  </FieldLabel>
                  <Input
                    id="setup-username"
                    value={username}
                    autoComplete="username"
                    onChange={(event) => setUsername(event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="setup-email">
                    <Trans>Email</Trans>
                  </FieldLabel>
                  <Input
                    id="setup-email"
                    value={email}
                    type="email"
                    autoComplete="email"
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="setup-password">
                    <Trans>Password</Trans>
                  </FieldLabel>
                  <Input
                    id="setup-password"
                    value={password}
                    type="password"
                    autoComplete="new-password"
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </Field>
              </FieldGroup>
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
              <Button type="submit" disabled={!username || password.length < 8 || submitting}>
                <ShieldCheckIcon data-icon="inline-start" />
                {submitting ? i18n._("Creating account") : i18n._("Create admin account")}
              </Button>
              <p className="text-xs text-muted-foreground">
                <Trans>Password must be at least 8 characters.</Trans>
              </p>
            </form>
          ) : error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}
