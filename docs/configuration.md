# Configuration

Carmel Agent reads `.env`, `.env.local`, `packages/server/.env`, and `packages/server/.env.local` before startup. Environment variables set directly (for example in Compose) work normally and take precedence over the files.

## Core Settings

- `HOST` — API bind host. Defaults to `127.0.0.1`; the container image sets `0.0.0.0`.
- `PORT` — API port. Defaults to `8797`.
- `NODE_ENV` — set to `production` in real deployments. Session cookies are marked secure only when it is.
- `DATABASE_URL` — Carmel metadata/auth SQLite path. Defaults to `data/carmel-agent.sqlite`.
- `CARMEL_PI_SESSION_DATABASE_URL` — path for Pi's native session-tree SQLite database. Defaults to `data/pi-sessions.sqlite`.
- `CARMEL_AGENT_DATA_DIR` — base data directory for databases and default agent workspaces. The container image sets `/data`.
- `CARMEL_AGENT_DIR` — Pi agent runtime directory. Defaults to `data/pi-agent`.
- `CLIENT_DIST_DIR` — override for the built web client directory.

## Secrets

- `CARMEL_SECRET_KEY` — encrypts stored provider API keys, OAuth credentials, custom headers, and per-agent secrets at rest.

Set it before adding any provider credentials and keep it stable. If it changes, previously encrypted values can no longer be decrypted.

The `data/` directory stays sensitive even with encryption enabled: it contains sessions, workspace files, database rows, and the encrypted credential material itself.

## Browser And Proxy Security

- `CARMEL_ALLOWED_ORIGINS` — comma-separated extra browser origins allowed to make mutating API requests with cookies.
- `CARMEL_TRUSTED_PROXY` — comma-separated IPs of trusted reverse proxies. `X-Forwarded-For` is honored for the login rate limiter only when the connection comes from one of these addresses.

The server applies secure headers, CORS for `/api/*`, cross-origin mutation checks, and cookie-based authentication. Repeated failed logins for the same username and source are rate limited.

## Providers And Models

Provider configs are **instance-level and admin-managed**: any administrator can create, edit, or delete them under **Settings → Providers**, and there is one shared set for the whole instance. Each config stores a provider type, label, base URL, authentication method, and optional custom headers. Authentication is either an API key or an OAuth login, when the underlying Pi provider supports OAuth.

Stored API keys, OAuth credentials, and custom headers are never returned to any browser — the API only reports whether a credential is present.

Model entries ("model refs") are what users pick in agents and sessions. Any user can create them against the instance's provider configs. A model entry belongs to whoever created it and can be marked shared so everyone on the instance can select it; the credentials behind it stay server-side either way.

Model catalogs for configured providers are refreshed once at server startup and cached in the database, so provider model lists stay current without a manual step. Failures are logged and do not block startup.

Ollama uses the OpenAI-compatible API shape and defaults to:

```text
http://localhost:11434/v1
```

When an Ollama provider config is selected, the app can list the models available at that base URL.

Each user can also pick a **fast task model** in **Settings → Models**. It is used for cheap background work such as generating session titles; without one, the session's own model is used.

## Network Tools

- `EXA_API_KEY` — enables `exa_search` and improves markdown extraction for `fetch_url`.

Network tools are only added to a run when the agent has the network permission. Without `EXA_API_KEY`, `fetch_url` still performs direct HTTP fetches, but `exa_search` reports that the key is required.

## Bash Sandbox Settings

- `CARMEL_PODMAN_SOCKET` — path to the container API socket. Podman and Docker both work; the name is historical. Auto-detected in order from `DOCKER_HOST` (when it is a `unix://` path), `$XDG_RUNTIME_DIR/podman/podman.sock`, `/run/podman/podman.sock`, then `/var/run/docker.sock`.
- `CARMEL_BASH_IMAGE` — image used for bash sessions. Defaults to `localhost/carmel-agent-runner:latest`. Non-`localhost/` images are pulled on first use.
- `CARMEL_BASH_MEMORY_MB` — per-container memory cap in MB. Defaults to `512`.
- `CARMEL_BASH_CPUS` — per-container CPU limit. Defaults to `1`.
- `CARMEL_BASH_PIDS_LIMIT` — per-container PID cap. Defaults to `512`.
- `CARMEL_BASH_IDLE_MINUTES` — idle timeout before a sandbox container is reaped. Defaults to `15`.
- `CARMEL_BASH_GPU` — comma-separated CDI device ids to attach to runner containers, for example `nvidia.com/gpu=all`.
- `CARMEL_BASH_SELINUX_RELABEL` — relabel runner bind mounts for SELinux with `:z`. Defaults to `true`; set to `false` if relabeling is unwanted.
- `CARMEL_HOST_DATA_DIR` — host path backing `CARMEL_AGENT_DATA_DIR`. Required only when Carmel Agent itself runs in a container, because runner bind mounts are resolved by the host's container runtime.

The runner image defines the toolchain bash agents get. The default `Dockerfile.runner` includes bash, git, curl, wget, Python, ripgrep, Chromium, `agent-browser`, and `qmd`.

## CLI Options

- `CARMEL_PASSWORD` — password for `pnpm --filter @carmel-agent/server user:create`, as an alternative to `--password`. See [deployment.md](deployment.md#creating-an-admin-from-the-cli).
