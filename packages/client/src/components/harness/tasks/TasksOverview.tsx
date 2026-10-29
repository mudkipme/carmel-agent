import { priorityLabel } from "@/lib/labels";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { PlusIcon, ArrowUpIcon, ArrowDownIcon, ListTodoIcon, SearchIcon } from "lucide-react";
import type { AgentConfig, Issue } from "@carmel-agent/shared";
import { PageHeader } from "../form-primitives";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Empty, EmptyMedia, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { cn, formatRelativeTime } from "@/lib/utils";
import { api } from "@/lib/api";
import { showError } from "@/lib/errors";
import { issueFilters, issueListSearch, readIssueFilter } from "@/lib/issue-navigation";
import { ResourceError, ResourceLoading } from "../ResourceFeedback";
import { describeIssue, issueGroup, sortIssues } from "./issue-state";
export function TasksOverview({
  agent,
  issues,
  loading,
  error,
  onRefresh,
}: {
  agent: AgentConfig;
  issues: Issue[];
  loading: boolean;
  error?: string;
  onRefresh: () => Promise<unknown>;
}) {
  const { i18n } = useLingui();
  const [params, setParams] = useSearchParams();
  const filter = readIssueFilter(params);
  const query = params.get("q") ?? "";
  const listSearch = issueListSearch(params);
  const updateParams = (name: string, value: string, replace = false) => {
    // BrowserRouter writes history before its next render. Use that current
    // URL so fast typing cannot overwrite a just-selected tab with stale params.
    const next = new URLSearchParams(window.location.search);
    if (!value || (name === "filter" && value === "queue")) next.delete(name);
    else next.set(name, value);
    setParams(next, { replace });
  };
  const [busy, setBusy] = useState(false);
  const groupForFilter =
    {
      queue: ["Working", "Queued"],
      attention: ["Needs you"],
      backlog: ["Backlog"],
      done: ["Done"],
    }[filter] ?? [];
  const filtered = issues
    .filter(
      (issue) =>
        groupForFilter.includes(issueGroup(issue)) &&
        `${issue.title} ${issue.description}`.toLowerCase().includes(query.toLowerCase()),
    )
    .sort(sortIssues);
  const queue = issues.filter((issue) => issue.status === "queued").sort(sortIssues);
  const move = async (issueId: string, direction: "up" | "down") => {
    setBusy(true);
    try {
      await api.moveQueuedIssue(agent.id, issueId, direction);
      await onRefresh();
    } catch (error) {
      showError(i18n._("Unable to reorder queue"), error);
    } finally {
      setBusy(false);
    }
  };
  const rows = filtered.length ? (
    <div className="overflow-hidden rounded-lg border bg-card">
      {filtered.map((issue) => {
        const state = describeIssue(issue);
        return (
          <div key={issue.id} className="flex min-w-0 items-center border-b last:border-0">
            <Link
              to={`/agents/${agent.id}/tasks/${issue.id}${listSearch}`}
              className="flex min-w-0 flex-1 items-start gap-2 px-3 py-2.5 transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            >
              <state.Icon className={cn("mt-0.5 size-4 shrink-0", state.className)} />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-sm font-medium break-words">{issue.title}</span>
                <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                  <span className="shrink-0">{state.label}</span>
                  {issue.lastRunDetail || issue.verdictSummary ? (
                    <span className="truncate">{issue.lastRunDetail ?? issue.verdictSummary}</span>
                  ) : null}
                </div>
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatRelativeTime(issue.updatedAt)}
              </span>
              {issue.priority !== "normal" ? (
                <Badge variant="outline">{priorityLabel(issue.priority)}</Badge>
              ) : null}
            </Link>
            {issue.status === "queued" ? (
              <div className="flex shrink-0 flex-col gap-1 pr-3">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={i18n._("Move {title} up", { title: issue.title })}
                  disabled={busy || queue[0]?.id === issue.id}
                  onClick={() => void move(issue.id, "up")}
                >
                  <ArrowUpIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={i18n._("Move {title} down", { title: issue.title })}
                  disabled={busy || queue.at(-1)?.id === issue.id}
                  onClick={() => void move(issue.id, "down")}
                >
                  <ArrowDownIcon />
                </Button>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  ) : (
    <Empty className="min-h-48 border">
      <EmptyHeader>
        <EmptyMedia variant="icon">{query ? <SearchIcon /> : <ListTodoIcon />}</EmptyMedia>
        <EmptyTitle>
          {query
            ? i18n._("No matching tasks")
            : filter === "attention"
              ? i18n._("Nothing needs your attention")
              : filter === "queue"
                ? i18n._("No queued work")
                : filter === "backlog"
                  ? i18n._("Backlog is empty")
                  : i18n._("No completed tasks")}
        </EmptyTitle>
      </EmptyHeader>
    </Empty>
  );
  return (
    <div className="h-full overflow-y-auto px-4 py-4 sm:px-6">
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <PageHeader
          title={i18n._("Tasks")}

          icon={ListTodoIcon}
          actions={
            <Button asChild>
              <Link to={`/agents/${agent.id}/tasks/new${listSearch}`}>
                <PlusIcon data-icon="inline-start" />
                <Trans>New task</Trans>
              </Link>
            </Button>
          }
        />
        <Tabs
          value={filter}
          onValueChange={(value) => updateParams("filter", value)}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <TabsList className="w-full sm:w-auto">
              <TabsTrigger value="queue" aria-label={i18n._("Queue")}>
                <Trans>Queue</Trans>
                <span
                  aria-hidden="true"
                  className="ml-1 hidden text-xs text-muted-foreground tabular-nums sm:inline"
                >
                  {
                    issues.filter((issue) => ["Working", "Queued"].includes(issueGroup(issue)))
                      .length
                  }
                </span>
              </TabsTrigger>
              <TabsTrigger value="attention" aria-label={i18n._("Needs you")}>
                <Trans>Needs you</Trans>
                <span
                  aria-hidden="true"
                  className="ml-1 hidden text-xs text-muted-foreground tabular-nums sm:inline"
                >
                  {issues.filter((issue) => ["Needs you"].includes(issueGroup(issue))).length}
                </span>
              </TabsTrigger>
              <TabsTrigger value="backlog" aria-label={i18n._("Backlog")}>
                <Trans>Backlog</Trans>
                <span
                  aria-hidden="true"
                  className="ml-1 hidden text-xs text-muted-foreground tabular-nums sm:inline"
                >
                  {issues.filter((issue) => ["Backlog"].includes(issueGroup(issue))).length}
                </span>
              </TabsTrigger>
              <TabsTrigger value="done" aria-label={i18n._("Done")}>
                <Trans>Done</Trans>
                <span
                  aria-hidden="true"
                  className="ml-1 hidden text-xs text-muted-foreground tabular-nums sm:inline"
                >
                  {issues.filter((issue) => ["Done"].includes(issueGroup(issue))).length}
                </span>
              </TabsTrigger>
            </TabsList>
            <div className="relative w-full sm:w-auto">
              <SearchIcon
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                className="w-full pl-9 sm:w-56"
                aria-label={i18n._("Search tasks")}
                placeholder={i18n._("Search tasks…")}
                value={query}
                onChange={(e) => updateParams("q", e.target.value, true)}
              />
            </div>
          </div>
          {error ? (
            <ResourceError
              error={error}
              title={i18n._("Unable to load tasks")}
              onRetry={onRefresh}
            />
          ) : null}
          {issueFilters.map((value) => (
            <TabsContent key={value} value={value}>
              {filter === value ? (
                loading ? (
                  <ResourceLoading label={i18n._("Loading issues")} />
                ) : error && !issues.length ? null : (
                  rows
                )
              ) : null}
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </div>
  );
}
