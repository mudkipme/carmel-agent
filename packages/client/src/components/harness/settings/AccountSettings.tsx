import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { LogOutIcon } from "lucide-react";
import { useState } from "react";
import { SectionHeader } from "@/components/harness/form-primitives";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useHarnessStore } from "@/store/harness-store";
import { errorMessage } from "@/lib/errors";

export function AccountSettings() {
  const { i18n } = useLingui();
  const user = useHarnessStore((state) =>
    state.users.find((item) => item.id === state.activeUserId),
  );
  const updateAccount = useHarnessStore((state) => state.updateAccount);
  const logout = useHarnessStore((state) => state.logout);
  const [email, setEmail] = useState(user?.email ?? "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setStatus(null);
    setSaving(true);
    try {
      await updateAccount(currentPassword, email.trim(), newPassword || undefined);
      setCurrentPassword("");
      setNewPassword("");
      setStatus(newPassword ? i18n._("Email and password updated.") : i18n._("Email updated."));
    } catch (error) {
      setStatus(errorMessage(error, i18n._("Unable to update account.")));
    } finally {
      setSaving(false);
    }
  };

  const newPasswordTooShort = newPassword.length > 0 && newPassword.length < 8;

  return (
    <div className="grid gap-6">
      <section className="grid gap-4">
        {user ? (
          <p className="text-sm text-muted-foreground">
            <Trans>Signed in as {user.username ?? user.name}</Trans>
          </p>
        ) : null}
        <Button variant="outline" className="justify-self-start" onClick={() => void logout()}>
          <LogOutIcon data-icon="inline-start" />
          <Trans>Sign out</Trans>
        </Button>
      </section>
      {user?.hasPassword === false ? (
        <section className="grid gap-3 border-t pt-6">
          <SectionHeader
            title={i18n._("Single sign-on")}
            description={i18n._(
              "This account signs in through your identity provider, which also manages its name and email. Changes there apply the next time you sign in.",
            )}
          />
        </section>
      ) : (
        <section className="grid gap-3 border-t pt-6">
          <SectionHeader
            title={i18n._("Email & Password")}
            description={i18n._(
              "Confirm your current password to change your email. Leave the new password blank to keep it.",
            )}
          />
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="account-email">
                <Trans>Email</Trans>
              </FieldLabel>
              <Input
                id="account-email"
                value={email}
                type="email"
                autoComplete="email"
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="account-current-password">
                <Trans>Current password</Trans>
              </FieldLabel>
              <Input
                id="account-current-password"
                value={currentPassword}
                type="password"
                autoComplete="current-password"
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="account-new-password">
                <Trans>New password (optional)</Trans>
              </FieldLabel>
              <Input
                id="account-new-password"
                value={newPassword}
                type="password"
                autoComplete="new-password"
                onChange={(event) => setNewPassword(event.target.value)}
              />
            </Field>
          </FieldGroup>
          {newPasswordTooShort ? (
            <p className="text-sm text-destructive">
              <Trans>New password must be at least 8 characters.</Trans>
            </p>
          ) : null}
          {status ? <p className="text-sm text-muted-foreground">{status}</p> : null}
          <Button
            className="justify-self-start"
            onClick={() => void save()}
            disabled={saving || !currentPassword || !email.trim() || newPasswordTooShort}
          >
            <Trans>Save changes</Trans>
          </Button>
        </section>
      )}
    </div>
  );
}
