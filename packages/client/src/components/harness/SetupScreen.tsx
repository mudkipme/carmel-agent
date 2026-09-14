import { ShieldCheckIcon } from "lucide-react";
import { FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel, FieldSeparator } from "@/components/ui/field";
import { OidcLoginButton } from "@/components/harness/OidcLoginButton";
import { useHarnessStore } from "@/store/harness-store";

export function SetupScreen() {
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
          <CardTitle>Welcome to Carmel Agent</CardTitle>
          <CardDescription>
            {passwordLogin
              ? "Create the first account. It will be the administrator."
              : `The first person to sign in with ${oidc?.providerName ?? "single sign-on"} becomes the administrator.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {oidc ? (
            <OidcLoginButton
              providerName={oidc.providerName}
              label={`Continue with ${oidc.providerName}`}
              variant={passwordLogin ? "outline" : "default"}
            />
          ) : null}
          {oidc && passwordLogin ? <FieldSeparator className="[&>span]:bg-card">or</FieldSeparator> : null}
          {passwordLogin ? (
            <form className="flex flex-col gap-4" onSubmit={submit}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="setup-username">Username</FieldLabel>
                  <Input id="setup-username" value={username} autoComplete="username" onChange={(event) => setUsername(event.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="setup-email">Email</FieldLabel>
                  <Input
                    id="setup-email"
                    value={email}
                    type="email"
                    autoComplete="email"
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="setup-password">Password</FieldLabel>
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
                {submitting ? "Creating account" : "Create admin account"}
              </Button>
              <p className="text-xs text-muted-foreground">Password must be at least 8 characters.</p>
            </form>
          ) : error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}
