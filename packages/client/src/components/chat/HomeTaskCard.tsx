import { ChevronRightIcon } from "lucide-react";
import { Link } from "react-router-dom";
import type { HomeIssueUpdate } from "@carmel-agent/shared";
import { Card, CardHeader, CardTitle, CardDescription, CardAction } from "@/components/ui/card";
import { describeIssue } from "@/components/harness/tasks/issue-state";
import { cn } from "@/lib/utils";

export function HomeTaskCard({ issue }: { issue: HomeIssueUpdate }) {
  const state = describeIssue({ ...issue, running: false });
  return (
    <Link
      to={`/agents/${issue.agentId}/tasks/${issue.id}?from=home`}
      aria-label={`Open task: ${issue.title}`}
      className="group block w-full max-w-md rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-home-issue={issue.id}
    >
      <Card className="gap-0 py-3">
        <CardHeader>
          <CardTitle className="min-w-0 break-words group-hover:underline">{issue.title}</CardTitle>
          <CardDescription className="flex items-center gap-1.5">
            <state.Icon aria-hidden className={cn("size-3.5", state.className)} />
            {state.label}
          </CardDescription>
          <CardAction>
            <ChevronRightIcon aria-hidden className="size-4 text-muted-foreground" />
          </CardAction>
        </CardHeader>
      </Card>
    </Link>
  );
}
