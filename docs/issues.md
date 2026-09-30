# Issues

Issues delegate work to an agent and keep the brief, discussion, execution history, and review result together. The agent is the top level: there are no projects or agent teams to configure.

## Delegate and queue

Create an issue with a title and optional details, acceptance criteria, and priority. **Save to backlog** keeps it for later. **Queue work** adds it to the agent's durable queue and starts it when the agent is available.

An agent runs one issue at a time, including across users of a shared agent. Use the queue's up/down controls to reorder your jobs, or **Remove from queue** to return one to Backlog. Priority is descriptive; explicit queue order decides what runs next. Sharing an agent does not share issues, instructions, or conversations.

The sidebar groups issues into Working, Queued, Needs you, and Backlog. Completed and cancelled issues fold under Done. Needs you includes questions, reported obstacles, execution failures, and work awaiting review.

## Discuss and revise

An issue has one continuous Pi conversation by default. Replies, retries, and revision requests reuse it. **Start a fresh conversation for the next run** explicitly starts a new session; earlier conversations and results remain in Run history.

**Save note** stores context without starting work. Notes are included when the issue next runs. During a run, **Send update** uses Pi's public `AgentLane.steer()` API. The conversation shows whether an update is queued, delivered, or saved without delivery. Updates that miss the end of a run are retained as notes and removed from Pi's pending queue; they are not silently applied later.

**Stop run** ends execution. It does not suspend the process. Queue a retry to continue the conversation.

## Review results

The agent calls the issue's `report_issue` tool with a summary and concrete verification evidence. A successful `done` report moves the issue to In review. `needs_input` requests an answer, and `blocked` describes an obstacle. These states release the agent to start the next queued job.

A successful run without a report asks for input instead of entering review. Execution failures retain their error and expose a retry action; they do not manufacture an agent-reported Blocked verdict. Only **Accept result** marks work Done. **Request changes & queue** starts another run in the same conversation. Closed issues can be reopened without automatically executing them.

Each run saves bounded before/after versions of changed text files before releasing its queue slot. The review panel shows these saved versions, so later jobs cannot replace them. Captures cover the agent's workspace, honor read permission, skip symlinks and common credential/cache paths, and redact configured agent secrets. Binary, large, unreadable, or excluded files may not be included; partial capture is labeled. Captures are limited to 2,000 entries, 256 KiB per file, and 2 MiB per workspace read. Artifact links in the report remain ordinary links; workspace links open the current workspace.

Queue entries survive restarts. A run interrupted by a restart is recorded as interrupted and requires an explicit retry; remaining queued work continues automatically. Existing issues and conversations are preserved by the migration and are not automatically queued.

## API

- `POST /api/agents/:agentId/issues` creates a brief; `queue: true` also queues it.
- `POST /api/agents/:agentId/issues/:issueId/runs` queues instructions; `fresh: true` starts a new conversation.
- `POST /api/agents/:agentId/issues/:issueId/updates` steers an active run.
- `DELETE /api/agents/:agentId/issues/:issueId/queue` removes queued work.
- `POST /api/agents/:agentId/issues/:issueId/queue/move` accepts `direction: "up" | "down"`.

The shared OpenAPI document specifies request validators and response fields.
