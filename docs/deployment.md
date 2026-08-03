# Deployment

This guide covers running Carmel Agent as a self-hosted app.

Carmel needs a container runtime that exposes a Docker-compatible API socket, so it can start a sandbox container per agent when bash is enabled. Podman and Docker both provide one. **Rootless Podman is recommended**: handing an app access to a rootful Docker socket is effectively handing it root on the host.

The socket is optional. Without one, Carmel runs normally and only bash commands fail, with a "sandbox unavailable" message.

## Compose

Requirements:

- A container runtime with a Docker-compatible socket (rootless Podman recommended; Docker works)
- `podman compose` or `docker compose`

With rootless Podman, enable the user socket first:

```sh
systemctl --user enable --now podman.socket
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

- `./data:/data` for the SQLite databases, agent workspaces, and runtime state.
- `${XDG_RUNTIME_DIR}/podman/podman.sock:/run/podman/podman.sock` so the server can create runner containers.

It also sets `CARMEL_HOST_DATA_DIR=${PWD}/data`. This is required whenever Carmel itself runs in a container: runner bind mounts are resolved by the host's container runtime, so Carmel has to know the host path backing `/data`.

### Using Docker

`compose.yaml` is written for the rootless Podman socket. For Docker, change the host side of the socket bind mount and use `docker compose` for the same commands:

```yaml
    volumes:
      - ./data:/data
      - /var/run/docker.sock:/run/podman/podman.sock
```

The container-side path stays `/run/podman/podman.sock` so `CARMEL_PODMAN_SOCKET` needs no change. Carmel talks to the socket over the Docker-compatible REST API and never shells out to the `podman` or `docker` CLI.

Two Docker-specific things to keep in mind:

- The daemon socket grants broad host control to anything that can reach it. Prefer rootless Podman, or rootless Docker, for untrusted agent workloads.
- Runner containers are created by the daemon, so bind mount sources must exist on the host, not inside the Carmel container. That is what `CARMEL_HOST_DATA_DIR` is for.

## Production Checklist

- Set a stable `CARMEL_SECRET_KEY` before adding any provider credentials. It encrypts stored API keys, OAuth credentials, and custom headers; changing it later makes existing secrets unreadable.
- Put Carmel behind HTTPS. Session cookies are marked secure when `NODE_ENV=production`.
- Back up `data/`. It holds the databases, sessions, provider metadata, agent workspaces, and per-agent scratch directories.
- Keep the container socket available to the service user (for rootless Podman, `loginctl enable-linger <user>` keeps the user socket alive without an active login session).
- Prefer rootless Podman over a rootful Docker socket.
- Set `CARMEL_ALLOWED_ORIGINS` if the browser UI is served from a different origin than the API.
- Set `CARMEL_TRUSTED_PROXY` when a reverse proxy should be trusted for login rate-limit IP detection.

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

Run the server (swap `podman` for `docker` and the socket path if you use Docker):

```sh
podman run --rm -p 8797:8797 \
  -v carmel-agent-data:/data \
  -v "$XDG_RUNTIME_DIR/podman/podman.sock:/run/podman/podman.sock" \
  -e CARMEL_PODMAN_SOCKET=/run/podman/podman.sock \
  -e CARMEL_BASH_IMAGE=localhost/carmel-agent-runner:latest \
  -e CARMEL_HOST_DATA_DIR=/path/on/host/backing/the/data/volume \
  -e CARMEL_SECRET_KEY='change-this-to-a-stable-secret' \
  carmel-agent
```

`CARMEL_HOST_DATA_DIR` is only needed when Carmel Agent itself runs in a container. Running the server directly on the host, the socket is auto-detected and host paths already line up.

## Local Development

Requirements: Node.js 24 and pnpm 11.

```sh
pnpm install
pnpm dev
```

The API listens on `http://localhost:8797`; the Vite client on `http://localhost:5173`. Open the client and create the administrator account on the welcome screen.

For sandboxed bash locally, build the runner image and make sure your container socket is reachable.

## Accounts

The first account is created in the browser on first run and becomes an administrator. After that, admins add and manage accounts under **Settings → Users**: create users, change roles, reset passwords, and remove accounts.

The setup endpoint closes as soon as any account has a password, so it cannot be used to mint extra admins later.

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
  podman compose exec carmel-agent pnpm --filter @carmel-agent/server user:create --username admin
```

The command runs migrations and seeds the database first, then creates or updates the account. It always grants the administrator role. Passwords must be at least 8 characters, and an existing user with the same username is updated in place — which is how you reset a forgotten admin password.
