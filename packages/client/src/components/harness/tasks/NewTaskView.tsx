import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { AgentConfig, IssueCreateCommand } from "@carmel-agent/shared";
import { useHarnessStore } from "@/store/harness-store";
import { draftStorageKey, clearSessionDraft } from "@/lib/session-draft";
import { issueListSearch } from "@/lib/issue-navigation";
import { showError } from "@/lib/errors";
import { TaskBriefForm } from "./TaskBriefForm";
export function NewTaskView({ agent }: { agent: AgentConfig }) {
  const { i18n } = useLingui();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const search = issueListSearch(params);
  const listPath = `/agents/${agent.id}/tasks${search}`;
  const userId = useHarnessStore((s) => s.activeUserId);
  const draftKey = draftStorageKey(userId, agent.id, "new-issue");
  const createIssue = useHarnessStore((s) => s.createIssue);
  const [busy, setBusy] = useState(false);
  const save = async (draft: IssueCreateCommand) => {
    setBusy(true);
    try {
      const issue = await createIssue(agent.id, draft);
      clearSessionDraft(draftKey);
      navigate(`/agents/${agent.id}/tasks/${issue.id}${search}`);
    } catch (error) {
      showError(i18n._("Unable to create task"), error);
      setBusy(false);
    }
  };
  return (
    <div className="h-full overflow-y-auto px-4 py-4 sm:px-6">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <Link className="text-sm text-muted-foreground hover:underline" to={listPath}>
          <Trans>{agent.name} / Tasks</Trans>
        </Link>
        <h1 className="text-base font-semibold">
          <Trans>New task</Trans>
        </h1>
        <TaskBriefForm
          busy={busy}
          draftKey={draftKey}
          onSave={(draft) => void save(draft)}
          onCancel={() => {
            clearSessionDraft(draftKey);
            navigate(listPath);
          }}
        />
      </div>
    </div>
  );
}
