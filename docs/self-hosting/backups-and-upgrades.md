# Backups and upgrades

## What to back up

Back up two things, together:

1. **The `data/` directory.**
2. **`CARMEL_SECRET_KEY`** — usually in your Compose `.env`.

Encrypted credentials in `data/` are useless without the key, and a key without the data restores nothing. Stop the server before taking the backup so the SQLite databases are consistent.

::: warning `data/` is sensitive
Even with encryption, `data/` contains conversations, workspace files, browser profiles, and the encrypted credential material itself. Protect backups accordingly.
:::

### What's in `data/`

| Path                              | Contents                                                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `carmel-agent.sqlite`             | Accounts, agents, providers, tasks, schedules, and other metadata.                                                                               |
| `pi-sessions.sqlite.durable/`     | One SQLite file per conversation. See [Session storage](/development/session-storage).                                                           |
| `environments/`                   | Environment workspaces (each agent's default folder) and persistent homes. Environments created before shared environments live under `agents/`. |
| `home-memory/`                    | Derived Home memory indexes. Rebuildable.                                                                                                        |
| `knowledge/`, `knowledge-models/` | Knowledge indexes and downloaded models. Rebuildable.                                                                                            |
| Sandbox `/tmp` directories        | Temporary scratch. Safe to exclude.                                                                                                              |

## Upgrading

Back up first, then pull both images and recreate the server:

```sh
podman compose pull
podman pull ghcr.io/mudkipme/carmel-agent-runner:latest
podman compose up -d --force-recreate
```

On restart, the server applies database migrations, removes old runners, and starts new ones from the updated runner image as needed. Workspaces and homes are kept.

Always upgrade the server and runner images together, and keep the same `CARMEL_SECRET_KEY`.

### Release tags

| Tag               | Meaning                                                             |
| ----------------- | ------------------------------------------------------------------- |
| `latest`          | The latest successful build of `main`.                              |
| `<commit sha>`    | A specific build of any published commit.                           |
| `v0.1.0`, `0.1.0` | A release, published after all checks pass. Does not move `latest`. |

To pin a release, set both images in `.env` to the same version:

```dotenv
CARMEL_IMAGE=ghcr.io/mudkipme/carmel-agent:v0.1.0
CARMEL_BASH_IMAGE=ghcr.io/mudkipme/carmel-agent-runner:v0.1.0
```

Images already on the host are reused, so pull explicitly after changing a tag.

### Rolling back

Downgrade migrations are not provided. To roll back to an older release, restore the `data/` backup and key you took before upgrading, then start the older images.

## Upgrade notes

### File ownership after switching runtimes

Rootless Podman data already belongs to your host user. Data created by a rootful deployment may be owned by root: stop Carmel Agent, back it up, and correct the ownership of the affected data directories before restarting. Carmel Agent does not recursively change ownership of workspaces or mounts.

### Very old deployments

Upgrades from older deployments no longer run their one-time conversions. A database created before migration tracking, or one whose agent memories were never moved to Home, must first start once on image `ghcr.io/mudkipme/carmel-agent:bfe736ac7592bd0c75e23efbb0603fde514946d4` (with the matching runner tag), then upgrade to the current release. Inputs queued under the old messaging-app routing are marked interrupted instead of being run.

### Moving from a private registry

Replace the server and runner image names with the GHCR defaults while keeping the data directory, UID/GID, and **the same encryption key**. Setting a key does not encrypt older plaintext credential rows; re-save provider credentials and environment secrets to encrypt them.

### Runner scratch space

Runner `/tmp` is cleared whenever a runner is removed — idle cleanup, aborts, configuration changes, and server restarts. Startup also removes scratch left by older versions or crashed runners after confirming those runners are gone. Installed tools and browser sign-ins in `/home/agent` survive.
