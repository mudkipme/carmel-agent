# Carmel Agent

Carmel Agent is a local agent harness for coding and research workflows. It wraps the `@earendil-works/pi-*` runtime with a SQLite-backed API, a React control surface, configurable models/providers, per-agent workspaces, sessions, skills, and a file editor.

## Project Layout

- `packages/server` - Hono API, SQLite/Drizzle persistence, auth, agent runtime wiring, file APIs, provider/model/agent/session routes.
- `packages/client` - Vite + React UI with the chat harness, settings dialogs, file explorer, and Monaco editor.
- `packages/shared` - shared TypeScript types used by the client and server.
- `data/` - default local data directory for SQLite and per-agent workspaces. This directory is runtime state, not source.

## Requirements

- Node.js 24
- pnpm 11

## Setup

Install dependencies:

```sh
pnpm install
```

Create a login user:

```sh
pnpm --filter @carmel-agent/server user:create
```

Start both API and web client:

```sh
pnpm dev
```

The API listens on `http://localhost:8797` by default. The Vite client listens on `http://localhost:5173`.

## Configuration

Useful environment variables:

- `DATABASE_URL` - SQLite path. Defaults to `data/carmel-agent.sqlite`.
- `CARMEL_AGENT_DATA_DIR` - base data directory used for the database and default agent workspaces.
- `CARMEL_AGENT_DIR` - agent runtime directory. Defaults to `data/pi-agent`.
- `CARMEL_SECRET_KEY` - optional secret used to encrypt stored provider API keys, OAuth credentials, and custom headers at rest. Keep it stable once configured.
- `CARMEL_ALLOWED_ORIGINS` - comma-separated additional browser origins allowed to make mutating API requests with cookies.
- `CARMEL_TRUSTED_PROXY` - comma-separated IPs of trusted reverse proxies (e.g. `192.168.1.3`). `X-Forwarded-For` is honoured for the login rate limiter only when the connection comes from one of these addresses; otherwise the unspoofable socket address is used.
- `EXA_API_KEY` - enables the `exa_search` server tool when an agent has network permission.
- `HOST` - API bind host. Defaults to `127.0.0.1`; Docker sets this to `0.0.0.0`.
- `PORT` - API port. Defaults to `8797`.

Bash sandbox (see [Bash Sandboxing](#bash-sandboxing)):

- `CARMEL_PODMAN_SOCKET` - path to the Podman (or Docker) API socket. Auto-detected from `DOCKER_HOST`, `$XDG_RUNTIME_DIR/podman/podman.sock`, `/run/podman/podman.sock`, then `/var/run/docker.sock`.
- `CARMEL_BASH_IMAGE` - container image used for bash sessions. Defaults to `localhost/carmel-agent-runner:latest` (built from `Dockerfile.runner`). Override with a registry path in production.
- `CARMEL_BASH_MEMORY_MB` - per-container memory cap in MB. Defaults to `512`.
- `CARMEL_BASH_CPUS` - per-container CPU limit. Defaults to `1`.
- `CARMEL_BASH_PIDS_LIMIT` - per-container PID cap. Defaults to `512`.
- `CARMEL_BASH_IDLE_MINUTES` - idle timeout before a sandbox container is reaped. Defaults to `15`.
- `CARMEL_BASH_GPU` - comma-separated CDI device ids to attach to runner containers, e.g. `nvidia.com/gpu=all`. Requires CDI to be configured on the host (`/etc/cdi`). Unset means no GPU.
- `CARMEL_BASH_SELINUX_RELABEL` - relabel runner bind mounts for SELinux (`:z`). Defaults to `true`; set to `false` on non-SELinux hosts if relabeling is unwanted.
- `CARMEL_HOST_DATA_DIR` - host path backing `CARMEL_AGENT_DATA_DIR`, required only when carmel-agent itself runs in a container so workspace bind mounts resolve on the host daemon.
- `CARMEL_BASH_ALLOW_INSECURE` - set to `true` to fall back to in-process host bash when no socket is reachable (development only; bypasses sandboxing).

Provider API keys and OAuth credentials are stored in SQLite. Treat the data directory as sensitive. Set `CARMEL_SECRET_KEY` before adding provider credentials if you want those secrets encrypted at rest.

## Runtime Model

An agent stores its workspace, system prompt, prompt templates, default model, thinking level, and permissions. The server creates a `pi-coding-agent` session for each run, streams agent events to the browser as NDJSON, and persists messages back to SQLite when the run ends.

Agent permissions control which tools are exposed:

- file read/search/list
- file write/edit
- bash
- network search/fetch

File API operations are constrained to the agent working directory. Agents load project skills from `.agents/skills` inside their workspace; read tools can also read that directory so skills can be loaded and inspected.

## Bash Sandboxing

When an agent has the `bash` permission, commands run inside a per-agent container instead of the host shell. This is the recommended way to run untrusted agents: the host shell can read anything the server can (including the SQLite database with provider keys), whereas the sandbox confines bash to the agent's workspace.

- One container per agent, started lazily on the first command and reused across runs and sessions. Idle containers are reaped after `CARMEL_BASH_IDLE_MINUTES`.
- The agent's workspace is bind-mounted into the runner. A default per-agent workspace mounts at `/workspace`; a **manual** workspace mounts at its own absolute path, so paths inside the sandbox match the host and the server-side file tools. The rest of the host filesystem and the server's environment (provider keys, `CARMEL_SECRET_KEY`) are not visible to bash.
- An agent can declare **extra mounts** (in its settings) to bind additional host directories into the runner — e.g. shared reference folders or sibling projects. Each is a host `source`, an optional container `target` (defaults to the source path), and a read-only flag.
- Each agent gets a private **`/tmp`**: a per-agent host directory (`<data>/agents/<id>/tmp`) bind-mounted at `/tmp` in the runner. It is isolated from the host's real `/tmp` and shared between the sandboxed shell and the host-side file tools. It survives transient container restarts (abort, timeout, config change) but is wiped when the sandbox is permanently torn down (idle reap or agent deletion).
- Bind mounts are relabeled for SELinux (`:z`) by default, which is required on enforcing hosts (Fedora, RHEL). Set `CARMEL_BASH_SELINUX_RELABEL=false` to disable on systems where relabeling is unwanted.
- The container gets no network unless the agent has the `network` permission, and runs with dropped capabilities, `no-new-privileges`, and memory/CPU/PID limits.
- The file read/write/edit/search tools run on the host. They can read/write the workspace, the agent's `/tmp`, and any extra mounts (writes respect a mount's read-only flag). Because they operate on host paths, container paths the agent uses (`/workspace`, `/tmp`, a mount's `target`) are translated to their host equivalents, so the same path works in both bash and the file tools.
- GPUs can be passed through with `CARMEL_BASH_GPU` (CDI), which injects the device nodes and driver libraries into every runner container. The driver libraries come from the host via CDI, but a CUDA toolchain (`nvcc`, etc.) must be present in the runner image itself — use a CUDA-based `CARMEL_BASH_IMAGE` if you need one.

The intended setup is rootless Podman: expose its API socket (`systemctl --user enable --now podman.socket`) so a compromised server cannot gain host root through the socket. Docker's socket works too but grants host-root-equivalent access and is not recommended.

If no socket is reachable, the bash tool returns an error for every command (other tools are unaffected). For local development without a container runtime, set `CARMEL_BASH_ALLOW_INSECURE=true` to fall back to in-process host bash — this disables sandboxing and should never be used in production.

Containers are labelled `carmel.managed=1`; the server removes its own containers on graceful shutdown (SIGINT/SIGTERM) and reaps any that survived a previous process on startup.

## Database Migrations

The server runs migrations on startup and records applied migrations in `schema_migrations`. Existing databases are upgraded with compatibility migrations, while new databases are created with the current schema.

## Scripts

```sh
pnpm dev          # run API and client together
pnpm dev:server   # run only the API
pnpm dev:client   # run only the Vite client
pnpm build        # type-check and build all packages
pnpm lint         # run ESLint
pnpm serve        # run the server entrypoint
```

## Docker

There are two images:

- `Dockerfile` builds the **carmel-agent server** (API + built web client). It is intentionally slim: just the Node runtime and the host-side file/search tooling (ripgrep).
- `Dockerfile.runner` builds the **bash sandbox runner** that agents execute commands in. The agent toolchain (Chromium + `agent-browser`, `qmd`, Python, etc.) lives here, not in the server image. This is what `CARMEL_BASH_IMAGE` points at.

The quickest path is Compose, which wires the data volume, Podman socket, and `CARMEL_BASH_IMAGE` for you:

```sh
podman compose --profile build build   # build both the server and runner images
podman compose up -d                    # start the server
```

To build the images manually instead, build the server image:

```sh
podman build -t carmel-agent .
```

Build the runner image and point the server at it:

```sh
podman build -f Dockerfile.runner -t carmel-agent-runner:latest .
```

Run the server with rootless Podman, exposing the Podman socket so it can create per-agent runner containers (see [Bash Sandboxing](#bash-sandboxing)):

```sh
podman run --rm -p 8797:8797 \
  -v carmel-agent-data:/data \
  -v "$XDG_RUNTIME_DIR/podman/podman.sock:/run/podman/podman.sock" \
  -e CARMEL_PODMAN_SOCKET=/run/podman/podman.sock \
  -e CARMEL_BASH_IMAGE=localhost/carmel-agent-runner:latest \
  -e CARMEL_HOST_DATA_DIR=/path/on/host/backing/the/data/volume \
  carmel-agent
```

`CARMEL_HOST_DATA_DIR` is required when the server runs in a container: workspace bind mounts for runner containers are interpreted by the host Podman daemon, so the server needs the host-side path that backs `/data`. When running the server directly on the host (`pnpm serve`), the socket is auto-detected and `CARMEL_HOST_DATA_DIR` is unnecessary; only the runner image and `CARMEL_BASH_IMAGE` are needed.
