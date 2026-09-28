import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { AgentConfig, IssueCreateCommand } from "@carmel-agent/shared";
import { useHarnessStore } from "@/store/harness-store";
import { showError } from "@/lib/errors";
import { IssueBriefForm } from "./IssueBriefForm";
export function NewIssueView({ agent }: { agent: AgentConfig }) {
  const navigate = useNavigate();
  const createIssue = useHarnessStore((s) => s.createIssue);
  const [busy, setBusy] = useState(false);
  const save = async (draft: IssueCreateCommand) => {
    setBusy(true);
    try {
      const issue = await createIssue(agent.id, draft);
      navigate(`/agents/${agent.id}/issues/${issue.id}`);
    } catch (error) {
      showError("Unable to create issue", error);
      setBusy(false);
    }
  };
  return (
    <div className="h-full overflow-y-auto px-5 py-8">
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <Link className="text-sm text-muted-foreground hover:underline" to={`/agents/${agent.id}/issues`}>
          {agent.name} / Issues
        </Link>
        <div>
          <h1 className="text-2xl font-semibold">New issue</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Define the outcome for {agent.name}. Saving an issue does not start work.
          </p>
        </div>
        <IssueBriefForm
          busy={busy}
          onSave={(draft) => void save(draft)}
          onCancel={() => navigate(`/agents/${agent.id}/issues`)}
        />
      </div>
    </div>
  );
}
