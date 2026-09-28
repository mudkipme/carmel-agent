import { useState } from "react";
import { Link } from "react-router-dom";
import { PlusIcon } from "lucide-react";
import type { AgentConfig, Issue } from "@carmel-agent/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { cn, formatRelativeTime } from "@/lib/utils";
import { describeIssue, isClosedIssue, sortIssues } from "./issue-state";
export function IssuesOverview({ agent, issues }: { agent: AgentConfig; issues: Issue[] }) {
  const [filter, setFilter] = useState("active");
  const [query, setQuery] = useState("");
  const filtered = issues
    .filter(
      (issue) =>
        (filter === "closed"
          ? isClosedIssue(issue)
          : filter === "backlog"
            ? issue.status === "backlog"
            : !isClosedIssue(issue) && issue.status !== "backlog") &&
        `${issue.title} ${issue.description}`.toLowerCase().includes(query.toLowerCase()),
    )
    .sort(sortIssues);
  return (
    <div className="h-full overflow-y-auto px-4 py-6 sm:px-8">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="mb-1 text-sm text-muted-foreground">{agent.name}</p>
            <h1 className="text-2xl font-semibold">Issues</h1>
            <p className="mt-2 text-sm text-muted-foreground">Define an outcome. Hand it over. Review the result.</p>
          </div>
          <Button asChild>
            <Link to={`/agents/${agent.id}/issues/new`}>
              <PlusIcon data-icon="inline-start" />
              New issue
            </Link>
          </Button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Tabs value={filter} onValueChange={setFilter}>
            <TabsList>
              <TabsTrigger value="active">Active</TabsTrigger>
              <TabsTrigger value="backlog">Backlog</TabsTrigger>
              <TabsTrigger value="closed">Closed</TabsTrigger>
            </TabsList>
          </Tabs>
          <Input
            className="max-w-64"
            aria-label="Search issues"
            placeholder="Search issues…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {filtered.length ? (
          <div className="overflow-hidden rounded-lg border">
            {filtered.map((issue) => {
              const state = describeIssue(issue);
              return (
                <Link
                  key={issue.id}
                  to={`/agents/${agent.id}/issues/${issue.id}`}
                  className="flex items-start gap-3 border-b px-4 py-4 last:border-0 hover:bg-muted/50"
                >
                  <state.Icon className={cn("mt-0.5 size-4 shrink-0", state.className)} />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="text-sm font-medium break-words">{issue.title}</span>
                    <span className="line-clamp-1 text-xs text-muted-foreground">
                      {issue.lastRunDetail ?? issue.verdictSummary ?? issue.description}
                    </span>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">{state.label}</Badge>
                      <span className="text-xs text-muted-foreground">{issue.priority} priority</span>
                    </div>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatRelativeTime(issue.updatedAt)}</span>
                </Link>
              );
            })}
          </div>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{query ? "No matching issues" : `No ${filter} issues`}</EmptyTitle>
              <EmptyDescription>
                {query
                  ? "Try another search."
                  : "Create an issue to capture work for this agent. It will wait until you start it."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </div>
  );
}
