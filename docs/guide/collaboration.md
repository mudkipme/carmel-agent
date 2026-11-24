# Agent collaboration

Agents can ask each other questions and hand each other work. A coding agent can consult a documentation agent; a planner can delegate an implementation task to a builder.

Every collaboration runs on behalf of the same person. Each agent keeps its own tools, permissions, and environment. Only the explicit request, the messages exchanged, and the reported result cross between them — conversation histories are never copied.

## Allow a connection

Collaboration is off until you allow it, one direction at a time. To let agent A call agent B, open **Agent Settings → Collaboration** on A and enable the capabilities you want for B:

| Capability                                  | What A can do                                                                                                                                                   |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Consultations**                           | Ask B bounded questions. B answers with read-only file and Knowledge tools only — no shell, browser, MCP, conversation search, or writes.                       |
| **Create tasks**                            | Create a backlog task assigned to B.                                                                                                                            |
| **Run tasks with this agent's permissions** | Also queue that task and send updates. Requires **Create tasks**. The task runs with B's file, shell, network, and MCP capabilities, including its credentials. |

Connections save immediately. To let B call A as well, configure A on B's settings. You must be able to use both agents, and only an agent's owner configures its outgoing connections. Sharing an agent does not enable collaboration by itself.

## Ask or delegate

Type `@`, or use **Mention a reference**, and pick a permitted collaborator to include them in your message. Then ask your agent to consult that peer or create and queue a task for it.

Agents also know their permitted collaborators — names, descriptions, and allowed operations — and can decide on their own to involve them.

- **Consultations** receive only the explicit question and the exchange that follows.
- **Delegated tasks** go through the receiving agent's normal [Tasks](/guide/tasks) queue, with its discussion, evidence, and review.

While waiting for a reply, the requesting conversation pauses and resumes automatically when the answer arrives. Agents can also start several collaborations in the background and wait for all of them. Replies that arrive when nothing is waiting are saved as notices in Home.

## Following and stopping

Conversations show collaboration status, requests, results, and links to the receiving conversation or task. Use **Stop** to cancel outstanding linked work.

- Stopping a task cancels the collaborations it started.
- Stopping Home leaves already-delegated tasks running.
- Cancelling keeps evidence and does not undo changes already made.

Reported task results stay **In review** until you accept them. The requesting agent can use a reported result right away; both tasks keep their own acceptance step.

## Limits

- Collaboration exchanges text. Copy the relevant context into the request.
- A session can have up to four outstanding collaborations.
- Delegation is one level deep: an agent receiving a collaboration cannot delegate further.

## Isolation

Isolation follows the environment. Agents in different environments only share what they explicitly send each other. Agents that share an [environment](/guide/workspace#sharing-an-environment-between-agents) also share its files, credentials, and browser — each works in its own folder but can read another's by path, which is often the simplest way to hand work over.

Deliberately passing information to another agent allows it to use that information through its own permitted capabilities.

## Tools

These tools appear when an agent has permitted collaborators. Handoff calls that wait for a reply must be made directly, not from Codemode.

| Tool                     | Purpose                                                               |
| ------------------------ | --------------------------------------------------------------------- |
| `list_collaborators`     | Refresh the list of permitted collaborators during a run.             |
| `ask_agent`              | Consult a collaborator. Waits for the reply unless `background=true`. |
| `delegate_task`          | Create, and optionally queue, a task for a collaborator.              |
| `wait_for_collaboration` | Wait for background collaborations to report.                         |
| `read_collaboration`     | Read a collaboration's exchange and exported result.                  |
| `cancel_collaboration`   | Cancel outstanding linked work.                                       |
| `send_agent_message`     | Send a follow-up (requester) or a clarification or reply (receiver).  |
