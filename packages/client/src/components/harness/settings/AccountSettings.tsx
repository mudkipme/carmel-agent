import { LogOutIcon } from "lucide-react";
import { useState } from "react";
import { Field, SectionHeader } from "@/components/harness/form-primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useHarnessStore } from "@/store/harness-store";

export function AccountSettings() {
  const user = useHarnessStore((state) => state.users.find((item) => item.id === state.activeUserId));
  const changePassword = useHarnessStore((state) => state.changePassword);
  const upsertUser = useHarnessStore((state) => state.upsertUser);
  const logout = useHarnessStore((state) => state.logout);
  const [email, setEmail] = useState(user?.email ?? "");
  const [profileStatus, setProfileStatus] = useState<string | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  const saveEmail = async () => {
    if (!user) return;
    setSavingProfile(true);
    setProfileStatus(null);
    try {
      await upsertUser({ ...user, email: email.trim() });
      setProfileStatus("Email updated.");
    } catch (error) {
      setProfileStatus(error instanceof Error ? error.message : "Unable to update email.");
    } finally {
      setSavingProfile(false);
    }
  };

  const savePassword = async () => {
    setStatus(null);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setStatus("Password updated.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to update password.");
    }
  };

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
        <SectionHeader title="Profile" description="Update the email address for this account." />
        <Field label="Email">
          <Input value={email} type="email" autoComplete="email" onChange={(event) => setEmail(event.target.value)} />
        </Field>
        {profileStatus ? <p className="text-sm text-muted-foreground">{profileStatus}</p> : null}
        <Button
          onClick={() => void saveEmail()}
          disabled={savingProfile || !email.trim() || email.trim() === user?.email}
        >
          Save email
        </Button>
      </section>
      <section className="grid gap-3 border-t pt-6">
        <SectionHeader title="Change Password" description="Update the password for this account." />
        <Field label="Current password">
          <Input
            value={currentPassword}
            type="password"
            autoComplete="current-password"
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        </Field>
        <Field label="New password">
          <Input
            value={newPassword}
            type="password"
            autoComplete="new-password"
            onChange={(event) => setNewPassword(event.target.value)}
          />
        </Field>
        {status ? <p className="text-sm text-muted-foreground">{status}</p> : null}
        <Button onClick={() => void savePassword()} disabled={!currentPassword || newPassword.length < 8}>
          Update password
        </Button>
      </section>
    </div>
  );
}
