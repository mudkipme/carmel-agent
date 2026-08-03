# Runtime And Security

How Carmel Agent runs agents, tools, sessions, file access, accounts, and the bash sandbox.

## Accounts And Roles

Every account is either an **administrator** or a regular **user**.

Administrators can:

- create, delete, and manage accounts, including role changes and password resets
- create, edit, and delete the instance's provider configs and their credentials

Everyone can:

- create agents, model entries, and sessions
- use any agent or model entry that is shared with the instance
- change their own name, password, theme, and fast task model

The first account is created in the browser on first run and is an administrator. The setup endpoint refuses to run once any account has a password, so it cannot be reused to create more admins later.

## Runtime Model

An agent stores:

- owner and sharing state
- name and description
- workspace mode and path
- optional extra mounts
- system prompt
- prompt templates
- default model and thinking level
- permissions for read, write, edit, bash, and network

The server creates a Pi coding-agent session for each run, streams events to the browser as NDJSON, and persists messages when the run ends.

Runs live on the server, not in the tab. Each event carries a sequence number, so a browser that reloads or reconnects resumes the stream from where it left off instead of losing the run. Runs can be aborted explicitly.

While a session has an active run, changes that would pull the ground out from under it are rejected with a conflict response: deleting or editing the model entry, provider config, agent, or user account that run depends on.

Sessions belong to individual users. Users can fork a session from an earlier message, edit their own messages, truncate a conversation, pin sessions, attach images, and import Open WebUI chats.

## Agent Skills

Agents load project skills from:

```text
<agent-workspace>/.agents/skills
```

Only skills under that workspace path are loaded — global skill discovery is disabled. Skill commands and prompt templates are exposed to the web UI as slash commands.

Read tools are allowed to read the workspace and `.agents/skills`, so agents can inspect their own skills.

## File Tools And File Management

Agent permissions decide which file tools exist for a run:

- `read` enables read, grep, find, and list tools.
- `write` enables file creation/replacement, and create/delete in the web UI.
- `edit` enables patch-style edits, and edit/rename in the web UI.

The browser file explorer is scoped to the selected agent's working directory and respects the same permissions.

Server-side file tools run on the host, but path access is guarded. The allowed roots are the workspace, the agent's private `/tmp`, and any configured extra mounts. Container paths such as `/workspace`, `/tmp`, and mount targets are translated back to host paths before the server touches them.

The file API blocks absolute-path escapes from the workspace. Text files larger than 4 MiB are not opened for editing; image previews are capped at 32 MiB.

## Network Access

Network access is explicit per agent.

With the network permission:

- the sandbox container gets the runtime's default network
- `exa_search` is exposed and requires `EXA_API_KEY`
- `fetch_url` is exposed for URL fetching

Without it:

- the sandbox container is created with `NetworkMode: none`
- no network tools are exposed to the agent

## Bash Sandboxing

When the bash permission is on, commands run inside a per-agent container instead of the server's host shell.

Key properties:

- Containers are created lazily on the first command and reused across runs for the same agent.
- Idle containers are reaped after `CARMEL_BASH_IDLE_MINUTES`.
- The default workspace is mounted at `/workspace`. Manual workspaces are mounted at their absolute path, so paths match between host file tools and sandbox bash.
- Each agent gets a private host-backed scratch directory mounted as `/tmp`.
- Extra mounts can be added per agent with source, optional target, and read-only flag.
- Containers drop all capabilities, run with `no-new-privileges`, and apply memory, CPU, and PID limits.
- The server's environment and SQLite databases are never mounted into a runner.
- Runner containers are labeled `carmel.managed=1` and are removed on graceful shutdown and on startup.

Carmel talks to the container runtime over its Docker-compatible REST API on a unix socket, so it never needs a `podman` or `docker` CLI inside its own image. Podman and Docker both work.

Rootless Podman is the recommended runtime. A rootful Docker socket also works, but whoever can reach that socket effectively controls the host, which is a poor fit for untrusted agent workloads.

If no socket is reachable, bash commands fail with a sandbox unavailable error. Every other tool keeps working.

## Extra Mounts

An agent can declare extra mounts in its settings. Each mount has:

- `source` — host path
- `target` — optional container path; defaults to the source path
- `readOnly` — whether writes are blocked

Read-only mounts are available to read/search/list tools and to sandbox bash as read-only binds. Writable mounts are also available to write/edit tools.

## GPU Passthrough

Set `CARMEL_BASH_GPU` to one or more CDI device ids, such as:

```text
nvidia.com/gpu=all
```

This requires CDI to be configured on the host. CDI injects device nodes and driver libraries, but CUDA developer tools such as `nvcc` must exist in the runner image if an agent needs them.

## Sharing And Access

Users can see:

- agents they own, and agents marked shared
- model entries they own, model entries marked shared, and model entries with no provider config behind them

Only owners can edit or delete their own agents and model entries. Provider configs are instance-level and only administrators can change them; their stored API keys, OAuth credentials, and custom headers are never included in API responses.

Deleting a model entry or provider config that agents or sessions depend on requires another usable fallback model for the affected users, and is refused while a run using it is in flight.

## Credentials At Rest

Provider API keys, OAuth credentials, and custom headers are encrypted with `CARMEL_SECRET_KEY` before they are written to the database. Set that key before adding credentials and keep it stable — rotating it makes existing secrets unreadable.

## Database And Migrations

Carmel uses two SQLite databases: one for Carmel metadata and auth, one for Pi-native session trees. Drizzle manages only the Carmel database; its migrations run at startup and are recorded in `schema_migrations`.

New databases are created with the current schema; existing ones are upgraded through compatibility migrations. Session content is owned exclusively by Pi native storage.

Runtime state lives under `data/` by default:

- the two SQLite databases
- default agent workspaces
- the Pi agent runtime directory
- per-agent sandbox `/tmp` directories

Back up that directory.
