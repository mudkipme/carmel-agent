import { useCallback, useEffect, useState } from "react";
import { ArchiveRestoreIcon, Trash2Icon } from "lucide-react";
import type { SessionMetadata } from "@carmel-agent/shared";
import { Button } from "@/components/ui/button";
import { SectionHeader } from "@/components/harness/form-primitives";
import { confirmAction } from "@/lib/action-dialogs";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { formatRelativeTime } from "@/lib/utils";
import { useHarnessStore } from "@/store/harness-store";

/**
 * Sessions archived out of this agent's session list.
 *
 * Archived sessions are not part of bootstrap, so this is the only place they
 * are read, restored, or deleted. Like tasks and secrets, actions here apply
 * immediately rather than waiting for the page's Save.
 */
export function AgentArchivedSessionsSettings({ agentId }: { agentId: string }) {
  const restoreSession = useHarnessStore((state) => state.restoreSession);
  const deleteSession = useHarnessStore((state) => state.deleteSession);
  const [sessions, setSessions] = useState<SessionMetadata[] | undefined>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setSessions(await api.listArchivedSessions(agentId));
      setError(undefined);
    } catch (loadError) {
      setError(errorMessage(loadError, "Unable to load archived sessions"));
    }
  }, [agentId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const act = async (action: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    try {
      await action();
      setError(undefined);
      await reload();
    } catch (actionError) {
      setError(errorMessage(actionError, fallback));
    } finally {
      setBusy(false);
    }
  };

  const removeSession = async (session: SessionMetadata) => {
    const confirmed = await confirmAction({
      title: `Delete “${session.title}”?`,
      description: "This session and its message history will be permanently deleted.",
      actionLabel: "Delete session",
    });
    if (confirmed) await act(() => deleteSession(session.id), "Unable to delete session");
  };

  return (
    <section className="grid gap-4">
      <SectionHeader
        title="Archived sessions"
        description="Archived sessions are hidden from the session list. Restore one to bring it back, or delete it for good."
      />

      {sessions === undefined ? (
        error ? null : <p className="text-sm text-muted-foreground">Loading…</p>
      ) : sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No archived sessions.</p>
      ) : (
        <ul className="grid gap-2">
          {sessions.map((session) => (
            <li key={session.id} className="flex items-center justify-between gap-2 rounded-md border p-3">
              <div className="min-w-0">
                <p className="truncate font-medium">{session.title}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {session.archivedAt ? `Archived ${formatRelativeTime(session.archivedAt)} ago` : "Archived"}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void act(() => restoreSession(session.id), "Unable to restore session")}
                >
                  <ArchiveRestoreIcon data-icon="inline-start" />
                  Restore
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  title="Delete session"
                  disabled={busy}
                  onClick={() => void removeSession(session)}
                >
                  <Trash2Icon data-icon="inline-start" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </section>
  );
}
