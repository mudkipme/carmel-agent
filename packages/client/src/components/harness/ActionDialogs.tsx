import { useEffect, useState, useSyncExternalStore } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  getActionDialogSnapshot,
  resolveActionDialog,
  subscribeActionDialogs,
} from "@/lib/action-dialogs";

export function ActionDialogs() {
  const request = useSyncExternalStore(
    subscribeActionDialogs,
    getActionDialogSnapshot,
    getActionDialogSnapshot,
  );
  const [draft, setDraft] = useState("");
  useEffect(() => {
    if (request?.kind === "prompt") setDraft(request.initialValue);
  }, [request]);

  return (
    <>
      <AlertDialog
        open={request?.kind === "confirm"}
        onOpenChange={(open) => {
          if (!open) resolveActionDialog(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {request?.kind === "confirm" ? request.title : "Confirm action"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {request?.kind === "confirm" ? request.description : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => resolveActionDialog(true)}>
              {request?.kind === "confirm" ? request.actionLabel : "Continue"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={request?.kind === "prompt"}
        onOpenChange={(open) => {
          if (!open) resolveActionDialog(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {request?.kind === "prompt" ? request.title : "Enter a value"}
            </DialogTitle>
            {request?.kind === "prompt" && request.description ? (
              <DialogDescription>{request.description}</DialogDescription>
            ) : null}
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="action-dialog-value">Name</FieldLabel>
            <Input
              id="action-dialog-value"
              autoFocus
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && draft.trim()) resolveActionDialog(draft.trim());
              }}
            />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => resolveActionDialog(null)}>
              Cancel
            </Button>
            <Button disabled={!draft.trim()} onClick={() => resolveActionDialog(draft.trim())}>
              {request?.kind === "prompt" ? request.actionLabel : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
