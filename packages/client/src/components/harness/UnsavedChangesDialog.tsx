import { useCallback, useState } from "react";
import { useBeforeUnload, useBlocker, type BlockerFunction } from "react-router-dom";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

/** Covers links, browser Back/Forward, and full-page exits without losing a draft. */
export function UnsavedChangesDialog({
  dirty,
  saving = false,
  shouldBlock,
  onSave,
}: {
  dirty: boolean;
  saving?: boolean;
  shouldBlock: BlockerFunction;
  onSave: () => Promise<boolean>;
}) {
  const blocker = useBlocker(
    useCallback<BlockerFunction>(
      (navigation) => dirty && shouldBlock(navigation),
      [dirty, shouldBlock],
    ),
  );
  const [savingBeforeLeave, setSavingBeforeLeave] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const busy = saving || savingBeforeLeave;

  useBeforeUnload(
    useCallback(
      (event) => {
        if (!dirty && !busy) return;
        event.preventDefault();
        event.returnValue = "";
      },
      [dirty, busy],
    ),
  );

  const cancel = () => {
    if (busy || blocker.state !== "blocked") return;
    setSaveFailed(false);
    blocker.reset();
  };
  const saveAndLeave = async () => {
    if (busy || blocker.state !== "blocked") return;
    setSavingBeforeLeave(true);
    setSaveFailed(false);
    try {
      if (await onSave()) blocker.proceed();
      else setSaveFailed(true);
    } catch {
      setSaveFailed(true);
    } finally {
      setSavingBeforeLeave(false);
    }
  };

  return (
    <AlertDialog open={blocker.state === "blocked"} onOpenChange={(open) => !open && cancel()}>
      <AlertDialogContent onEscapeKeyDown={(event) => busy && event.preventDefault()}>
        <AlertDialogHeader>
          <AlertDialogTitle>Save your changes?</AlertDialogTitle>
          <AlertDialogDescription>
            You have unsaved changes. Save them before leaving, discard them, or cancel to keep
            editing.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {saveFailed ? (
          <p role="alert" className="text-sm text-destructive">
            Unable to save. Your changes are still here. Try again or cancel to keep editing.
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => blocker.state === "blocked" && blocker.proceed()}
          >
            Discard changes
          </Button>
          <Button disabled={busy} onClick={() => void saveAndLeave()}>
            {busy ? "Saving…" : "Save and leave"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
