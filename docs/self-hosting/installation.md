# Installation

Carmel Agent ships as two container images:

| Image                                  | Purpose                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------ |
| `ghcr.io/mudkipme/carmel-agent`        | The server: API and web client in one process.                                       |
| `ghcr.io/mudkipme/carmel-agent-runner` | The sandbox the server starts for commands, terminals, browsers, MCP, and Knowledge. |

Published images currently target Linux amd64.

## Choosing a container runtime

The server starts runner containers through a Docker-compatible API socket. Supported setups:

- **Rootless Podman** — recommended.
- **Rootful Podman or Docker**, without user namespace remapping.

Rootless Docker and Docker with `userns-remap` are rejected: their ID mappings cannot keep host file ownership while running commands as your non-root user.

The server and its runners run as your host UID and GID, so files in workspaces and mounts stay owned by you. Rootless Podman uses `keep-id`; rootful runtimes use the numeric user directly.

::: danger Socket access is host access
The container socket is mounted into the server only, never into runners. Still, an app holding a rootful Docker socket effectively has root on the host. Prefer rootless Podman, and never make the socket world-writable.
:::

The socket is optional. Without one, Carmel Agent runs normally and only shell-based features report that the sandbox is unavailable.

## Install with Compose

Requirements: one of the runtimes above, and `podman compose` or `docker compose`.

### 1. Prepare the directory

```sh
mkdir carmel-agent
cd carmel-agent
curl -fsSLO https://raw.githubusercontent.com/mudkipme/carmel-agent/main/compose.yaml
```

Create a private `.env` once, as your normal non-root user:

```sh
umask 077
printf 'CARMEL_HOST_UID=%s\nCARMEL_HOST_GID=%s\nCARMEL_SECRET_KEY=%s\n' \
  "$(id -u)" "$(id -g)" "$(openssl rand -hex 32)" > .env
mkdir -p data
```

Keep this key when upgrading or restoring. Compose requires it, and production startup rejects a missing or blank key. The repository's [`.env.example`](https://github.com/mudkipme/carmel-agent/blob/main/.env.example) lists optional settings.

### 2. Configure the runtime

::: code-group

```sh [Rootless Podman]
systemctl --user enable --now podman.socket
```

```sh [Rootful Docker]
printf 'CARMEL_USERNS_MODE=host\nCARMEL_RUNTIME_SOCKET=/var/run/docker.sock\nCARMEL_SOCKET_GID=%s\n' \
  "$(stat -c %g /var/run/docker.sock)" >> .env
```

```sh [Rootful Podman]
printf 'CARMEL_USERNS_MODE=host\nCARMEL_RUNTIME_SOCKET=/run/podman/podman.sock\nCARMEL_SOCKET_GID=%s\n' \
  "$(stat -c %g /run/podman/podman.sock)" >> .env
```

:::

For rootful runtimes, the socket's group is added to the server only, never to runners. Inside the server container the socket is always at `/run/podman/podman.sock`, whichever runtime backs it.

### 3. Pull and start

Use `docker` instead of `podman` if that is your runtime.

```sh
podman compose pull
podman pull ghcr.io/mudkipme/carmel-agent-runner:latest
podman compose up -d
```

A missing runner image is also pulled automatically on first use, but pulling it up front avoids a delay on the first command.

### 4. Create the administrator

Open `http://localhost:8797` and create the administrator account on the welcome screen. Then continue with [Providers and models](/self-hosting/providers-and-models).

### What the Compose file sets up

- `./data:/data:z` — databases, agent workspaces, and runtime state.
- The runtime socket, mounted at `/run/podman/podman.sock`, so the server can create runner containers.
- `CARMEL_HOST_DATA_DIR=${PWD}/data` — the host path behind `/data`. Runner bind mounts are resolved by the host's container runtime, so a containerized server must know the real host path.
- Port `8797` published on the host.

Add other settings from [Environment variables](/reference/environment-variables) to `.env` or the Compose `environment:` section.

## Run without Compose

Build the images from a clone of the repository:

```sh
podman build -t carmel-agent .
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

Export `CARMEL_SECRET_KEY` from your private configuration first.

For rootful Docker, use `docker run --userns=host --user "$(id -u):$(id -g)"`, bind `/var/run/docker.sock` to the same container path, and add `--group-add "$(stat -c %g /var/run/docker.sock)"`.

To use local builds with Compose instead, set these in `.env` and keep the same key:

```dotenv
CARMEL_IMAGE=localhost/carmel-agent:latest
CARMEL_BASH_IMAGE=localhost/carmel-agent-runner:latest
```

## Run on the host

You can also run the server directly from a checkout with Node.js 24 and pnpm 11 — see [Development](/development/). When the server runs on the host as a normal user, the container socket is detected automatically and the UID/GID default to the server process's own. `CARMEL_HOST_DATA_DIR`, `CARMEL_HOST_UID`, and `CARMEL_HOST_GID` are only needed when the server itself runs in a container; explicit IDs must match the server process.

## Next steps

- [Production setup](/self-hosting/production) — HTTPS, reverse proxies, and a pre-launch checklist.
- [Users and sign-in](/self-hosting/users-and-sign-in) — accounts and single sign-on.
- [Sandbox and runner](/self-hosting/sandbox) — resource limits, mounts, GPUs, and custom images.
- [Backups and upgrades](/self-hosting/backups-and-upgrades) — keeping your data safe across releases.
