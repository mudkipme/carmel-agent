import { useLingui } from "@lingui/react";
import { useEffect, useState } from "react";
import type { User, UserRole } from "@carmel-agent/shared";
import { api } from "@/lib/api";
import { confirmAction } from "@/lib/action-dialogs";
import { errorMessage } from "@/lib/errors";

export function useUserAdministration() {
  const { i18n } = useLingui();
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
    void api.listUsers().then(
      (list) => {
        if (!cancelled) setUsers(list);
      },
      (error: unknown) => {
        if (!cancelled) setLoadError(errorMessage(error, i18n._("Unable to load users")));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [i18n]);

  const changeRole = async (userId: string, nextRole: UserRole) => {
    setStatus(null);
    try {
      const updated = await api.updateUserRole(userId, nextRole);
      setUsers((current) => current.map((item) => (item.id === userId ? updated : item)));
    } catch (error) {
      setStatus(errorMessage(error, i18n._("Unable to update role.")));
    }
  };

  const submitPasswordReset = async (userId: string) => {
    setStatus(null);
    try {
      await api.resetUserPassword(userId, resetPassword);
      setResetUserId(null);
      setResetPassword("");
      setStatus(i18n._("Password reset."));
    } catch (error) {
      setStatus(errorMessage(error, i18n._("Unable to reset password.")));
    }
  };

  const togglePasswordReset = (userId: string) => {
    setResetUserId((current) => (current === userId ? null : userId));
    setResetPassword("");
  };

  const removeUser = async (user: User) => {
    const confirmed = await confirmAction({
      title: i18n._("Delete {value}?", { value: user.username ?? user.name }),
      description: i18n._(
        "Their agents and models will transfer to your account; their sessions will be deleted.",
      ),
      actionLabel: i18n._("Delete user"),
    });
    if (!confirmed) return;
    setStatus(null);
    try {
      await api.deleteUser(user.id);
      setUsers((current) => current.filter((item) => item.id !== user.id));
    } catch (error) {
      setStatus(errorMessage(error, i18n._("Unable to delete user.")));
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
      setStatus(i18n._("Created {username}.", { username: created.username }));
    } catch (error) {
      setStatus(errorMessage(error, i18n._("Unable to create user.")));
    } finally {
      setCreating(false);
    }
  };

  return {
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
    changeRole,
    submitPasswordReset,
    togglePasswordReset,
    removeUser,
    createUser,
  };
}
