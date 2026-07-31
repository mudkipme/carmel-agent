# Runtime And Security

This document describes how Carmel Agent runs agents, tools, sessions, file access, sharing, and the bash sandbox.

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

The server creates a Pi coding-agent session for each run, streams events to the browser as NDJSON, and persists messages to SQLite when the run ends.

Sessions belong to individual users. Users can fork a session from an earlier message, edit user messages, truncate a conversation, pin sessions, and import Open WebUI chats.

## Agent Skills

Agents load project skills from:

```text
<agent-workspace>/.agents/skills
```

Only skills under that workspace path are loaded. Global skill discovery is disabled. Skill commands and prompt commands are exposed to the web UI as slash commands.

Read tools are allowed to read the workspace and `.agents/skills` so agents can inspect their own skills.

## File Tools And File Management

Agent permissions decide which file tools are exposed:

- `read` enables read, grep, find, and list tools.
- `write` enables file creation/replacement and web UI create/delete operations.
- `edit` enables patch-style file edits and web UI edits/renames.

The browser file explorer/editor is scoped to the selected agent's working directory and respects the agent's read/write/edit permissions.

Server-side file tools run on the host, but path access is guarded. The allowed roots are the workspace, the agent's private `/tmp`, and any configured extra mounts. Container paths such as `/workspace`, `/tmp`, and mount targets are translated back to host paths before the server accesses them.

The file API prevents absolute-path escape from the workspace for browser file management. Text files larger than 4 MiB are not opened for editing; supported image previews are capped at 32 MiB.

## Network Access

Network access is explicit per agent.

When an agent has network permission:

- the sandbox runner container is created with normal rootless Podman networking
- `exa_search` is exposed and requires `EXA_API_KEY`
- `fetch_url` is exposed for URL fetching

When network permission is disabled:

- the sandbox runner container uses `NetworkMode=none`
- network tools are not exposed to the agent

## Bash Sandboxing

When bash permission is enabled, commands run inside a per-agent container instead of the server's host shell.

Key properties:

- Containers are created lazily on first command and reused across runs for the same agent.
- Idle containers are reaped after `CARMEL_BASH_IDLE_MINUTES`.
- The default workspace is mounted at `/workspace`.
- Manual workspaces are mounted at their absolute path so paths match between host file tools and sandbox bash.
- Each agent gets a private host-backed scratch directory mounted as `/tmp`.
- Extra mounts can be added per agent with source, optional target, and read-only flag.
- The container drops capabilities, uses `no-new-privileges`, and applies memory, CPU, and PID limits.
- The server's environment and SQLite database are not mounted into the runner.
- Runner containers are labeled `carmel.managed=1` and are removed on graceful shutdown or startup reap.

The intended container runtime is rootless Podman. Docker can work through its socket, but the Docker socket grants broad host control and is not recommended for untrusted workloads.

If no socket is reachable, bash commands fail with a sandbox unavailable error. Other tools are unaffected. `CARMEL_BASH_ALLOW_INSECURE=true` enables an in-process host bash fallback for local development only.

## Extra Mounts

An agent can declare extra mounts in settings. Each mount has:

- `source` - host path
- `target` - optional container path; defaults to the source path
- `readOnly` - whether writes are blocked

Read-only mounts are available to read/search/list tools and sandbox bash as read-only binds. Writable mounts are also available to write/edit tools.

## GPU Passthrough

Set `CARMEL_BASH_GPU` to one or more CDI device ids, such as:

```text
nvidia.com/gpu=all
```

This requires CDI to be configured on the host. CDI injects device nodes and driver libraries, but CUDA developer tools such as `nvcc` must exist in the runner image if the agent needs them.

## Sharing And Access

Users can see:

- agents they own
- agents marked shared
- model refs they own
- model refs marked shared
- model refs without a private provider config
- model refs attached to their own provider configs

Only owners can edit agent settings or delete their agents. Provider configs are per-user. Deleting a model or provider that is used by agents or sessions requires another visible fallback model for affected users.

When a shared model ref points at a provider config, Carmel uses that provider config server-side for model calls. Other users can select the shared model, but they do not receive the stored API key, OAuth credential, or custom headers in the UI/API payload.

## Database And Migrations

The server uses separate SQLite databases for Carmel metadata/auth and Pi-native session trees. Drizzle manages only the Carmel database; its migrations run on startup and record applied migrations in `schema_migrations`.

New Carmel databases are created with the current metadata schema. Existing databases are upgraded through compatibility migrations. Session content is owned exclusively by Pi native storage.

Runtime state is stored under `data/` by default, including:

- SQLite databases (Carmel metadata/auth and Pi-native session trees)
- default agent workspaces
- Pi agent runtime directory
- per-agent sandbox `/tmp` directories

Back up this directory for disaster recovery.
