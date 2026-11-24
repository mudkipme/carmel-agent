# Quick start

This page takes you from an empty directory to your first conversation. It uses Compose with rootless Podman, which is the recommended setup. For other runtimes, manual containers, and production hardening, see [Installation](/self-hosting/installation).

## Requirements

- A Linux host. Other hosts work if they can run the container images and expose a container socket. Published images currently target Linux amd64.
- Rootless Podman (recommended), or rootful Podman or Docker without user namespace remapping. Rootless Docker and Docker with `userns-remap` are not supported.
- Compose (`podman compose` or `docker compose`).
- An API key or login for at least one model provider, or a running Ollama instance.

::: tip
The container socket is only needed for the bash sandbox. Without it, Carmel Agent still runs: chat, files, and web tools all work, and shell commands report that the sandbox is unavailable.
:::

## 1. Download the Compose file

```sh
mkdir carmel-agent
cd carmel-agent
curl -fsSLO https://raw.githubusercontent.com/mudkipme/carmel-agent/main/compose.yaml
```

## 2. Create the configuration

Run this once, as your normal non-root user:

```sh
umask 077
printf 'CARMEL_HOST_UID=%s\nCARMEL_HOST_GID=%s\nCARMEL_SECRET_KEY=%s\n' \
  "$(id -u)" "$(id -g)" "$(openssl rand -hex 32)" > .env
mkdir -p data
```

The server and its runners use your UID and GID, so workspace files stay owned by you.

::: warning Keep your secret key
`CARMEL_SECRET_KEY` encrypts provider keys, OAuth logins, and agent secrets. Back it up together with `data/`. Replacing the key makes existing encrypted credentials unreadable. Compose refuses to start without it.
:::

## 3. Start Carmel Agent

::: code-group

```sh [Rootless Podman]
systemctl --user enable --now podman.socket
podman compose pull
podman pull ghcr.io/mudkipme/carmel-agent-runner:latest
podman compose up -d
```

```sh [Rootful Docker]
printf 'CARMEL_USERNS_MODE=host\nCARMEL_RUNTIME_SOCKET=/var/run/docker.sock\nCARMEL_SOCKET_GID=%s\n' \
  "$(stat -c %g /var/run/docker.sock)" >> .env
docker compose pull
docker pull ghcr.io/mudkipme/carmel-agent-runner:latest
docker compose up -d
```

:::

## 4. Create your administrator account

Open `http://localhost:8797`. The welcome screen asks you to create the first account, which becomes the administrator. No command-line step is needed.

## 5. Add a provider and a model

1. Go to **Settings → Providers** and add a provider: an API key, an OAuth login, or an Ollama base URL. Provider credentials belong to the instance, so only administrators can add them.
2. Go to **Settings → Models** and add the models you want to use from that provider.

See [Providers and models](/self-hosting/providers-and-models) for details.

## 6. Start chatting

Open the default agent, or create a new one, and start a session. New agents can read, write, and edit files in their working folder. Running commands and web access are off until you turn them on in **Agent Settings → Permissions**.

![A finished conversation in which the agent compares three note-taking tools in a table and recommends one](/screenshots/chat-comparison.webp){.screenshot}

## Next steps

- Learn the vocabulary in [Core concepts](/guide/concepts).
- Shape your agent in [Agents](/guide/agents).
- Put Carmel Agent behind HTTPS with the [Production setup](/self-hosting/production) checklist.
- Invite other people in [Users and sign-in](/self-hosting/users-and-sign-in).
