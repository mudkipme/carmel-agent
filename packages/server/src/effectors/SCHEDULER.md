# Scheduled agent tasks

Nothing in carmel used to run without a browser open. A task prompts an agent on
a schedule, in a session of its own.

```
effectors/task-schedule.ts     pure: next-run arithmetic and the firing decision
services/agent-tasks.ts        CRUD, ownership, the scheduler's due query
runtime/task-scheduler.ts      the poll loop and firing
routes/agent-tasks.ts          REST, nested under the agent
```

## Shape

A task **belongs to an agent** and dies with it. It still carries a `userId`,
because agents can be shared while the task's session, model permission, and
provider credentials all resolve per user.

Each task gets **one session, created on its first firing**, and every run
appends to it. A fresh session per run would be a guaranteed cold prompt cache
every time; one thread per task keeps the prefix stable, which is worth more
than the context it accumulates. Compaction handles the growth.

## Firing

`startDetachedAgentRun` — the same path an interactive run takes, minus the SSE
stream. Scheduled runs therefore inherit the run guard, compaction and context
recovery, the failure classifier, extension tools, and branch integrity without
any of it existing twice. Unattended runs are where the guard matters most.

A poll loop, not a timer per task: tasks are edited, paused and deleted from
under it, and one "active and due" query is self-correcting after a restart.

Three things the loop protects against, each with a test:

- **Overlap.** A firing is skipped when the task's session already has an active
  run — either its own previous firing or a person prompting in it.
- **Starvation.** Due tasks are ordered most-overdue-first, because the tick has
  a concurrency cap (default 2, `CARMEL_AGENT_MAX_CONCURRENT_TASKS`). In table
  order, one permanently-due task would hold a slot forever. This was found by a
  test failing for the wrong reason, which is the only reason it is here.
- **Re-arm drift.** The next run is computed from `max(scheduledFor, now)`. From
  the occurrence alone, a run outlasting its own interval comes back due the
  instant it finishes; from the clock alone, a one-shot whose instant is still a
  second away re-arms instead of completing.

## Missed runs

An occurrence more than five minutes late is recorded as `missed` and the
schedule recomputed from now. A restart after three days of downtime resumes
tomorrow rather than firing everything at once.

**One-shots are exempt.** Skipping one occurrence of a recurring task costs a
run; skipping a one-shot means the thing the user asked for never happens. It
fires however late.

## Visibility

Tasks are listed per agent, and you see your own. A shared agent is visible to
everyone who can use it, but a task carries a prompt someone wrote and drives a
session private to them.

Admins see all, and bypass agent visibility as well as task ownership — checking
agent visibility first would hide every task on an agent the admin does not own,
which is most of them.

## Not built

- **Notifications.** carmel has no push channel. `lastOutcome` and the run log
  are what the user sees.
- **Shell tasks** (piclaw has them). An agent task with bash permission covers it
  without a second execution path.
- **Lease recovery.** A task whose run somehow never reaches `finalizeRun` holds
  its session's lease until restart, and subsequent firings skip as overlapping.
  The run guard closes the realistic paths; a lease TTL would close the rest.
