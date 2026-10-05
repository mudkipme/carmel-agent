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

Export your identity and create the bind directory as your normal user. Keep these variables in your shell or Compose `.env` for subsequent commands:

```sh
export CARMEL_HOST_UID=$(id -u)
export CARMEL_HOST_GID=$(id -g)
mkdir -p data
```

Build both images:

```sh
podman compose --profile build build
```

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

`compose.yaml` defaults to rootless Podman and `keep-id`. For ordinary rootful Docker, set these variables in addition to the host UID/GID above, then use `docker compose` for the same build/start commands:

```sh
export CARMEL_USERNS_MODE=host
export CARMEL_RUNTIME_SOCKET=/var/run/docker.sock
export CARMEL_SOCKET_GID=$(stat -c %g "$CARMEL_RUNTIME_SOCKET")
```

For rootful Podman, use the same settings with `CARMEL_RUNTIME_SOCKET=/run/podman/podman.sock`. The socket group is added only to the server, never to runners. Do not make the socket world-writable.

The container-side path stays `/run/podman/podman.sock` so `CARMEL_PODMAN_SOCKET` needs no change. Carmel inspects the daemon through its API and never shells out to the `podman` or `docker` CLI. Setting the Compose namespace mode does not bypass the runner's rejection of unsupported Docker modes.

Runner bind sources must exist on the host. That is what `CARMEL_HOST_DATA_DIR` is for. With rootless Podman, the daemon must run as the configured host UID/GID.

For nested bind mounts, Carmel prepares missing mount points as the server user so the runtime cannot leave root-owned directories in a workspace or private home/tmp. Both sources must be visible to the server for this preparation. Targets inside a read-only parent mount must already exist; symlinked mount-point paths are rejected.

### Upgrading an existing deployment

Rebuild both images and recreate the server with the identity settings above. Existing rootless Podman data already belongs to the host user in the usual setup. Data created by a rootful deployment may be root-owned: stop Carmel, back it up, and have the administrator correct ownership of the affected data directories before restarting. Carmel does not recursively chown workspaces or extra mounts.

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

## Reverse Proxy Notes

The server listens on `PORT` and serves both `/api/*` and the built web client from the same process. A typical deployment proxies everything to `http://127.0.0.1:8797` or to the container's published port.

If the public browser origin differs from the API origin, add it to `CARMEL_ALLOWED_ORIGINS`.

If you terminate TLS at a reverse proxy, pass the usual `Host` and `X-Forwarded-*` headers. `X-Forwarded-For` is only honored by the login rate limiter when the direct peer is listed in `CARMEL_TRUSTED_PROXY`.

## Manual Image Build

Build the web/API server image:

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
  -e CARMEL_SECRET_KEY='change-this-to-a-stable-secret' \
  carmel-agent
```

For rootful Docker, use `docker run --userns=host --user "$(id -u):$(id -g)"`, bind `/var/run/docker.sock` to the same container socket path, and add `--group-add "$(stat -c %g /var/run/docker.sock)"` to the server command.

`CARMEL_HOST_DATA_DIR`, `CARMEL_HOST_UID`, and `CARMEL_HOST_GID` are needed when Carmel runs in a container. Running the server directly on the host as a normal user, the socket is auto-detected and IDs default to the server process UID/GID. Explicit IDs must match the server process IDs.

## Local Development

Requirements: Node.js 24 and pnpm 11.

```sh
pnpm install
pnpm dev
```

The API listens on `http://localhost:8797`; the Vite client on `http://localhost:5173`. Open the client and create the administrator account on the welcome screen.

For sandboxed bash locally, build the runner image and make sure your container socket is reachable.

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
