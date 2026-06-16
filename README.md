# Carmel Agent

Carmel Agent is a self-hosted, web-based multi-user harness for running Pi-powered agents. It gives you a shared control surface for useful chat, research, browsing, file work, coding, and other agent workflows while keeping each agent's tools and workspace explicit.

Run it on your own machine or server, add users, connect model providers, create agents for different jobs, and decide which agents or models should be shared with the rest of your team.

## What It Can Do

- **Chat and agent sessions** - keep persistent conversations, fork from earlier messages, edit user turns, pin sessions, and choose model/thinking settings per session.
- **Multi-user sharing** - users have their own login, provider credentials, sessions, agents, and model entries. Agents and model refs can be marked shared so other users can use them.
- **Container-based per-agent sandboxing** - when bash is enabled, commands run in a dedicated runner container for that agent, with CPU, memory, PID, mount, and network controls.
- **Agent Skills** - agents can load project skills from `.agents/skills` in their workspace and expose skill slash commands in the UI.
- **File tools and file management** - agents can read, search, write, and edit files according to their permissions. The web UI also includes a file explorer/editor scoped to the agent workspace.
- **Network access control** - network tools are only exposed to agents with the network permission. Search and fetch tools are available through Exa when `EXA_API_KEY` is configured.
- **Provider and model management** - connect OpenAI-compatible providers, OAuth-backed providers supported by Pi, and Ollama. Add model refs, choose default models, and share model refs.
- **Open WebUI import** - import Open WebUI JSON chat exports into the selected Carmel agent.

## Quick Self-Hosted Deployment

The recommended deployment uses rootless Podman and Compose. Carmel Agent itself runs as the web/API server; agent shell commands run in separate sandbox runner containers.

Requirements:

- Linux host with rootless Podman
- `podman compose`
- A running user Podman socket

Enable the Podman socket:

```sh
systemctl --user enable --now podman.socket
```

Build the server and sandbox runner images:

```sh
podman compose --profile build build
```

Start Carmel Agent:

```sh
podman compose up -d
```

Create your first login user:

```sh
CARMEL_PASSWORD='choose-a-long-password' \
  podman compose exec carmel-agent pnpm --filter @carmel-agent/server user:create --username admin
```

Open:

```text
http://localhost:8797
```

For production, set a stable `CARMEL_SECRET_KEY`, put the app behind HTTPS, and back up the `data/` directory. See [docs/deployment.md](docs/deployment.md) for the full deployment guide.

## First Setup

1. Log in with the user you created.
2. Go to settings and create a provider config with an API key, OAuth login, or an Ollama base URL.
3. Add one or more model refs from that provider.
4. Open or create an agent, choose its default model, system prompt, workspace, and permissions.
5. Start a session.

Agents start conservatively: file read/write/edit can be enabled separately from bash and network access. Bash is containerized when the sandbox is configured.

## Sharing

Carmel Agent is multi-user, but not everything is automatically shared.

- **Shared agents** are visible to other users. Their sessions remain per-user.
- **Shared model refs** are visible to other users. If a shared model is backed by a provider config, Carmel can use that config for runs, but other users do not see the stored secrets.
- **Provider configs and API keys** are per-user.

This lets one operator publish useful agents or model definitions without exposing every credential or conversation.

## Import From Open WebUI

Open the import dialog from the sidebar, choose an Open WebUI JSON export, and Carmel Agent will import the conversations into the selected agent using that agent's default model and thinking level.

The importer handles common Open WebUI export shapes, current conversation branches, user/assistant turns, image data URLs, model names, usage fields, and reasoning details when present. More details are in [docs/open-webui-import.md](docs/open-webui-import.md).

## Documentation

- [Deployment](docs/deployment.md) - Compose, manual containers, local development, reverse proxy notes, and production checklist.
- [Configuration](docs/configuration.md) - environment variables, secrets, provider setup, CORS, data paths, and sandbox settings.
- [Runtime And Security](docs/runtime-and-security.md) - agents, sessions, skills, tools, file access, network controls, sandbox internals, sharing, and migrations.
- [Open WebUI Import](docs/open-webui-import.md) - supported import format and behavior.

## Local Development

Requirements:

- Node.js 24
- pnpm 11

Install dependencies:

```sh
pnpm install
```

Create a local user:

```sh
pnpm --filter @carmel-agent/server user:create --username admin --password 'choose-a-long-password'
```

Run the API and web client:

```sh
pnpm dev
```

The API listens on `http://localhost:8797`; the Vite client listens on `http://localhost:5173`.

Useful scripts:

```sh
pnpm dev          # run API and client together
pnpm dev:server   # run only the API
pnpm dev:client   # run only the Vite client
pnpm build        # type-check and build all packages
pnpm lint         # run oxlint
pnpm test         # run server tests
pnpm check        # lint, test, and build
pnpm serve        # run the built server entrypoint
```

## Project Layout

- `packages/server` - Hono API, SQLite/Drizzle persistence, auth, runtime wiring, file APIs, provider/model/agent/session routes.
- `packages/client` - Vite + React UI for chat, settings, files, sessions, imports, and agent management.
- `packages/shared` - shared TypeScript types used by the client and server.
- `Dockerfile` - web/API server image.
- `Dockerfile.runner` - per-agent bash sandbox image.
- `compose.yaml` - rootless Podman Compose deployment.
- `data/` - default runtime state for SQLite, agent workspaces, and sandbox scratch data.

## License

Released under the [MIT License](LICENSE).
