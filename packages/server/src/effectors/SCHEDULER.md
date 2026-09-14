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

**Every run gets a session of its own.** Tasks used to append every run to one
session, for the prompt cache, but the cache lives an hour at most: a daily task
started cold anyway while paying for an ever-longer context. The system prompt
and tools are the same across runs, so that prefix still caches for frequent
tasks. A fresh session also keeps one bad run from steering the next, and makes
each result readable on its own.

A run's session carries the task's id (`sessions.task_id`), which keeps it out
of the session list, and the run log links to it (`agent_task_runs.session_id`).
The run history under the agent's Tasks settings is where runs are opened. A run
worth keeping is moved to the session list, which clears the task id; forks of a
run join the list too. Deleting a task deletes the sessions of its runs, except
the ones moved to the list.

The session is created only once the model resolves, so a task that cannot run
logs a failure without leaving an empty session behind every time it fires.

## Firing

`startDetachedAgentRun` — the same path an interactive run takes, minus the SSE
stream. Scheduled runs therefore inherit the run guard, compaction and context
recovery, the failure classifier, extension tools, and branch integrity without
any of it existing twice. Unattended runs are where the guard matters most.

A poll loop, not a timer per task: tasks are edited, paused and deleted from
under it, and one "active and due" query is self-correcting after a restart.

Three things the loop protects against, each with a test:

- **Overlap.** A task never has two firings at once: the scheduler tracks which
  tasks are running, and "run now" on a running task is skipped. A person
  replying in an earlier run's session does not block the next one, since it is
  a different session.
- **Starvation.** Due tasks are ordered most-overdue-first, because the tick has
  a concurrency cap (default 2, `CARMEL_AGENT_MAX_CONCURRENT_TASKS`). In table
  order, one permanently-due task would hold a slot forever. This was found by a
  test failing for the wrong reason, which is the only reason it is here.
- **Re-arm drift.** The next run is computed from `max(scheduledFor, now)`. From
  the occurrence alone, a run outlasting its own interval comes back due the
  instant it finishes; from the clock alone, a one-shot whose instant is still a
  second away re-arms instead of completing.

## Outcomes

A run's outcome is the run's own verdict, not "it returned". Runs report
failures into the transcript instead of throwing, and a provider rejection never
throws at all, so the runtime collects how a run ended (`effectors/run-outcome.ts`)
and `whenRunFinished` returns it: `succeeded`, `failed` (provider error, thrown
error, run-guard stop, or a result that could not be saved), `cancelled` (a
person pressed stop) or `interrupted` (shutdown). The same result travels on the
chat stream's `run_finished` event. The run log and `lastOutcome`/`lastError`
record it with its reason; `missed` and `skipped` are firings that never ran.

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
- **Lease recovery.** A run that somehow never reaches `finalizeRun` holds its
  session's lease until restart, and the task stays marked running in-process,
  so later firings wait. The run guard closes the realistic paths; a lease TTL
  would close the rest. A run is logged as `running` when it starts, and rows
  still `running` at scheduler start are marked failed.
- **Retention.** Run sessions accumulate. Keeping the last N per task, and
  paging the run history past its 50 most recent runs, are the next steps.
