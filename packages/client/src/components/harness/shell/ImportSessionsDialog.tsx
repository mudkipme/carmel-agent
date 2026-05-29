import { useRef, useState, type ChangeEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useHarnessStore } from "@/store/harness-store";
import type { AgentConfig, ModelRef } from "@carmel-agent/shared";
import type { SidebarMode } from "./sidebar-utils";

export function ImportSessionsDialog({
  open,
  activeAgent,
  modelRefs,
  onOpenChange,
  onSidebarModeChange,
  onAfterImport,
}: {
  open: boolean;
  activeAgent?: AgentConfig;
  modelRefs: ModelRef[];
  onOpenChange: (open: boolean) => void;
  onSidebarModeChange: (mode: SidebarMode) => void;
  onAfterImport: () => void;
}) {
  const navigate = useNavigate();
  const importOpenWebuiSessions = useHarnessStore((state) => state.importOpenWebuiSessions);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importError, setImportError] = useState("");
  const [importing, setImporting] = useState(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const reset = () => {
    setImportError("");
    setImportFile(null);
    if (importInputRef.current) importInputRef.current.value = "";
  };

  const selectImportFile = (event: ChangeEvent<HTMLInputElement>) => {
    setImportError("");
    setImportFile(event.target.files?.[0] ?? null);
  };

  const importSessions = async () => {
    if (!activeAgent || !importFile) return;
    setImporting(true);
    setImportError("");
    try {
      const source = JSON.parse(await importFile.text()) as unknown;
      const importedSessions = await importOpenWebuiSessions({
        agentId: activeAgent.id,
        modelRefId: activeAgent.defaultModelRefId,
        thinkingLevel: activeAgent.defaultThinkingLevel ?? "off",
        source,
      });
      const firstSession = importedSessions[0];
      if (firstSession) {
        navigate(`/agents/${firstSession.agentId}/sessions/${firstSession.id}`);
        onSidebarModeChange("sessions");
        onAfterImport();
      }
      onOpenChange(false);
      reset();
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Unable to import sessions");
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen && !importing) reset();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import Sessions</DialogTitle>
          <DialogDescription>Import Open WebUI JSON exports into the selected agent.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            disabled={importing}
            onChange={selectImportFile}
            className="h-9 rounded-md border bg-background px-3 py-1.5 text-sm file:mr-3 file:border-0 file:bg-transparent file:text-sm file:font-medium"
          />
          <p className="text-xs text-muted-foreground">
            Target: {activeAgent?.name ?? "No agent"} ·{" "}
            {modelRefs.find((model) => model.id === activeAgent?.defaultModelRefId)?.label ?? "No model"}
          </p>
          {importError ? <p className="text-sm text-destructive">{importError}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={importing} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!importFile || importing} onClick={() => void importSessions()}>
            {importing ? "Importing..." : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
