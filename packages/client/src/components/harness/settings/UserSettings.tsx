import { KeyRoundIcon, Trash2Icon, UserPlusIcon } from "lucide-react";
import { SectionHeader } from "@/components/harness/form-primitives";
import { Field, FieldLabel } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useUserAdministration } from "@/hooks/use-user-administration";
import { useHarnessStore } from "@/store/harness-store";
import type { UserRole } from "@carmel-agent/shared";

export function UserSettings() {
  const currentUserId = useHarnessStore((state) => state.activeUserId);
  const admin = useUserAdministration();
  const {
    users,
    loadError,
    username,
    setUsername,
    email,
    setEmail,
    password,
    setPassword,
    role,
    setRole,
    status,
    creating,
    resetUserId,
    setResetUserId,
    resetPassword,
    setResetPassword,
  } = admin;

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
                    <span className="block truncate text-xs text-muted-foreground">
                      {user.email}
                    </span>
                  </span>
                  {isSelf ? (
                    <Badge variant="default">{user.role} (you)</Badge>
                  ) : (
                    <div className="flex shrink-0 items-center gap-2">
                      <Select
                        value={user.role}
                        onValueChange={(value: UserRole) => void admin.changeRole(user.id, value)}
                      >
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
                          admin.togglePasswordReset(user.id);
                        }}
                      >
                        <KeyRoundIcon className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="Delete user"
                        onClick={() => void admin.removeUser(user)}
                      >
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
                    <Button
                      size="sm"
                      disabled={resetPassword.length < 8}
                      onClick={() => void admin.submitPasswordReset(user.id)}
                    >
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
        <SectionHeader
          title="Create User"
          description="Add a new account with a username, email, and password."
        />
        <Field>
          <FieldLabel>Username</FieldLabel>
          <Input
            value={username}
            autoComplete="off"
            onChange={(event) => setUsername(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel>Email</FieldLabel>
          <Input
            value={email}
            type="email"
            autoComplete="off"
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel>Password</FieldLabel>
          <Input
            value={password}
            type="password"
            autoComplete="new-password"
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel>Role</FieldLabel>
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
          onClick={() => void admin.createUser()}
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
