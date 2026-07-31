import { LogInIcon } from "lucide-react";
import { FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { useHarnessStore } from "@/store/harness-store";

export function LoginScreen() {
  const login = useHarnessStore((state) => state.login);
  const error = useHarnessStore((state) => state.error);
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
    <main className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Carmel Agent</CardTitle>
          <CardDescription>Sign in with a server-created account.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={submit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="login-username">Username</FieldLabel>
                <Input id="login-username" value={username} autoComplete="username" onChange={(event) => setUsername(event.target.value)} />
              </Field>
              <Field>
                <FieldLabel htmlFor="login-password">Password</FieldLabel>
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
              {submitting ? "Signing in" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
