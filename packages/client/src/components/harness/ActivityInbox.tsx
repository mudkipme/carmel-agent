import { ArrowRightIcon, CheckCheckIcon, CheckIcon, CircleAlertIcon, CircleCheckIcon, InboxIcon, MailIcon, MessageCircleQuestionMarkIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ActivityFilter, ActivityItem, ActivityPage } from "@carmel-agent/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { activityLabels, activityPath } from "@/lib/activity";
import { errorMessage, showError } from "@/lib/errors";
import { cn, formatRelativeTime } from "@/lib/utils";
import { ACTIVITY_UPDATED } from "@/hooks/use-activity-count";

export function ActivityInbox() {
  const [filter, setFilter] = useState<ActivityFilter>("unread");
  const [before, setBefore] = useState<number>();
  const [page, setPage] = useState<ActivityPage>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const next = await api.listActivity(filter, before, controller.signal);
        if (!controller.signal.aborted) { setPage(next); setError(""); }
      } catch (error) {
        if (!controller.signal.aborted) setError(errorMessage(error, "Unable to load activity"));
      } finally { pending = false; }
    };
    void load();
    const timer = window.setInterval(() => void load(), 8_000);
    window.addEventListener("focus", load);
    return () => { controller.abort(); window.clearInterval(timer); window.removeEventListener("focus", load); };
  }, [filter, before, revision]);

  const mark = async (ids: number[], read: boolean) => {
    if (!ids.length) return;
    setBusy(true);
    try {
      await api.setActivityRead(ids, read);
      window.dispatchEvent(new Event(ACTIVITY_UPDATED));
      refresh();
    } catch (error) { showError("Unable to update inbox", error); }
    finally { setBusy(false); }
  };
  const changePage = (cursor?: number) => { setPage(undefined); setBefore(cursor); };
  const unreadIds = page?.items.filter((item) => item.readAt === null).map((item) => item.id) ?? [];

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-7 sm:px-8 sm:py-10">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-2">
            <p className="nav-label">Across your agents</p>
            <h1 className="text-2xl font-semibold tracking-tight">Your work, caught up.</h1>
            <p className="text-sm text-muted-foreground">Replies, questions, and results waiting for you.</p>
          </div>
          <Button variant="outline" size="sm" onClick={refresh} aria-label="Refresh inbox"><RefreshCwIcon data-icon="inline-start" />Refresh</Button>
        </div>
        <Tabs value={filter} onValueChange={(value) => { setFilter(value as ActivityFilter); changePage(); }}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
            <TabsList variant="line" aria-label="Activity filter">
              <TabsTrigger value="unread">Unread {page ? <Badge variant="secondary">{page.unreadCount}</Badge> : null}</TabsTrigger>
              <TabsTrigger value="attention">Needs attention</TabsTrigger>
              <TabsTrigger value="all">All activity</TabsTrigger>
            </TabsList>
            <Button variant="ghost" size="sm" disabled={busy || unreadIds.length === 0} onClick={() => void mark(unreadIds, true)}>
              <CheckCheckIcon data-icon="inline-start" />Mark shown as read
            </Button>
          </div>
          <TabsContent value={filter}>
            {error ? <Alert variant="destructive"><CircleAlertIcon /><AlertDescription>{error}</AlertDescription></Alert> : null}
            {!page && !error ? <div role="status" className="flex flex-col gap-4 py-5"><span className="sr-only">Loading activity</span><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" /></div> : null}
            {page?.items.length === 0 ? (
              <Empty className="border" aria-label="Empty inbox">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><InboxIcon /></EmptyMedia>
                  <EmptyTitle>{before ? "No older updates" : filter === "unread" ? "You're all caught up" : filter === "attention" ? "No unread questions or problems" : "Your activity starts here"}</EmptyTitle>
                  <EmptyDescription>{before ? "Return to the newest activity to see recent updates." : filter === "unread" ? "New replies and updates will appear here, even when you're away." : "Updates from sessions, issues, and scheduled tasks will appear as runs finish."}</EmptyDescription>
                </EmptyHeader>
                {filter !== "all" ? <EmptyContent><Button variant="outline" size="sm" onClick={() => { setFilter("all"); changePage(); }}>View all activity</Button></EmptyContent> : null}
              </Empty>
            ) : null}
            <ul className="flex flex-col divide-y">
              {page?.items.map((item) => <ActivityRow key={item.id} item={item} busy={busy} onRead={(read) => void mark([item.id], read)} />)}
            </ul>
            {before || page?.nextCursor ? (
              <div className="flex justify-between gap-3 pt-5">
                <Button variant="outline" size="sm" disabled={!before} onClick={() => changePage()}>Newest activity</Button>
                <Button variant="outline" size="sm" disabled={!page?.nextCursor} onClick={() => changePage(page?.nextCursor ?? undefined)}>Older activity</Button>
              </div>
            ) : null}
          </TabsContent>
        </Tabs>
        <p className="text-xs text-muted-foreground">Only your activity. Marking an update as read doesn’t resolve an issue.</p>
      </div>
    </div>
  );
}

function ActivityRow({ item, busy, onRead }: { item: ActivityItem; busy: boolean; onRead: (read: boolean) => void }) {
  const unread = item.readAt === null;
  const needsInput = item.kind === "needs_input";
  const problem = ["failed", "blocked", "missed", "interrupted"].includes(item.kind);
  const Icon = needsInput ? MessageCircleQuestionMarkIcon : problem ? CircleAlertIcon : item.kind === "review" ? CircleCheckIcon : MailIcon;
  const label = item.kind === "completed" && item.taskId ? "Run complete" : activityLabels[item.kind];
  return (
    <li className={cn("group flex items-start gap-3 rounded-lg px-2 py-5 sm:px-3", unread && "bg-muted/30")}>
      <div className={cn("mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background", problem ? "text-destructive" : "text-muted-foreground")}><Icon className="size-4" /></div>
      <Link to={activityPath(item)} onClick={() => { if (unread) onRead(true); }} className="flex min-w-0 flex-1 flex-col gap-1.5 rounded-sm outline-offset-4">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className={cn("font-medium", needsInput && "text-foreground", problem && "text-destructive")}>{label}</span>
          <span aria-hidden="true">·</span><span>{item.agentName}</span>
          <span aria-hidden="true">·</span><span>{item.issueId ? "Issue" : item.taskId ? "Scheduled task" : "Session"}</span>
        </div>
        <h2 className={cn("text-sm break-words", unread ? "font-semibold" : "font-medium")}>{item.title}</h2>
        <p className="line-clamp-2 text-sm whitespace-pre-wrap text-muted-foreground">{item.summary}</p>
        <div className="flex items-center gap-2 pt-1 text-xs text-muted-foreground">
          <time dateTime={new Date(item.createdAt).toISOString()} title={new Date(item.createdAt).toLocaleString()}>{formatRelativeTime(item.createdAt)}</time>
          <span className="flex items-center gap-1 text-foreground">{needsInput ? "Answer question" : item.kind === "review" ? "Review work" : problem ? "View details" : "Open conversation"}<ArrowRightIcon className="size-3" /></span>
        </div>
      </Link>
      <Button variant="ghost" size="icon-sm" disabled={busy} title={unread ? "Mark as read" : "Mark as unread"} aria-label={`${unread ? "Mark as read" : "Mark as unread"}: ${item.title}`} onClick={() => onRead(unread)}>
        {unread ? <CheckIcon /> : <MailIcon />}
      </Button>
    </li>
  );
}
