# Carmel Agent

Carmel Agent is a self-hosted, multi-user web app for running AI agents. You bring your own model provider keys, and Carmel Agent gives you a chat interface where agents can read and write files, run shell commands in a container, browse the web, search your knowledge, and load your own skills.

It runs on your machine or your server. Agents contact the model providers, websites, and remote MCP servers you configure or permit.

## What You Get

- **Chat that keeps working.** Sessions persist and runs continue on the server; reopening a session reconnects to a run in progress.
- **Answers with the work tucked away.** Thinking, tool calls, and intermediate commentary fold under “Show work,” keeping final answers and errors visible.
- **Agents you shape.** Each agent has its own appearance, workspace, system prompt, prompt templates, default model, thinking level, and permissions for read, write, edit, bash, and network.
- **Sandboxed shell.** Bash runs in a per-agent container with CPU, memory, PID, mount, and network limits — not on your host shell.
- **A terminal in the browser.** Open an interactive shell into an agent's container with the same environment its commands get; reloads reattach to the running shell.
- **A workspace beside the conversation.** Files, Changes, Terminal, and Browser share a resizable pane, with Markdown previews and source editing, Mermaid diagrams, remembered layout, and a single-pane view on narrow windows.
- **A shared live browser.** Watch the agent browse, take control to sign in, then resume it in the same browser; the profile belongs to the agent.
- **Files in the browser.** Browse, edit, upload, download, move, copy, and delete workspace files under the agent's permissions.
- **Secrets and credentials.** Encrypted per-agent secrets for sandboxes and MCP connections, redacted from tool output, plus private forms for questions or session credentials that can be promoted later. See [Questions and session credentials](docs/user-requests.md).
- **Tools and MCP.** Connect remote HTTP or sandboxed stdio MCP servers with allowlists and credentials; codemode lets agents script their permitted tools in a sandboxed JavaScript worker. See [MCP tools](docs/mcp.md) and [Codemode](docs/codemode.md).
- **Private IM integrations.** Connect Telegram or Feishu/Lark, including QR setup, and receive private alerts from scheduled tasks. See [IM integrations](docs/im-integrations.md).
- **Skills and knowledge.** Skills in `.agents/skills` appear as slash commands, and agents can search and cite Markdown folders with keyword, semantic, or hybrid retrieval. See [Knowledge](docs/knowledge.md).
- **Tasks and schedules.** Queue work with discussion, live updates, and review, or schedule reminders and recurring runs from chat. See [Tasks](docs/issues.md) and [scheduled tasks](docs/runtime-and-security.md#scheduled-tasks-from-chat).
- **Agents, Home, and memory.** Each agent has a private Home conversation with fresh context and paged history; Home memory keeps private notes, recalls relevant topics, and supports opt-in learning and forgetting. See [Home memory](docs/home-memory.md).
- **Subtasks and collaboration.** Tasks can delegate read-only analysis or web research, and agents can consult or delegate to permitted peers. See [Agent collaboration](docs/agent-collaboration.md).
- **Conversation control.** Fork, edit, truncate, pin, attach images, reference files, folders, conversations, or agents with `@`, and search across sessions.
- **Multi-user with SSO.** Admins manage accounts and provider credentials; everyone gets private sessions, can share agents and model entries, and can sign in through Pocket ID or any OpenID Connect provider.
- **Your providers and API.** Anthropic, OpenAI, other Pi providers, OpenAI-compatible endpoints, and Ollama; create API keys for the OpenAI-compatible `/api/v1` endpoint. See [the API details](docs/configuration.md#openai-compatible-api).
- **Bring your history.** Import Open WebUI JSON chat exports into an agent.

## Requirements

- A Linux host (other hosts work if they can run the container images and expose a container socket).
- Rootless Podman (recommended), or rootful Podman/Docker without user namespace remapping. Rootless Docker and Docker with `userns-remap` are unsupported.
- Compose (`podman compose` or `docker compose`).

The container socket is only needed for the bash sandbox. Without it, Carmel still runs — chat, files, and network tools all work, and bash commands return a "sandbox unavailable" error.

## Quick Start

Download the Compose file. The server uses `ghcr.io/mudkipme/carmel-agent:latest`; agent commands use `ghcr.io/mudkipme/carmel-agent-runner:latest`.

```sh
mkdir carmel-agent
cd carmel-agent
curl -fsSLO https://raw.githubusercontent.com/mudkipme/carmel-agent/main/compose.yaml
systemctl --user enable --now podman.socket
```

Create the configuration once, as your normal non-root user:

```sh
umask 077
printf 'CARMEL_HOST_UID=%s\nCARMEL_HOST_GID=%s\nCARMEL_SECRET_KEY=%s\n' \
  "$(id -u)" "$(id -g)" "$(openssl rand -hex 32)" > .env
mkdir -p data
```

Keep `.env` and its secret key with your backups. Replacing the key makes existing encrypted credentials unreadable. Compose refuses to start without it.

Pull and start Carmel Agent:

```sh
podman compose pull
podman pull ghcr.io/mudkipme/carmel-agent-runner:latest
podman compose up -d
```

Open `http://localhost:8797` and create your administrator account on the welcome screen. That first account is created in the browser — no CLI step needed.

Using rootful Docker instead? Skip enabling the Podman socket, add these settings to `.env`, and use `docker compose` / `docker pull` for the commands above:

```sh
printf 'CARMEL_USERNS_MODE=host\nCARMEL_RUNTIME_SOCKET=/var/run/docker.sock\nCARMEL_SOCKET_GID=%s\n' \
  "$(stat -c %g /var/run/docker.sock)" >> .env
```

Keep these variables in your shell or Compose `.env`. The server and runners use your host UID/GID so workspace and home files retain your ownership. See the [upgrade notes](docs/deployment.md#upgrading-an-existing-deployment) for existing installations.

For HTTPS, backups, reverse proxies, release pinning, and building custom images, see [docs/deployment.md](docs/deployment.md). Published images currently target Linux amd64.

## First Steps After Login

1. Go to **Settings → Providers** and add a provider: an API key, an OAuth login, or an Ollama base URL. (Admins only — provider credentials belong to the instance, not to one person.)
2. In **Settings → Models**, add the models you want to use from that provider.
3. Open the default agent, or create a new one: give it a workspace, a system prompt, a default model, and its permissions.
4. Start a session.

New agents start with file read, write, and edit enabled; bash and network are off until you turn them on. Turning on bash requires the runner image and a reachable container socket.

Each agent has a **Knowledge** page for searchable Markdown sources, and **Memory** in Home keeps private notes. See [Knowledge](docs/knowledge.md) and [Home memory](docs/home-memory.md).

## Users And Sharing

Carmel is multi-user, and sharing is opt-in rather than automatic. Accounts are either administrator or user; admins manage users and provider credentials. Provider configs and their secrets are instance-level and never sent back to a browser. Model entries and agents belong to their creator and can be shared, while sessions always stay private — so one operator can hold the API keys and publish useful agents without exposing credentials or reading anyone's conversations.

## Import From Open WebUI

Select the agent you want the chats to land in, open the import dialog from the sidebar, and pick an Open WebUI JSON export. Conversations arrive using that agent's default model and thinking level. Details and supported export shapes: [docs/open-webui-import.md](docs/open-webui-import.md).

## Documentation

- [Deployment](docs/deployment.md) — Compose, manual containers, reverse proxies, and the production checklist.
- [Configuration](docs/configuration.md) — environment variables, secrets, provider setup, data paths, sandbox settings, and the OpenAI-compatible API.
- [Runtime And Security](docs/runtime-and-security.md) — how agents, tools, file access, sandboxing, roles, sharing, and scheduling actually work.
- [Tasks](docs/issues.md) — queueing work, review, and task lifecycle.
- [Agent collaboration](docs/agent-collaboration.md) — consultations, delegated tasks, and collaboration boundaries.
- [MCP tools](docs/mcp.md) — configure remote and sandboxed servers, tool access, and authentication.
- [Codemode](docs/codemode.md) — scripting permitted tools in a sandboxed JavaScript worker.
- [Knowledge](docs/knowledge.md) — source registration, indexing, and retrieval.
- [Home memory](docs/home-memory.md) — private notes, opt-in learning, recall, and forgetting.
- [IM integrations](docs/im-integrations.md) — Telegram and Feishu/Lark setup, commands, and notifications.
- [Questions and session credentials](docs/user-requests.md) — interactive questions, secret submission, and credential scope.
- [Open WebUI Import](docs/open-webui-import.md) — supported import format and behavior.
- [Pi Durable storage](docs/pi-durable.md) — session storage, recovery, replay, and streaming internals.

## Development

Requirements: Node.js 24 and pnpm 11.

```sh
pnpm install
pnpm dev
```

The API listens on `http://localhost:8797` and the Vite client on `http://localhost:5173`. Open the client and create your admin account on the welcome screen.

Useful scripts:

```sh
pnpm dev          # run API and client together
pnpm dev:server   # run only the API
pnpm dev:client   # run only the Vite client
pnpm build        # type-check and build all packages
pnpm format       # format files with oxfmt
pnpm format:check # check formatting without writing files
pnpm lint         # run oxlint
pnpm test         # run server and client tests
pnpm test:browser # browser regressions (requires agent-browser and its Chromium)
pnpm check        # check formatting, lint, test, and build
pnpm serve        # run the built server entrypoint
```

For sandboxed bash in development, pull the published runner image and make sure your container socket is reachable. To use a local build, set `CARMEL_BASH_IMAGE=localhost/carmel-agent-runner:latest` after building `Dockerfile.runner`.

Browser regressions use the `agent-browser` CLI (`npm install -g agent-browser@0.38.2`, then `agent-browser install --with-deps`). Set `AGENT_BROWSER_BIN` if the executable is outside your PATH. The suite builds the client and starts a fixture server on an ephemeral loopback port with an in-memory database, temporary data directory, and no schedulers or container socket. It does not use the running app or real provider credentials.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and test guidance, and [SECURITY.md](SECURITY.md) for private vulnerability reporting.

## Project Layout

- `packages/server` — Hono API, SQLite/Drizzle metadata, Pi Durable session storage, auth, agent runtime, sandbox, file APIs.
- `packages/client` — Vite + React UI for chat, files, settings, sessions, and agent management.
- `packages/shared` — TypeScript types shared by client and server.
- `Dockerfile` — web/API server image.
- `Dockerfile.runner` — per-agent bash sandbox image.
- `compose.yaml` — Compose deployment (written for rootless Podman).
- `data/` — runtime state: SQLite databases, agent workspaces, sandbox scratch space.

## License

Released under the [MIT License](LICENSE).
