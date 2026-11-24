# Built-in tools

These are the tools Carmel Agent can offer an agent. Which ones appear in a run depends on the agent's permissions, its settings, and the kind of conversation. A tool that isn't available is never shown to the model.

[MCP servers](/guide/mcp) add more tools on top of these.

## Files and commands

| Tool                   | Available with   | Purpose                                                                                             |
| ---------------------- | ---------------- | --------------------------------------------------------------------------------------------------- |
| `read`                 | Read files       | Read text files and images.                                                                         |
| `grep`, `find`, `ls`   | Read files       | Search file contents, find files by name, and list folders.                                         |
| `write`                | Write files      | Create or replace a file.                                                                           |
| `edit`                 | Edit files       | Apply one or more exact text replacements to a file.                                                |
| `bash`                 | Run commands     | Run a command in the environment's [sandbox](/self-hosting/sandbox).                                |
| `request_browser_help` | Run commands     | Ask you to take over the [shared browser](/guide/workspace#shared-browser), for example to sign in. |
| `codemode`             | Codemode enabled | Run a JavaScript program that calls the agent's other tools. See [Codemode](/guide/codemode).       |

File tools are confined to the working folder, the environment's `/tmp` and `/home/agent`, and its mounts.

## Web

| Tool         | Available with                        | Purpose                                                                                    |
| ------------ | ------------------------------------- | ------------------------------------------------------------------------------------------ |
| `fetch_url`  | Web access                            | Fetch a URL. Returns the page's main content as Markdown by default, or raw `html`/`text`. |
| `exa_search` | Web access and a server `EXA_API_KEY` | Search the web with Exa.                                                                   |

## Knowledge and history

| Tool                 | Available when                           | Purpose                                                                            |
| -------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------- |
| `knowledge_search`   | Knowledge is enabled, Read files         | Search registered documents. See [Knowledge](/guide/knowledge).                    |
| `knowledge_read`     | Knowledge is enabled, Read files         | Read and cite a passage from a current source document.                            |
| `session_search`     | Always (not for collaboration receivers) | Search your earlier conversations with this agent by keyword and time range.       |
| `session_read`       | Always (not for collaboration receivers) | Read a page of text from one of your conversations with this agent.                |
| `load_builtin_skill` | A built-in skill applies                 | Load a [built-in skill](/guide/skills-and-templates#built-in-skills)'s full guide. |

## Asking you

| Tool                | Available with                                    | Purpose                                                                                                      |
| ------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `ask_user_question` | Interactive sessions                              | Ask a question with choices or free text. See [Questions and credentials](/guide/questions-and-credentials). |
| `request_secret`    | Run commands                                      | Ask for a credential through a private form.                                                                 |
| `promote_secret`    | Run commands                                      | Make a session credential available to future sessions in the environment.                                   |
| `send_user_message` | An enabled [messaging app](/guide/messaging-apps) | Send you a message, for example from a scheduled task.                                                       |

## Schedules

Available in conversations you start, including Home, messaging apps, and Codemode. Not available to scheduled runs or collaboration receivers.

| Tool                    | Purpose                                  |
| ----------------------- | ---------------------------------------- |
| `schedule_task`         | Create a one-time or recurring schedule. |
| `list_scheduled_tasks`  | List your schedules for this agent.      |
| `update_scheduled_task` | Edit, pause, or resume a schedule.       |
| `delete_scheduled_task` | Delete a schedule and its history.       |

See [Schedules](/guide/schedules).

## Tasks

| Tool               | Available in | Purpose                                                          |
| ------------------ | ------------ | ---------------------------------------------------------------- |
| `create_task`      | Home         | Create a task, optionally queuing it.                            |
| `list_tasks`       | Home         | List your tasks with this agent, with queue and review state.    |
| `read_task`        | Home         | Read a task's brief, discussion, results, and evidence.          |
| `queue_task`       | Home         | Queue or retry a task.                                           |
| `update_task`      | Home         | Revise an idle task's brief or criteria.                         |
| `send_task_update` | Home         | Steer a running task, or save a note for its next run.           |
| `stop_task`        | Home         | Stop a task's current run or remove it from the queue.           |
| `report_task`      | Task runs    | Report a result as done, needs input, or blocked, with evidence. |

See [Tasks](/guide/tasks).

## Subtasks

Available in tasks and ordinary working conversations.

| Tool                  | Purpose                                           |
| --------------------- | ------------------------------------------------- |
| `start_subtask`       | Start read-only research in a child conversation. |
| `list_subtasks`       | List subtasks and their state.                    |
| `send_subtask_update` | Steer a running subtask.                          |
| `wait_subtask`        | Wait for a background subtask's result.           |
| `stop_subtask`        | Stop a subtask.                                   |

## Home memory

Available only in [Home](/guide/home-and-memory).

| Tool            | Purpose                                                           |
| --------------- | ----------------------------------------------------------------- |
| `memory_search` | Search memory notes.                                              |
| `memory_read`   | Read a note or topic.                                             |
| `memory_save`   | Save a note, optionally with an expiry or replacing an older one. |
| `memory_edit`   | Edit a note.                                                      |
| `memory_forget` | Forget matching notes.                                            |

## Collaboration

Available when the agent has [permitted collaborators](/guide/collaboration).

| Tool                     | Purpose                                                 |
| ------------------------ | ------------------------------------------------------- |
| `list_collaborators`     | Refresh the list of permitted collaborators.            |
| `ask_agent`              | Consult another agent.                                  |
| `delegate_task`          | Create, and optionally queue, a task for another agent. |
| `wait_for_collaboration` | Wait for background collaborations.                     |
| `read_collaboration`     | Read a collaboration's messages or result.              |
| `send_agent_message`     | Send a follow-up or reply within a collaboration.       |
| `cancel_collaboration`   | Cancel outstanding linked work.                         |
