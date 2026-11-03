# Agent collaboration

An agent can ask another agent a question or delegate a task to it. Requests run for the same user. Each agent keeps its own workspace, tools, credentials, and sandbox; only the explicit request, messages, and reported result cross the connection.

## Enable a connection

To let A call B, open **Agent Settings → Collaboration** on A and enable the desired capabilities for B. That is the only configuration required for A → B. To also let B call A, configure A on B separately. The user must be able to use both agents.

- **Consultations** allow bounded questions with read-only file and knowledge tools. Shell, browser, MCP, private conversation search, and write tools are excluded.
- **Create tasks** allows creating a backlog task assigned to the other agent.
- **Run tasks with this agent's permissions** also allows queueing work and sending execution updates. Enable Create tasks as well. The task uses the receiver's configured file, shell, network, and MCP capabilities, including its credentials.

Connections save immediately. Owners configure their agent's outgoing connections. Sharing an agent alone does not enable collaboration. Previous incoming consent settings are no longer used; outgoing settings decide each direction.

## Ask or delegate

Ask your agent to consult a permitted peer, or have it create and queue a task for that peer. Permitted agents appear in the system prompt with their names, descriptions, IDs, and allowed operations, so the agent can recognize useful collaborators and call `ask_agent` or `delegate_task` directly. The catalog refreshes at the start of each run; `list_collaborators` can refresh it during a run. A receiving agent can send questions and replies through `send_agent_message`; it cannot delegate further.

Consultations receive only the explicit question and the collaboration exchange. Private conversation history is excluded from both consultations and delegated task tools. For substantial work, delegation uses the receiver's existing Tasks queue, discussion, evidence, and review controls. Agents can inspect their collaboration's exported results but cannot list the receiver's other tasks through collaboration tools.

A normal `ask_agent` call yields the current run and resumes the same conversation when the reply is pushed, including Home. Queueing a delegated task and sending a requester follow-up also yield by default. Task queue slots are released automatically; no separate `report_task(waiting)` call is needed. These handoff tools must be called directly, outside Codemode, with a yielding call alone in its turn.

Use `background=true` to launch parallel collaborations or do independent work, then call `wait_for_collaboration` to yield. Never poll status or use shell sleep loops to wait. A result arriving before the source finishes is retained. Replies without a registered wait are saved as notices in Home. Stopped Home retains replies without waking the model.

Reported task results remain **In review** until you accept them. A requesting agent can use a reported result without accepting the receiving task. Both tasks retain their own acceptance step.

Conversations show collaboration status, requests, results, and links to the receiving conversation or task. Use **Stop** to cancel outstanding linked work. Stopping a source task cancels its outstanding delegations; stopping Home leaves already delegated tasks running. Cancellation retains evidence and does not undo changes already made.

## Current boundaries

The first version exchanges text. Copy relevant context into the request; file transfer through shared artifact snapshots is a later addition. Up to four outstanding collaborations can originate from one session, and delegation has one level.

Isolation remains per agent. Its sessions share that agent's workspace and browser profile, and configured overlapping mounts remain shared. Deliberately passing information to another agent allows it to use that information through its permitted capabilities. Credentials and histories are never automatically copied between agents.
