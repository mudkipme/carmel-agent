import { LogOutIcon } from "lucide-react";
import { useState } from "react";
import { SectionHeader } from "@/components/harness/form-primitives";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useHarnessStore } from "@/store/harness-store";
import { errorMessage } from "@/lib/errors";

export function AccountSettings() {
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
      setStatus(newPassword ? "Email and password updated." : "Email updated.");
    } catch (error) {
      setStatus(errorMessage(error, "Unable to update account."));
    } finally {
      setSaving(false);
    }
  };

  const newPasswordTooShort = newPassword.length > 0 && newPassword.length < 8;

  return (
    <div className="grid gap-6">
      <section className="grid gap-4">
        <SectionHeader
          title="Account"
          description={user ? `Signed in as ${user.username ?? user.name}.` : "Signed in."}
        />
        <Button variant="outline" onClick={() => void logout()}>
          <LogOutIcon data-icon="inline-start" />
          Sign out
        </Button>
      </section>
      {user?.hasPassword === false ? (
        <section className="grid gap-3 border-t pt-6">
          <SectionHeader
            title="Single sign-on"
            description="This account signs in through your identity provider, which also manages its name and email. Changes there apply the next time you sign in."
          />
        </section>
      ) : (
        <section className="grid gap-3 border-t pt-6">
          <SectionHeader
            title="Email & Password"
            description="Confirm your current password to change your email. Leave the new password blank to keep it."
          />
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="account-email">Email</FieldLabel>
              <Input
                id="account-email"
                value={email}
                type="email"
                autoComplete="email"
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="account-current-password">Current password</FieldLabel>
              <Input
                id="account-current-password"
                value={currentPassword}
                type="password"
                autoComplete="current-password"
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="account-new-password">New password (optional)</FieldLabel>
              <Input
                id="account-new-password"
                value={newPassword}
                type="password"
                autoComplete="new-password"
                placeholder="Leave blank to keep current password"
                onChange={(event) => setNewPassword(event.target.value)}
              />
            </Field>
          </FieldGroup>
          {newPasswordTooShort ? (
            <p className="text-sm text-destructive">New password must be at least 8 characters.</p>
          ) : null}
          {status ? <p className="text-sm text-muted-foreground">{status}</p> : null}
          <Button
            onClick={() => void save()}
            disabled={saving || !currentPassword || !email.trim() || newPasswordTooShort}
          >
            Save changes
          </Button>
        </section>
      )}
    </div>
  );
}
