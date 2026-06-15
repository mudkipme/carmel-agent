import { KeyRoundIcon, Trash2Icon, UserPlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Field, SectionHeader } from "@/components/harness/form-primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { useHarnessStore } from "@/store/harness-store";
import type { User, UserRole } from "@carmel-agent/shared";

export function UserSettings() {
  const currentUserId = useHarnessStore((state) => state.activeUserId);
  const [users, setUsers] = useState<User[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>("user");
  const [status, setStatus] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [resetUserId, setResetUserId] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState("");

  useEffect(() => {
    let cancelled = false;
    void api
      .listUsers()
      .then((list) => {
        if (!cancelled) setUsers(list);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "Unable to load users");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const changeRole = async (userId: string, nextRole: UserRole) => {
    setStatus(null);
    try {
      const updated = await api.updateUserRole(userId, nextRole);
      setUsers((current) => current.map((item) => (item.id === userId ? updated : item)));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to update role.");
    }
  };

  const submitPasswordReset = async (userId: string) => {
    setStatus(null);
    try {
      await api.resetUserPassword(userId, resetPassword);
      setResetUserId(null);
      setResetPassword("");
      setStatus("Password reset.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to reset password.");
    }
  };

  const removeUser = async (user: User) => {
    if (!window.confirm(`Delete ${user.username ?? user.name}? Their agents and models transfer to you.`)) return;
    setStatus(null);
    try {
      await api.deleteUser(user.id);
      setUsers((current) => current.filter((item) => item.id !== user.id));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to delete user.");
    }
  };

  const createUser = async () => {
    setStatus(null);
    setCreating(true);
    try {
      const created = await api.createUser({ username, email, password, role });
      setUsers((current) => [...current, created]);
      setUsername("");
      setEmail("");
      setPassword("");
      setRole("user");
      setStatus(`Created ${created.username}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to create user.");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="grid gap-6">
      <section className="grid gap-3">
        <SectionHeader title="Users" description="Accounts that can sign in to this server." />
        {loadError ? <p className="text-sm text-destructive">{loadError}</p> : null}
        <div className="grid gap-2 rounded-md border p-2">
          {users.map((user) => {
            const isSelf = user.id === currentUserId;
            return (
              <div key={user.id} className="grid gap-2 px-2 py-1.5">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{user.username ?? user.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{user.email}</span>
                  </span>
                  {isSelf ? (
                    <Badge variant="default">{user.role} (you)</Badge>
                  ) : (
                    <div className="flex shrink-0 items-center gap-2">
                      <Select value={user.role} onValueChange={(value: UserRole) => void changeRole(user.id, value)}>
                        <SelectTrigger className="h-8 w-28">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="user">User</SelectItem>
                          <SelectItem value="admin">Admin</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="Reset password"
                        onClick={() => {
                          setResetUserId((current) => (current === user.id ? null : user.id));
                          setResetPassword("");
                        }}
                      >
                        <KeyRoundIcon className="size-4" />
                      </Button>
                      <Button variant="ghost" size="icon-sm" title="Delete user" onClick={() => void removeUser(user)}>
                        <Trash2Icon className="size-4" />
                      </Button>
                    </div>
                  )}
                </div>
                {resetUserId === user.id ? (
                  <div className="flex items-center gap-2">
                    <Input
                      value={resetPassword}
                      type="password"
                      autoComplete="new-password"
                      placeholder="New password"
                      onChange={(event) => setResetPassword(event.target.value)}
                    />
                    <Button size="sm" disabled={resetPassword.length < 8} onClick={() => void submitPasswordReset(user.id)}>
                      Set
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setResetUserId(null)}>
                      Cancel
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      <section className="grid gap-3 border-t pt-6">
        <SectionHeader title="Create User" description="Add a new account with a username, email, and password." />
        <Field label="Username">
          <Input value={username} autoComplete="off" onChange={(event) => setUsername(event.target.value)} />
        </Field>
        <Field label="Email">
          <Input value={email} type="email" autoComplete="off" onChange={(event) => setEmail(event.target.value)} />
        </Field>
        <Field label="Password">
          <Input
            value={password}
            type="password"
            autoComplete="new-password"
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <Field label="Role">
          <Select value={role} onValueChange={(value: UserRole) => setRole(value)}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="user">User</SelectItem>
              <SelectItem value="admin">Admin</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {status ? <p className="text-sm text-muted-foreground">{status}</p> : null}
        <Button
          onClick={() => void createUser()}
          disabled={creating || !username.trim() || !email.trim() || password.length < 8}
        >
          <UserPlusIcon data-icon="inline-start" />
          Create user
        </Button>
        <p className="text-xs text-muted-foreground">Password must be at least 8 characters.</p>
      </section>
    </div>
  );
}
