# Deployment

This guide covers running Carmel Agent as a self-hosted app.

Carmel needs a container runtime that exposes a Docker-compatible API socket, so it can start a sandbox container per agent when bash is enabled. Supported configurations are **rootless Podman (recommended)** and rootful Podman/Docker without user namespace remapping. Rootless Docker and Docker with `userns-remap` are rejected because their mappings cannot preserve host ownership while running commands as the same non-root UID.

The server and runners run as your host UID/GID. Rootless Podman uses `keep-id`; rootful runtimes use that numeric user directly. The API socket belongs only in the server: handing an app a rootful Docker socket is effectively handing it root on the host, even when its runners are non-root.

The socket is optional. Without one, Carmel runs normally and only bash commands fail, with a "sandbox unavailable" message.

## Compose

Requirements:

- Rootless Podman, or rootful Podman/Docker without user namespace remapping
- `podman compose` or `docker compose`

With rootless Podman, enable the user socket first:

```sh
systemctl --user enable --now podman.socket
```

Download [compose.yaml](../compose.yaml), then create a private `.env` once as your normal non-root user:

```sh
umask 077
printf 'CARMEL_HOST_UID=%s\nCARMEL_HOST_GID=%s\nCARMEL_SECRET_KEY=%s\n' \
  "$(id -u)" "$(id -g)" "$(openssl rand -hex 32)" > .env
mkdir -p data
```

Keep the existing key when upgrading or restoring. Compose requires it, and production startup rejects a missing or blank key. [`.env.example`](../.env.example) lists optional image and runtime settings.

Pull the published server and runner images:

```sh
podman compose pull
podman pull ghcr.io/mudkipme/carmel-agent-runner:latest
```

The defaults are `ghcr.io/mudkipme/carmel-agent:latest` and `ghcr.io/mudkipme/carmel-agent-runner:latest`, currently for Linux amd64. A missing runner image is also pulled automatically on first use.

Start the server:

```sh
podman compose up -d
```

Open `http://localhost:8797` and create the administrator account on the welcome screen.

The Compose file mounts:

- `./data:/data:z` for the SQLite databases, agent workspaces, and runtime state.
- `${XDG_RUNTIME_DIR}/podman/podman.sock:/run/podman/podman.sock` so the server can create runner containers.

It also sets `CARMEL_HOST_DATA_DIR=${PWD}/data`. This is required whenever Carmel itself runs in a container: runner bind mounts are resolved by the host's container runtime, so Carmel has to know the host path backing `/data`.

### Using Docker

`compose.yaml` defaults to rootless Podman and `keep-id`. For ordinary rootful Docker, add these settings to `.env`, then use `docker compose` and `docker pull` for the pull/start commands:

```sh
printf 'CARMEL_USERNS_MODE=host\nCARMEL_RUNTIME_SOCKET=/var/run/docker.sock\nCARMEL_SOCKET_GID=%s\n' \
  "$(stat -c %g /var/run/docker.sock)" >> .env
```

For rootful Podman, use the same settings with `CARMEL_RUNTIME_SOCKET=/run/podman/podman.sock`. The socket group is added only to the server, never to runners. Do not make the socket world-writable.

The container-side path stays `/run/podman/podman.sock` so `CARMEL_PODMAN_SOCKET` needs no change. Carmel inspects the daemon through its API and never shells out to the `podman` or `docker` CLI. Setting the Compose namespace mode does not bypass the runner's rejection of unsupported Docker modes.

Runner bind sources must exist on the host. That is what `CARMEL_HOST_DATA_DIR` is for. With rootless Podman, the daemon must run as the configured host UID/GID.

For nested bind mounts, Carmel prepares missing mount points as the server user so the runtime cannot leave root-owned directories in a workspace or private home/tmp. Both sources must be visible to the server for this preparation. Targets inside a read-only parent mount must already exist; symlinked mount-point paths are rejected.

### Upgrading an existing deployment

Back up `data/` and the existing encryption key with the server stopped, then pull both images and recreate the server:

```sh
podman compose pull
podman pull ghcr.io/mudkipme/carmel-agent-runner:latest
podman compose up -d --force-recreate
```

The server restart removes old managed runners; new runners use the updated image while keeping their persistent files. Existing rootless Podman data already belongs to the host user in the usual setup. Data created by a rootful deployment may be root-owned: stop Carmel, back it up, and have the administrator correct ownership of the affected data directories before restarting. Carmel does not recursively chown workspaces or extra mounts.

For deployments previously using the private registry, replace the server and runner image names with the GHCR defaults while retaining the data directory, UID/GID, and **same encryption key**. Setting a key does not rewrite older plaintext credential rows; re-save provider credentials and agent secrets to encrypt those values.

The runner keeps npm global installs in `/home/agent/.npm-global` and initializes a persistent Python virtual environment at `/home/agent/.venvs/default`. Both plain `pip install` and `npm install -g` work without root when network access is enabled. C/C++ compilers, make, pkg-config, and Python headers are included for native package builds; packages requiring additional system libraries may still need a custom runner image. `apt install` is not available to agent commands. If an image upgrade changes Python's major/minor version, move aside the old virtual environment and reinstall its packages; startup reports this instead of silently deleting it.

## Production Checklist

- Set a stable `CARMEL_SECRET_KEY` before adding any provider credentials. It encrypts stored API keys, OAuth credentials, and custom headers; changing it later makes existing secrets unreadable.
- Put Carmel behind HTTPS. Session cookies are marked secure when `NODE_ENV=production`.
- Back up `data/`. It holds the databases, sessions, provider metadata, agent workspaces, and per-agent scratch directories.
- Keep the container socket available to the service user (for rootless Podman, `loginctl enable-linger <user>` keeps the user socket alive without an active login session).
- Prefer rootless Podman over a rootful Docker socket.
- Set `CARMEL_ALLOWED_ORIGINS` if the browser UI is served from a different origin than the API.
- Set `CARMEL_TRUSTED_PROXY` when a reverse proxy should be trusted for login rate-limit IP detection.
- For single sign-on, set `CARMEL_PUBLIC_URL` and the `CARMEL_OIDC_*` variables, and register `<CARMEL_PUBLIC_URL>/api/auth/oidc/callback` with your provider. See [configuration.md](configuration.md#single-sign-on-openid-connect).

## Image Tags And Releases

`latest` follows successful builds on `main`. Both images also receive the full Git commit SHA. Tags such as `v0.1.0` publish matching `v0.1.0` and `0.1.0` image tags after all CI checks pass. Release tags do not move `latest`.

To pin a release, set both images in `.env` to the same version or commit:

```dotenv
CARMEL_IMAGE=ghcr.io/mudkipme/carmel-agent:v0.1.0
CARMEL_BASH_IMAGE=ghcr.io/mudkipme/carmel-agent-runner:v0.1.0
```

Pull the selected runner explicitly before restarting. Registry images already present on the host are reused, so changing a moving tag requires a pull. Schema initialization supports fresh databases and the current schema; historical schema migrations are not implemented. Restore the backed-up data and key together if a rollback needs an older schema.

Maintainers: GitHub Actions tests PRs without registry credentials and publishes only pushes to `main` or `v*` tags in `mudkipme/carmel-agent`. Authentication uses `GITHUB_TOKEN` with `packages: write`; no personal registry token is needed. After the first successful publication, set **both GHCR packages to public** in their package settings and verify anonymous pulls. Configure branch protection to require `check`, `browser`, and `containers`.

## Reverse Proxy Notes

The server listens on `PORT` and serves both `/api/*` and the built web client from the same process. A typical deployment proxies everything to `http://127.0.0.1:8797` or to the container's published port.

If the public browser origin differs from the API origin, add it to `CARMEL_ALLOWED_ORIGINS`.

If you terminate TLS at a reverse proxy, pass the usual `Host` and `X-Forwarded-*` headers. `X-Forwarded-For` is only honored by the login rate limiter when the direct peer is listed in `CARMEL_TRUSTED_PROXY`.

## Manual Image Build

For development or a custom toolchain, clone the repository and build the web/API server image:

```sh
podman build -t carmel-agent .
```

Build the runner image:

```sh
podman build -f Dockerfile.runner -t carmel-agent-runner:latest .
```

Run the server with rootless Podman:

```sh
mkdir -p data
podman run --rm -p 8797:8797 --userns=keep-id --user "$(id -u):$(id -g)" \
  -v "$PWD/data:/data:z" \
  -v "$XDG_RUNTIME_DIR/podman/podman.sock:/run/podman/podman.sock" \
  -e CARMEL_HOST_UID="$(id -u)" -e CARMEL_HOST_GID="$(id -g)" \
  -e CARMEL_PODMAN_SOCKET=/run/podman/podman.sock \
  -e CARMEL_BASH_IMAGE=localhost/carmel-agent-runner:latest \
  -e CARMEL_HOST_DATA_DIR="$PWD/data" \
  -e CARMEL_SECRET_KEY \
  carmel-agent
```

Export `CARMEL_SECRET_KEY` from your existing private configuration before this command. To use these builds with Compose, set `CARMEL_IMAGE=localhost/carmel-agent:latest` and `CARMEL_BASH_IMAGE=localhost/carmel-agent-runner:latest` in `.env`; keep the same key.

For rootful Docker, use `docker run --userns=host --user "$(id -u):$(id -g)"`, bind `/var/run/docker.sock` to the same container socket path, and add `--group-add "$(stat -c %g /var/run/docker.sock)"` to the server command.

`CARMEL_HOST_DATA_DIR`, `CARMEL_HOST_UID`, and `CARMEL_HOST_GID` are needed when Carmel runs in a container. Running the server directly on the host as a normal user, the socket is auto-detected and IDs default to the server process UID/GID. Explicit IDs must match the server process IDs.

## Local Development

Requirements: Node.js 24 and pnpm 11.

```sh
pnpm install
pnpm dev
```

The API listens on `http://localhost:8797`; the Vite client on `http://localhost:5173`. Open the client and create the administrator account on the welcome screen.

For sandboxed bash locally, pull the published runner image and make sure your container socket is reachable. If you build `Dockerfile.runner` instead, set `CARMEL_BASH_IMAGE=localhost/carmel-agent-runner:latest` before starting the server.

To check non-root execution and ownership against an actual runtime using isolated temporary data and offline package fixtures:

```sh
CARMEL_SANDBOX_TEST_IMAGE=localhost/carmel-agent-runner:latest \
  pnpm --filter @carmel-agent/server test:sandbox-identity
```

Run this as the normal host user against either a rootless Podman socket or a rootful Docker/Podman socket. It tests file ownership, pip/npm installs, direct and terminal execution, and persistence across runner recreation. The browser test remains available via `CARMEL_BROWSER_TEST_IMAGE=... pnpm --filter @carmel-agent/server test:browser-sandbox`.

## Accounts

The first account is created in the browser on first run and becomes an administrator. After that, admins add and manage accounts under **Settings → Users**: create users, change roles, reset passwords, and remove accounts.

The setup endpoint closes as soon as any account has a password or a linked single sign-on identity, so it cannot be used to mint extra admins later.

With OIDC configured, the welcome screen also offers "Continue with <provider>". The first person to sign in that way becomes the administrator. After that, people who sign in through the provider get accounts automatically, depending on the [account mapping settings](configuration.md#account-mapping).

### Creating An Admin From The CLI

Useful when nobody can log in — a lost admin password, or an unattended first-run provisioning step:

```sh
pnpm --filter @carmel-agent/server user:create \
  --username admin \
  --password 'choose-a-long-password' \
  --name 'Admin' \
  --email admin@example.test
```

In a Compose deployment:

```sh
CARMEL_PASSWORD='choose-a-long-password' \
  podman compose exec -e CARMEL_PASSWORD carmel-agent node --import tsx src/cli/create-user.ts --username admin
```

The command initializes the current schema and seeds an empty database first, then creates or updates the account. It always grants the administrator role. Passwords must be at least 8 characters, and an existing user with the same username is updated in place — which is how you reset a forgotten admin password.
