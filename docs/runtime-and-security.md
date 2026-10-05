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

The first account is created in the browser on first run and is an administrator. The setup endpoint refuses to run once any account has a password or a linked single sign-on identity, so it cannot be reused to create more admins later.

### Single sign-on

With OpenID Connect configured, people can sign in through an external provider such as Pocket ID. Carmel uses the authorization code flow with PKCE, state, and nonce. Token and ID token validation is done by [openid-client](https://github.com/panva/openid-client). A sign-in that is started in one browser can only be finished in that same browser, and each attempt can be used only once. Once someone is signed in, they get the same session cookie as a password login.

An identity is linked to its account by issuer and `sub`. Username or email is used only once, to find the right account for a brand-new identity, and only when `CARMEL_OIDC_MATCH_BY` allows it. An email is used for matching only if the provider marks it verified. An account that is already linked is never picked by email, and a username match on an account linked to a different identity is refused. Refusals send the browser back to the login page with a fixed error code, and the page chooses the wording. A crafted link therefore cannot put its own text on the sign-in page. When `CARMEL_OIDC_ADMIN_GROUPS` is set, the provider's groups decide who is an administrator. Deleting a user also removes their linked identities.

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
- secrets supplied to its sandbox and configured MCP connections
- MCP server configuration and tool allowlists

The server runs Pi Durable with its native SQLite backend, streams committed events to the browser as NDJSON, and stores conversation history, live progress, and execution checkpoints through Pi. Each Carmel session has its own native storage and tool/credential registry. See [Pi Durable storage](pi-durable.md) for migration and recovery behavior.

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

- `read` enables read, grep, find, and list tools, and downloads in the web UI.
- `write` enables file creation/replacement, and create/upload/move/copy/delete in the web UI.
- `edit` enables patch-style edits, and edit/rename in the web UI.

The browser file manager is scoped to the selected agent's working directory and respects the same permissions.

Server-side file tools run on the host, but path access is guarded. The allowed roots are the workspace, the agent's private `/tmp`, and any configured extra mounts. Container paths such as `/workspace`, `/tmp`, and mount targets are translated back to host paths before the server touches them.

The file API blocks absolute-path escapes from the workspace. Text files larger than 4 MiB are not opened for editing; image previews are capped at 32 MiB.

Downloads stream from the same guarded roots: a single file is sent as-is, and a folder or multi-selection is packed into a zip as it streams, skipping anything that resolves outside the workspace and refusing a selection over 2 GiB or 20,000 entries. Uploads are one streamed request per file, capped at 2 GiB, written beside the target and renamed into place so a dropped connection cannot leave a half-written file; an existing name is refused unless the request asks to overwrite.

## Network Access

Network access is explicit per agent.

With the network permission:

- the sandbox container gets the runtime's default network
- `exa_search` is exposed and requires `EXA_API_KEY`
- `fetch_url` is exposed for URL fetching, and needs no key: it extracts page
  content locally with Defuddle rather than through a third-party API. Defuddle's
  site-specific extractors may make their own requests for a few hosts (a YouTube
  transcript, Reddit comments), so a `fetch_url` call is not always exactly one
  request to exactly the host asked for

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
- Bash, terminals, browser processes, and MCP servers run as the configured non-root host UID/GID. The Carmel server uses those same IDs so both sides can edit the mounted files.
- A private, persistent home is mounted at `/home/agent`. Global npm packages and the default Python virtual environment live there; installs do not need root. System package installation belongs in the runner image.
- Containers drop all capabilities, run with `no-new-privileges`, and apply memory, CPU, and PID limits.
- The server's environment and SQLite databases are never mounted into a runner.
- Runner containers are labeled `carmel.managed=1` and are removed on graceful shutdown and on startup.

Carmel talks to the container runtime over its Docker-compatible REST API on a unix socket, so it never needs a `podman` or `docker` CLI inside its own image. Rootless Podman uses `keep-id`; rootful Podman/Docker use an explicit numeric user without remapping. Rootless Docker and Docker with `userns-remap` are rejected. Startup checks the effective identity and mount access before running agent commands.

Rootless Podman is the recommended runtime. A rootful Docker socket also works, but whoever can reach that socket effectively controls the host, which is a poor fit for untrusted agent workloads.

If no socket is reachable, bash commands fail with a sandbox unavailable error. Every other tool keeps working.

## Web Terminal

The agent's runner container can be opened as an interactive shell in the
browser, from the terminal button in the session header.

- **Owner only.** A shared agent gives its other users a chat with the agent,
  not a shell. The terminal hands over the agent's whole environment with none
  of the redaction that covers agent-run output, so a user of a shared agent
  could otherwise read the owner's secrets with a single `echo`.
- **Requires the `bash` permission.** With bash off, no terminal is offered.
- **Same environment as the agent's own commands**, secrets included, so the
  terminal can be used to debug what the agent actually sees (`gh auth status`,
  `psql "$DATABASE_URL"`). Terminal output is *not* redacted: nothing here is
  persisted to a transcript or sent to a model, and rewriting a live PTY stream
  would corrupt the escape sequences the emulator depends on.
- **One shell per agent per user.** Two browser tabs on the same agent drive the
  same shell, like two windows on one tmux session.

### Sessions Outlive Tabs

The shell lives on the server, not in the tab, exactly as a run does. Reloading
the page reattaches to the shell that is already running and replays its recent
scrollback rather than dropping you at a fresh prompt. A shell nobody is
attached to is killed after a two-minute grace period.

While a terminal is attached, its container is exempt from the idle reaper --
otherwise a shell someone is reading rather than typing into would look exactly
like an abandoned container. Saving the agent's settings closes its terminals,
since permissions, mounts, and the working directory are all baked into a
running shell.

### Transport

The terminal is a WebSocket at `/api/terminal`, upgraded on the HTTP server
below the REST app -- which is why it is not in the OpenAPI contract that
describes the HTTP operations. It authenticates with the same session cookie as
the rest of the API and validates the request `Origin`, because a WebSocket
handshake is not covered by the CORS preflight that guards the REST routes.

Under the hood this is a hijacked `exec` against the container runtime's
Docker-compatible API, with a TTY attached. Terminals need the same container
socket as the bash sandbox: without one, the button reports that the sandbox is
unavailable.

## Shared Browser

The Browser button opens a live view beside the conversation, with an expanded
view and a full-width mobile layout. Users can take control, navigate, switch
tabs, click, scroll, type, or paste, then select **Resume agent**. The Keyboard
control provides text entry on mobile. Shift+Escape leaves the remote keyboard
surface. Closing the pane does not close Chromium.

Browser access requires visibility of the agent and its `bash` permission.
Unlike the owner-only terminal, a shared agent's browser is available to all
users who can use that agent. Its `carmel` browser session and persistent profile
at `/home/agent/.agent-browser/profile` belong to the **agent**, not a conversation
or a user. Signing in grants that agent and its shared users access to the account.
The agent's network permission still controls the runner's network access.

Control is an agent-wide, server-owned lease for one WebSocket connection.
Takeover closes admission to new agent tool calls, including entire codemode
batches, and waits for in-flight calls to finish before accepting human input.
Other viewers cannot send input or resume the agent. Disconnecting drops the
input lease while leaving automation paused; any authorized viewer can then
take control. The server persists the paused state and assistance reason outside
the agent's mounted directories. A server restart preserves the pause, but active
agent runs are interrupted under the normal server lifecycle; restarting a run
after that remains explicit.

Agents can call `request_browser_help` directly to ask for sign-in or verification.
Agents with both `bash` and `network` permission also receive Carmel's built-in
`agent-browser` skill. Its name and description appear in the model's skill
catalog; `load_builtin_skill` loads the full guide on demand without requiring
workspace read permission. Users can invoke it with `/skill:agent-browser`.
The guide is bundled at `packages/server/skills/agent-browser/SKILL.md` and teaches
CLI use, the shared profile, when to request help, and verification after resume.
The built-in takes precedence over a workspace skill with the same name. Other
workspace skills continue to load through the agent's normal filesystem authority.
This discovery rule does not remove the Browser pane or manual takeover for
agents that use bash to browse local pages without network permission.

The assistance tool waits without a provider call or the normal idle-run timeout, and returns a
fresh snapshot after the human resumes. Stale tool calls queued across a handoff
are not executed. Tools and subsequent provider requests wait behind the gate.
Foreground tool calls participate in this coordination; arbitrary background
automation or commands typed into the owner's terminal do not. This is a
collaboration mechanism, not an isolation boundary against sandbox code.

The browser transport is `/api/browser`, an authenticated WebSocket with origin,
agent visibility, and control checks. The server connects through a Docker exec
stdio bridge to the loopback-only agent-browser stream. No browser/CDP ports are
published. Input, frames, and console traffic are not stored in transcripts;
only explicit agent snapshots/tool output enter the conversation. Authentication
cookies remain available to the agent's sandbox as part of its profile.

Frames use acknowledgement pacing with a 15 FPS cap; hidden tabs stop acknowledging
frames until visible again. Open viewers and paused handoffs hold the runner
against idle reclamation. Carmel owns browser lifetime, so the runner disables
agent-browser's independent idle timer. Recreating the runner retains the profile,
but may lose open pages and unfinished forms.

Chromium's `SingletonLock`, `SingletonCookie`, and `SingletonSocket` links identify
a browser process in one container and must not carry over to its replacement.
Carmel removes those links inside each fresh sandbox before exposing it to tools,
leaving cookies and other profile files intact. Startup waits for old managed
containers to be removed first; an unconfirmed removal blocks replacement rather
than risking two browsers writing to the same profile. A container init process
reaps orphaned browser processes. Profile-lock errors in the Browser pane are
reported separately from missing or incompatible runner tooling.

The runner pins agent-browser 0.38.2. Rebuild `Dockerfile.runner` and restart the
application to replace old runner containers. To test streaming, remote sign-in,
and reconnect against an isolated real runner, build a test tag and run:

```bash
podman build -f Dockerfile.runner -t localhost/carmel-agent-runner:browser-test .
CARMEL_BROWSER_TEST_IMAGE=localhost/carmel-agent-runner:browser-test pnpm --filter @carmel-agent/server test:browser-sandbox
```

The integration test creates its own temporary agent and container, uses a local
fixture sign-in page, and verifies cookie retention and browser startup after
replacing a container with stale profile locks. It removes its resources afterward and never starts the
production scheduler or reaps other containers. `pnpm test:browser` covers the
pane, handoff, reload, navigation, and mobile accessibility without a container.

## Extra Mounts

An agent can declare extra mounts in its settings. Each mount has:

- `source` — host path
- `target` — optional container path; defaults to the source path
- `readOnly` — whether writes are blocked

Read-only mounts are available to read/search/list tools and to sandbox bash as read-only binds. Writable mounts are also available to write/edit tools.

## Agent Secrets

An agent can carry named secrets, which are exported as environment variables
into its sandbox container — a `GITHUB_TOKEN` for `gh`, a registry password for
`npm`, a database URL for `psql`.

Where they go, and where they do not:

- Secrets reach **sandbox commands and explicitly configured MCP connections**.
  MCP headers, environment variables, and arguments may reference `${NAME}`.
  They are not given to `fetch_url` or
  `exa_search`, are not substituted into the system prompt or prompt templates,
  and never enter model context except by way of something the agent itself runs.
- They are read per command rather than baked into the container at creation, so
  a rotated secret takes effect on the next command instead of when the idle
  reaper next recycles the container, and it never appears in `podman inspect`.
- Values are encrypted at rest with `CARMEL_SECRET_KEY`, the same mechanism that
  protects provider credentials. Without that key set they are stored in plain
  text in the database, as provider keys already are.

Names must be valid shell identifiers. Names the sandbox sets itself (`HOME`,
`PATH`, `TERM`, `LANG`) and names that redirect the shell or dynamic loader
(`BASH_ENV`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, and similar) are rejected, so a
secret cannot change which binaries a command resolves to.

### Reading And Writing

Secrets are **owner-only**, and the API is write-only: no endpoint returns a
value. The owner can add, replace, and delete a secret, and can see its name and
when it was last set. A stored value leaves the database only on its way into a
container or a configured MCP connection.

### Secrets On A Shared Agent

Secrets travel with the agent, exactly as its mounts do. If you share an agent
that has secrets, everyone who can run that agent runs commands with your
credentials in their environment — they cannot read the values through carmel,
but the agent they are driving can use them, and can be asked to print them.
Share an agent with secrets the way you would hand someone the credential.

### Output Redaction

Secret values are stripped from sandbox stdout and stderr before that output is
streamed to the browser or written into the session transcript, and are replaced
with `[redacted:NAME]`. This is what stops an `env`, a `set -x`, or a curl that
echoes its own headers from writing a live credential into a transcript that is
stored on disk and replayed into model context on every later turn.

It is a guard against accidents, not a containment boundary. An agent that has a
secret can always encode it, and redaction only covers the sandbox streams —
output the agent writes to a file and a *host-side* file tool then reads back is
not scanned. Values shorter than four characters are left alone, since matching
them would shred unrelated output.

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

Carmel uses a SQLite database for metadata and auth, plus one Pi Durable SQLite file per conversation in the `.durable` storage directory. The legacy Pi database remains a read-only migration archive. Drizzle manages only the Carmel database; its migrations run at startup and are recorded in `schema_migrations`.

New databases are created with the current schema; existing ones are upgraded through compatibility migrations. Session content is owned exclusively by Pi native storage.

Runtime state lives under `data/` by default:

- the metadata database, legacy Pi archive, and Durable storage directory
- default agent workspaces
- the Pi agent runtime directory
- per-agent sandbox `/tmp` directories

Back up that directory with the server stopped. See [Pi Durable storage](pi-durable.md) for upgrade and rollback details.
