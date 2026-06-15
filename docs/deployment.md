# Deployment

This guide covers running Carmel Agent as a self-hosted app. The recommended setup is rootless Podman with Compose so the server can create per-agent sandbox containers without giving the app host-root-equivalent Docker access.

## Recommended: Rootless Podman Compose

Requirements:

- Linux host
- Rootless Podman
- `podman compose`
- A user Podman socket

Enable the user Podman socket:

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

Create the first user:

```sh
CARMEL_PASSWORD='choose-a-long-password' \
  podman compose exec carmel-agent pnpm --filter @carmel-agent/server user:create --username admin
```

Open `http://localhost:8797`.

The Compose file mounts:

- `./data:/data` for the SQLite database, agent workspaces, and runtime state.
- `${XDG_RUNTIME_DIR}/podman/podman.sock:/run/podman/podman.sock` so the server can create runner containers.

It also sets `CARMEL_HOST_DATA_DIR=${PWD}/data`, which is required when the server itself runs in a container. Runner bind mounts are resolved by the host Podman daemon, so Carmel needs the host path backing `/data`.

## Production Checklist

- Set a stable `CARMEL_SECRET_KEY` before adding provider keys or OAuth credentials.
- Put Carmel Agent behind HTTPS. Session cookies are marked secure when `NODE_ENV=production`.
- Back up `data/`; it contains the database, sessions, provider metadata, agent workspaces, and default per-agent scratch paths.
- Keep the rootless Podman socket available to the service user.
- Use rootless Podman where possible. Docker's socket works, but access to it is host-root-equivalent.
- Keep `CARMEL_BASH_ALLOW_INSECURE` unset in production.
- Configure `CARMEL_ALLOWED_ORIGINS` if the browser UI is served from a different origin than the API.
- Configure `CARMEL_TRUSTED_PROXY` when a reverse proxy should be trusted for login rate-limit IP detection.

## Reverse Proxy Notes

The server listens on `PORT` and serves both `/api/*` and the built web client from the same process. A typical deployment proxies all requests to `http://127.0.0.1:8797` or to the container's published port.

If the public browser origin differs from the API origin, add it to `CARMEL_ALLOWED_ORIGINS`.

If you terminate TLS at a reverse proxy, pass normal `Host` and `X-Forwarded-*` headers. `X-Forwarded-For` is only used by the login rate limiter when the direct peer is listed in `CARMEL_TRUSTED_PROXY`.

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
podman run --rm -p 8797:8797 \
  -v carmel-agent-data:/data \
  -v "$XDG_RUNTIME_DIR/podman/podman.sock:/run/podman/podman.sock" \
  -e CARMEL_PODMAN_SOCKET=/run/podman/podman.sock \
  -e CARMEL_BASH_IMAGE=localhost/carmel-agent-runner:latest \
  -e CARMEL_HOST_DATA_DIR=/path/on/host/backing/the/data/volume \
  -e CARMEL_SECRET_KEY='change-this-to-a-stable-secret' \
  carmel-agent
```

`CARMEL_HOST_DATA_DIR` is only needed when Carmel Agent runs in a container. If you run the server directly on the host, the socket is auto-detected and host paths already line up.

## Local Development

Requirements:

- Node.js 24
- pnpm 11

Install dependencies:

```sh
pnpm install
```

Create a user:

```sh
pnpm --filter @carmel-agent/server user:create --username admin --password 'choose-a-long-password'
```

Run the API and client:

```sh
pnpm dev
```

The API listens on `http://localhost:8797`; the Vite client listens on `http://localhost:5173`.

For local sandboxed bash, build the runner image and expose rootless Podman's socket. Without a configured socket, bash commands fail with a sandbox unavailable error while other tools continue to work.

For development only, `CARMEL_BASH_ALLOW_INSECURE=true` falls back to in-process host bash. This bypasses sandboxing and must not be used for production.

## Creating Users

The user creation command runs migrations and seeds the database before creating or updating a login user:

```sh
pnpm --filter @carmel-agent/server user:create \
  --username admin \
  --password 'choose-a-long-password' \
  --name 'Admin' \
  --email admin@example.test
```

You can provide the password with `CARMEL_PASSWORD` instead of `--password`.

Passwords must be at least 8 characters. Existing users with the same username are updated.
