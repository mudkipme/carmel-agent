import { LogOutIcon } from "lucide-react";
import { useState } from "react";
import { Field, SectionHeader } from "@/components/harness/form-primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useHarnessStore } from "@/store/harness-store";

export function AccountSettings() {
  const user = useHarnessStore((state) => state.users.find((item) => item.id === state.activeUserId));
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
      setStatus(error instanceof Error ? error.message : "Unable to update account.");
    } finally {
      setSaving(false);
    }
  };

  const newPasswordTooShort = newPassword.length > 0 && newPassword.length < 8;

  return (
    <div className="grid gap-6">
      <section className="grid gap-4">
        <SectionHeader title="Account" description={user?.username ? `Signed in as ${user.username}.` : "Signed in."} />
        <Button variant="outline" onClick={() => void logout()}>
          <LogOutIcon data-icon="inline-start" />
          Sign out
        </Button>
      </section>
      <section className="grid gap-3 border-t pt-6">
        <SectionHeader
          title="Email & Password"
          description="Confirm your current password to change your email. Leave the new password blank to keep it."
        />
        <Field label="Email">
          <Input value={email} type="email" autoComplete="email" onChange={(event) => setEmail(event.target.value)} />
        </Field>
        <Field label="Current password">
          <Input
            value={currentPassword}
            type="password"
            autoComplete="current-password"
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        </Field>
        <Field label="New password (optional)">
          <Input
            value={newPassword}
            type="password"
            autoComplete="new-password"
            placeholder="Leave blank to keep current password"
            onChange={(event) => setNewPassword(event.target.value)}
          />
        </Field>
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
    </div>
  );
}
