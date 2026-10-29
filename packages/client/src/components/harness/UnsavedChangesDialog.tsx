import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
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
  const { i18n } = useLingui();
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
          <AlertDialogTitle>
            <Trans>Save your changes?</Trans>
          </AlertDialogTitle>
          <AlertDialogDescription>
            <Trans>
              You have unsaved changes. Save them before leaving, discard them, or cancel to keep
              editing.
            </Trans>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {saveFailed ? (
          <p role="alert" className="text-sm text-destructive">
            <Trans>
              Unable to save. Your changes are still here. Try again or cancel to keep editing.
            </Trans>
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>
            <Trans>Cancel</Trans>
          </AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => blocker.state === "blocked" && blocker.proceed()}
          >
            <Trans>Discard changes</Trans>
          </Button>
          <Button disabled={busy} onClick={() => void saveAndLeave()}>
            {busy ? i18n._("Saving…") : i18n._("Save and leave")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
