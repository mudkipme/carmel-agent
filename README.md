# Carmel Agent

Carmel Agent is a self-hosted, multi-user web app for running AI agents. You bring your own model provider keys, and Carmel Agent gives you a chat interface where agents can read and write files, run shell commands in a container, browse the web, and load your own skills.

It runs on your machine or your server. Agents contact the model providers, websites, and remote MCP servers you configure or permit.

## What You Get

- **Chat with agents that keep working.** Sessions persist, runs continue on the server if you close the tab, and reopening a session reconnects to a run in progress.
- **Answers with the work tucked away.** Sessions fold thinking, tool calls and intermediate commentary under a “Show work” row, keeping the final answer and errors visible.
- **Agents you shape.** Each agent has its own workspace, system prompt, prompt templates, default model, thinking level, and permissions for read, write, edit, bash, and network.
- **Sandboxed shell.** When an agent is allowed to run commands, they execute in a per-agent container with CPU, memory, PID, mount, and network limits — not on your host shell.
- **A terminal in the browser.** Open an interactive shell straight into an agent's container, with the same environment its own commands get. The shell lives on the server, so a reload reattaches instead of starting over.
- **Files in the browser.** A full file manager for an agent's workspace: browse, edit, upload (drag and drop, including folders), download files or a folder as a zip, and select several entries to move, copy, or delete — all under the same permissions the agent has.
- **Per-agent secrets.** Give an agent a `GITHUB_TOKEN` or a registry password; it is encrypted at rest, available to that agent's sandbox and configured MCP connections, and redacted out of tool output.
- **MCP tools.** Connect each agent to remote HTTP servers or stdio servers inside its sandbox, with tool allowlists and credentials from agent secrets.
- **Your own skills.** Drop skills into `.agents/skills` in an agent's workspace and they show up as slash commands in the chat.
- **Conversation control.** Fork a session from any earlier message, edit your own messages, truncate a branch, pin the sessions you keep coming back to, attach images.
- **Multiple people, one instance.** Admins manage provider credentials and accounts; everyone gets their own sessions and can share agents and model entries with the rest of the instance.
- **Single sign-on.** Sign in with Pocket ID or any other OpenID Connect provider. You can link people to existing accounts by username or email, and use provider groups to decide who may sign in and who is an admin.
- **Your providers.** Anthropic, OpenAI, and other providers supported by Pi (API key or OAuth login), any OpenAI-compatible endpoint, and local Ollama.
- **Bring your history.** Import Open WebUI JSON chat exports into an agent.

## Requirements

- A Linux host (other hosts work if they can run the container images and expose a container socket).
- A container runtime with a Docker-compatible API socket — Podman or Docker both work. Rootless Podman is recommended.
- Compose (`podman compose` or `docker compose`).

The container socket is only needed for the bash sandbox. Without it, Carmel still runs — chat, files, and network tools all work, and bash commands return a "sandbox unavailable" error.

## Quick Start

Clone the repo, then build the server and sandbox runner images:

```sh
podman compose --profile build build
```

Start Carmel Agent:

```sh
podman compose up -d
```

Open `http://localhost:8797` and create your administrator account on the welcome screen. That first account is created in the browser — no CLI step needed.

Using Docker instead? The compose file is written for the rootless Podman socket, so point the socket bind mount at Docker's socket and use `docker compose` for the two commands above:

```yaml
    volumes:
      - ./data:/data
      - /var/run/docker.sock:/run/podman/podman.sock
```

For anything beyond a local trial — a stable secret key, HTTPS, backups, reverse proxies — see [docs/deployment.md](docs/deployment.md).

## First Steps After Login

1. Go to **Settings → Providers** and add a provider: an API key, an OAuth login, or an Ollama base URL. (Admins only — provider credentials belong to the instance, not to one person.)
2. In **Settings → Models**, add the models you want to use from that provider.
3. Open the default agent, or create a new one: give it a workspace, a system prompt, a default model, and its permissions.
4. Start a session.

New agents start with file read, write, and edit enabled; bash and network are off until you turn them on. Turning on bash requires the runner image and a reachable container socket.

## Users And Sharing

Carmel is multi-user, and sharing is opt-in rather than automatic.

- **Accounts** come in two roles. Admins manage users and provider credentials; everyone else uses what's been set up.
- **Provider configs and their secrets** are instance-level and admin-managed. Stored keys and OAuth credentials are never sent back to any browser.
- **Model entries** belong to the person who created them. Mark one shared and everyone can select it — the underlying credentials stay on the server.
- **Agents** belong to their owner. Mark one shared and others can use it; their sessions with it stay private to them.
- **Sessions** are always private to the user who created them.

So one operator can hold the API keys and publish a set of useful agents without exposing credentials or reading anyone's conversations.

## Import From Open WebUI

Select the agent you want the chats to land in, open the import dialog from the sidebar, and pick an Open WebUI JSON export. Conversations arrive using that agent's default model and thinking level. Details and supported export shapes: [docs/open-webui-import.md](docs/open-webui-import.md).

## Documentation

- [Deployment](docs/deployment.md) — Compose, manual containers, reverse proxies, and the production checklist.
- [Configuration](docs/configuration.md) — environment variables, secrets, provider setup, data paths, and sandbox settings.
- [Runtime And Security](docs/runtime-and-security.md) — how agents, tools, file access, sandboxing, roles, and sharing actually work.
- [MCP tools](docs/mcp.md) — configure remote and sandboxed servers, tool access, and authentication.
- [Open WebUI Import](docs/open-webui-import.md) — supported import format and behavior.

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
pnpm lint         # run oxlint
pnpm test         # run server and client tests
pnpm check        # lint, test, and build
pnpm serve        # run the built server entrypoint
```

For sandboxed bash in development, build the runner image (`podman build -f Dockerfile.runner -t carmel-agent-runner:latest .`) and make sure your container socket is reachable.

## Project Layout

- `packages/server` — Hono API, SQLite/Drizzle metadata, Pi-native session storage, auth, agent runtime, sandbox, file APIs.
- `packages/client` — Vite + React UI for chat, files, settings, sessions, and agent management.
- `packages/shared` — TypeScript types shared by client and server.
- `Dockerfile` — web/API server image.
- `Dockerfile.runner` — per-agent bash sandbox image.
- `compose.yaml` — Compose deployment (written for rootless Podman).
- `data/` — runtime state: SQLite databases, agent workspaces, sandbox scratch space.

## License

Released under the [MIT License](LICENSE).
