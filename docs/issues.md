# Tasks

Tasks delegate work to an agent and keep the brief, discussion, execution history, and review result together. The agent is the top level: there are no projects or agent teams to configure.

## Delegate and queue

Create a task with a title and optional details, acceptance criteria, and priority. **Save to backlog** keeps it for later. **Queue work** adds it to the agent's durable queue and starts it when the agent is available.

An agent runs one task at a time, including across users of a shared agent. Use the queue's up/down controls to reorder your jobs, or **Remove from queue** to return one to Backlog. Priority is descriptive; explicit queue order decides what runs next. Sharing an agent does not share tasks, instructions, or conversations.

Open **Tasks** beside **Schedules** in the agent navigation. The task list provides Queue, Needs you, Backlog, and Done views; the sidebar keeps your sessions available. Needs you includes questions, reported obstacles, execution failures, and work awaiting review.

## Discuss and revise

A task has one continuous Pi conversation by default. Replies, retries, and revision requests reuse it. **Start a fresh conversation for the next run** explicitly starts a new session; earlier conversations and results remain in Run history.

**Save note** stores context without starting work. Notes are included when the task next runs. During a run, **Send update** uses Pi Durable steering submissions. The conversation shows whether an update is queued, delivered, or saved without delivery. Updates that miss the end of a run are retained as notes and removed from Pi's pending queue; they are not silently applied later.

**Stop run** ends execution. It does not suspend the process. Queue a retry to continue the conversation.

## Review results

The agent calls the task's `report_task` tool with a summary and concrete verification evidence. A successful `done` report moves the task to In review. `needs_input` requests an answer, and `blocked` describes an obstacle. These states release the agent to start the next queued job.

A successful run without a report asks for input instead of entering review. Execution failures retain their error and expose a retry action; they do not manufacture an agent-reported Blocked verdict. Only **Accept result** marks work Done. **Request changes & queue** starts another run in the same conversation. Closed tasks can be reopened without automatically executing them.

Each run saves bounded before/after versions of changed text files before releasing its queue slot. The review panel shows these saved versions, so later jobs cannot replace them. Captures cover the agent's workspace, honor read permission, skip symlinks and common credential/cache paths, and redact configured agent secrets. Binary, large, unreadable, or excluded files may not be included; partial capture is labeled. Captures are limited to 2,000 entries, 256 KiB per file, and 2 MiB per workspace read. Artifact links in the report remain ordinary links; workspace links open the current workspace.

Queue entries survive restarts. A run interrupted by a restart is recorded as interrupted and requires an explicit retry; remaining queued work continues automatically.

## API

Task HTTP endpoints retain their existing `/issues` paths for compatibility; task pages use `/agents/:agentId/tasks`. The existing `/api/agents/:agentId/tasks` endpoints continue to manage schedules.

- `POST /api/agents/:agentId/issues` creates a brief; `queue: true` also queues it.
- `POST /api/agents/:agentId/issues/:issueId/runs` queues instructions; `fresh: true` starts a new conversation.
- `POST /api/agents/:agentId/issues/:issueId/updates` steers an active run.
- `DELETE /api/agents/:agentId/issues/:issueId/queue` removes queued work.
- `POST /api/agents/:agentId/issues/:issueId/queue/move` accepts `direction: "up" | "down"`.

The shared OpenAPI document specifies request validators and response fields.

## Home

Ask an agent in Home to create or queue a task, revise an idle brief, add notes, send an update, change queue order, or stop a selected attempt. Home remains available while the task runs. Results and requests for attention return to your private Home with a link to the task and its evidence. Reported completion still requires **Accept result**.

External result notifications require a requested `notifyPlatform` on the task. Ordinary web discussion does not broadcast to messaging channels. Stopping Home pauses automated replies while preserving incoming result notices and continuing task jobs.

## Subtasks

Tasks can delegate bounded read-only research with `start_subtask`. Use `background=true` for independent questions that can run in parallel, then `wait_subtask` to collect each result before `report_task` reports completion. Subtasks have separate native Pi Durable context and keep their evidence in the parent task. Inspect them inline in the task detail page; stopping the parent task also stops its subtasks. Home receives the parent result rather than a separate report for every subtask.

Home should create a task before multi-step investigation, implementation, or broad verification. Its smaller context budget is a maintenance threshold that can summarize earlier context during one long run. Task runs use the ordinary model-window compaction policy.
