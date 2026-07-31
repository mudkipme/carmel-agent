# Configuration

Carmel Agent reads `.env`, `.env.local`, `packages/server/.env`, and `packages/server/.env.local` before startup. Environment variables also work normally in containers.

## Core Settings

- `HOST` - API bind host. Defaults to `127.0.0.1`; the Docker image sets `0.0.0.0`.
- `PORT` - API port. Defaults to `8797`.
- `DATABASE_URL` - Carmel metadata/auth SQLite path. Defaults to `data/carmel-agent.sqlite`.
- `CARMEL_PI_SESSION_DATABASE_URL` - optional path for Pi's native session-tree SQLite database. Defaults to `data/pi-sessions.sqlite`.
- `CARMEL_AGENT_DATA_DIR` - base data directory used for the database and default agent workspaces. The Docker image sets `/data`.
- `CARMEL_AGENT_DIR` - Pi agent runtime directory. Defaults to `data/pi-agent`.
- `CLIENT_DIST_DIR` - optional override for the built web client directory.

## Secrets

- `CARMEL_SECRET_KEY` - secret used to encrypt stored provider API keys, OAuth credentials, and custom headers at rest.

Set `CARMEL_SECRET_KEY` before adding provider credentials and keep it stable. If it changes, previously encrypted values may no longer be readable.

The `data/` directory is sensitive even with encryption enabled because it contains sessions, workspace files, database rows, and encrypted credential material.

## Browser And Proxy Security

- `CARMEL_ALLOWED_ORIGINS` - comma-separated extra browser origins allowed to make mutating API requests with cookies.
- `CARMEL_TRUSTED_PROXY` - comma-separated IPs of trusted reverse proxies. `X-Forwarded-For` is honored for the login rate limiter only when the connection comes from one of these addresses.

The server applies secure headers, CORS for `/api/*`, cross-origin mutation checks, and cookie-based authentication.

## Provider And Model Setup

Provider configs are per-user. Each provider config stores a provider type, label, base URL, authentication method, and optional custom headers. Authentication can be API-key based or OAuth-based when the underlying Pi provider supports OAuth.

Model refs are entries users can select in agents and sessions. A model ref can be private or shared. Shared model refs are visible to other users. If a shared model is backed by a provider config, Carmel can use that config for runs, but the stored API key, OAuth credential, and custom headers are not shown to other users.

Ollama uses the OpenAI-compatible API shape and defaults to:

```text
http://localhost:11434/v1
```

When an Ollama provider config is selected, the app can query available local models from that base URL.

## Network Tools

- `EXA_API_KEY` - enables `exa_search` and improves markdown fetch behavior for `fetch_url`.

Network tools are only added to an agent run when that agent has the network permission enabled. Without `EXA_API_KEY`, `fetch_url` can still perform direct HTTP fetches, but `exa_search` reports that the key is required.

## Bash Sandbox Settings

- `CARMEL_PODMAN_SOCKET` - path to the Podman or Docker API socket. Auto-detected from `DOCKER_HOST`, `$XDG_RUNTIME_DIR/podman/podman.sock`, `/run/podman/podman.sock`, then `/var/run/docker.sock`.
- `CARMEL_BASH_IMAGE` - container image used for bash sessions. Defaults to `localhost/carmel-agent-runner:latest`.
- `CARMEL_BASH_MEMORY_MB` - per-container memory cap in MB. Defaults to `512`.
- `CARMEL_BASH_CPUS` - per-container CPU limit. Defaults to `1`.
- `CARMEL_BASH_PIDS_LIMIT` - per-container PID cap. Defaults to `512`.
- `CARMEL_BASH_IDLE_MINUTES` - idle timeout before a sandbox container is reaped. Defaults to `15`.
- `CARMEL_BASH_GPU` - comma-separated CDI device ids to attach to runner containers, for example `nvidia.com/gpu=all`.
- `CARMEL_BASH_SELINUX_RELABEL` - relabel runner bind mounts for SELinux with `:z`. Defaults to `true`; set to `false` if relabeling is unwanted.
- `CARMEL_HOST_DATA_DIR` - host path backing `CARMEL_AGENT_DATA_DIR`, required only when Carmel Agent runs in a container.

The runner image contains the tools available to bash agents. The default `Dockerfile.runner` includes bash, git, curl, wget, Python, ripgrep, Chromium, `agent-browser`, and `qmd`.
