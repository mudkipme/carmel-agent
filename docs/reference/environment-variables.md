# Environment variables

Carmel Agent is configured with environment variables. It reads `.env`, `.env.local`, `packages/server/.env`, and `packages/server/.env.local` at startup; variables set directly, for example in Compose, take precedence over the files.

With Compose, put settings in the `.env` next to `compose.yaml`. Variables that `compose.yaml` does not pass through already need to be added under its `environment:` section.

## Core

| Variable                | Default                              | Description                                                                                                                 |
| ----------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `HOST`                  | `127.0.0.1` (`0.0.0.0` in the image) | Address the server binds to.                                                                                                |
| `PORT`                  | `8797`                               | Port for the API and web client.                                                                                            |
| `NODE_ENV`              | `production` in the image            | Set to `production` for real deployments. Enables secure cookies and requires `CARMEL_SECRET_KEY`.                          |
| `CARMEL_PUBLIC_URL`     | —                                    | The absolute URL people open Carmel Agent at. Required for SSO; used for messaging-app `/web` links and links agents write. |
| `CARMEL_AGENT_DATA_DIR` | `data` (`/data` in the image)        | Base directory for databases, workspaces, and runtime state.                                                                |
| `DATABASE_URL`          | `data/carmel-agent.sqlite`           | SQLite database for metadata and accounts.                                                                                  |
| `CARMEL_PI_SESSION_DIR` | `data/pi-sessions.sqlite.durable/`   | Directory of per-session conversation databases. See [Session storage](/development/session-storage).                       |
| `CLIENT_DIST_DIR`       | Built-in                             | Override the directory of the built web client.                                                                             |

## Secrets

| Variable            | Default | Description                                                                                                                                           |
| ------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CARMEL_SECRET_KEY` | —       | Encrypts provider API keys, OAuth credentials, environment and session secrets, and messaging-app credentials. Required by Compose and in production. |

Generate it once with `openssl rand -hex 32`, set it before adding any credentials, and back it up with your data. If it changes, existing encrypted values can no longer be decrypted.

Development can run without a key, in which case credentials are stored in plain text — use disposable credentials there. Messaging-app integrations and credentials submitted through chat forms always require a key.

## Browser and proxy security

| Variable                 | Default | Description                                                                                                                                    |
| ------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `CARMEL_ALLOWED_ORIGINS` | —       | Comma-separated extra browser origins allowed to make cookie-authenticated changes, for when the web client is served from a different origin. |
| `CARMEL_TRUSTED_PROXY`   | —       | Comma-separated IPs of trusted reverse proxies. `X-Forwarded-For` and `X-Forwarded-Host` are honored only from these addresses.                |

See [Production setup](/self-hosting/production#reverse-proxy).

## Single sign-on

OIDC is off until `CARMEL_OIDC_ISSUER` is set. See [Users and sign-in](/self-hosting/users-and-sign-in#single-sign-on-openid-connect) for a walkthrough.

| Variable                             | Default                             | Description                                                                                                |
| ------------------------------------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `CARMEL_OIDC_ISSUER`                 | —                                   | **Required.** Issuer URL. Carmel Agent reads `<issuer>/.well-known/openid-configuration`.                  |
| `CARMEL_OIDC_CLIENT_ID`              | —                                   | **Required.** Client ID from the provider.                                                                 |
| `CARMEL_OIDC_CLIENT_SECRET`          | —                                   | Client secret. Leave unset for a public client; PKCE is always used.                                       |
| `CARMEL_OIDC_PROVIDER_NAME`          | `SSO`                               | Name on the sign-in button.                                                                                |
| `CARMEL_OIDC_SCOPES`                 | `openid profile email` (+ `groups`) | Space- or comma-separated scopes. `groups` is added automatically only when you don't set this variable.   |
| `CARMEL_PASSWORD_LOGIN`              | `true`                              | Set to `false` to make SSO the only sign-in method. Requires OIDC.                                         |
| `CARMEL_OIDC_MATCH_BY`               | `email,username`                    | How a first-time identity is matched to an existing account: `username`, `email`, either order, or `none`. |
| `CARMEL_OIDC_AUTO_CREATE`            | `true`                              | Create an account when nothing matches. `false` allows only pre-created accounts.                          |
| `CARMEL_OIDC_REQUIRE_VERIFIED_EMAIL` | `true`                              | Only match by email when `email_verified` is true.                                                         |
| `CARMEL_OIDC_USERNAME_CLAIM`         | `preferred_username`                | Claim used for the username.                                                                               |
| `CARMEL_OIDC_EMAIL_CLAIM`            | `email`                             | Claim used for the email.                                                                                  |
| `CARMEL_OIDC_NAME_CLAIM`             | `name`                              | Claim used for the display name.                                                                           |
| `CARMEL_OIDC_GROUPS_CLAIM`           | `groups`                            | Claim used for group membership.                                                                           |
| `CARMEL_OIDC_ALLOWED_GROUPS`         | —                                   | Comma-separated. Only members of these groups can sign in.                                                 |
| `CARMEL_OIDC_ADMIN_GROUPS`           | —                                   | Comma-separated. Members are administrators and everyone else is a user, re-checked at every sign-in.      |

## Run limits

| Variable                            | Default           | Description                                                  |
| ----------------------------------- | ----------------- | ------------------------------------------------------------ |
| `CARMEL_AGENT_MAX_TOOL_CALLS`       | `250`             | Tool calls one run may complete before it is stopped.        |
| `CARMEL_AGENT_STALL_TIMEOUT_MS`     | `900000` (15 min) | How long a run may go without activity before it is stopped. |
| `CARMEL_AGENT_REQUEST_TIMEOUT_MS`   | `600000` (10 min) | Deadline for a single provider request.                      |
| `CARMEL_AGENT_MAX_CONCURRENT_TASKS` | `2`               | Scheduled runs allowed at once.                              |

## Web tools

| Variable      | Default | Description                                               |
| ------------- | ------- | --------------------------------------------------------- |
| `EXA_API_KEY` | —       | Enables the `exa_search` tool for agents with Web access. |

`fetch_url` needs no key: it fetches pages directly and extracts their main content locally with [Defuddle](https://github.com/kepano/defuddle).

## Sandbox

| Variable                      | Default                                       | Description                                                                                                                               |
| ----------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `CARMEL_PODMAN_SOCKET`        | Auto-detected                                 | Path to the container API socket. Works with Podman and Docker. See [socket detection](/self-hosting/sandbox#container-socket-detection). |
| `CARMEL_HOST_UID`             | Server process UID                            | Non-zero host UID for runner commands and file ownership. Required when the server is containerized; must match the server's UID.         |
| `CARMEL_HOST_GID`             | Server process GID                            | Non-zero host GID, as above.                                                                                                              |
| `CARMEL_HOST_DATA_DIR`        | —                                             | Host path backing `CARMEL_AGENT_DATA_DIR`. Required when the server runs in a container.                                                  |
| `CARMEL_BASH_IMAGE`           | `ghcr.io/mudkipme/carmel-agent-runner:latest` | Runner image. Missing registry images are pulled on first use.                                                                            |
| `CARMEL_BASH_MEMORY_MB`       | `512`                                         | Memory cap per runner, in MB.                                                                                                             |
| `CARMEL_BASH_CPUS`            | `1`                                           | CPU limit per runner.                                                                                                                     |
| `CARMEL_BASH_PIDS_LIMIT`      | `512`                                         | Process limit per runner.                                                                                                                 |
| `CARMEL_BASH_IDLE_MINUTES`    | `15`                                          | Idle minutes before a runner is removed.                                                                                                  |
| `CARMEL_BASH_GPU`             | —                                             | Comma-separated CDI device IDs for runners, such as `nvidia.com/gpu=all`.                                                                 |
| `CARMEL_BASH_SELINUX_RELABEL` | `true`                                        | Relabel runner bind mounts with `:z`. Set `false` to disable.                                                                             |

## Knowledge

| Variable                             | Default                                        | Description                                                                                                                                                             |
| ------------------------------------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CARMEL_KNOWLEDGE_EMBED_MODEL`       | embeddinggemma-300M-Q8_0 (`hf:` URI)           | Embedding model for every agent: an `hf:` URI or an absolute GGUF path. Also the default `QMD_EMBED_MODEL` in shells. Restart and rebuild embeddings after changing it. |
| `CARMEL_KNOWLEDGE_IMAGE`             | `CARMEL_BASH_IMAGE`, then the published runner | Knowledge worker image. Must include qmd 2.8.3 and be pulled before use.                                                                                                |
| `CARMEL_KNOWLEDGE_MEMORY_MB`         | `4096`                                         | Memory limit per Knowledge worker, in MiB.                                                                                                                              |
| `CARMEL_KNOWLEDGE_CPUS`              | `2`                                            | CPU limit per Knowledge worker.                                                                                                                                         |
| `CARMEL_KNOWLEDGE_UPDATE_TIMEOUT_MS` | `900000` (15 min)                              | Deadline per index refresh, in milliseconds (at most `2147483647`).                                                                                                     |
| `CARMEL_KNOWLEDGE_EMBED_TIMEOUT_MS`  | `21600000` (6 h)                               | Deadline per embedding job, including model loading.                                                                                                                    |
| `CARMEL_KNOWLEDGE_GPU`               | Inherits `CARMEL_BASH_GPU`                     | CDI devices for Knowledge workers. Set it empty to disable passthrough.                                                                                                 |

The default embedding model is `hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf`. A local model file is mounted read-only; for a containerized server, make it visible at the same absolute host path or place it under the data directory.

## Compose only

These are read by `compose.yaml`, not by the server.

| Variable                | Default                                | Description                                           |
| ----------------------- | -------------------------------------- | ----------------------------------------------------- |
| `CARMEL_IMAGE`          | `ghcr.io/mudkipme/carmel-agent:latest` | Server image.                                         |
| `CARMEL_USERNS_MODE`    | `keep-id`                              | User namespace mode. Use `host` for rootful runtimes. |
| `CARMEL_RUNTIME_SOCKET` | Rootless Podman user socket            | Host socket mounted into the server.                  |
| `CARMEL_SOCKET_GID`     | `CARMEL_HOST_GID`                      | Group added to the server for socket access.          |

## Command line

| Variable          | Description                                                                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CARMEL_PASSWORD` | Password for the `user:create` command, instead of `--password`. See [Users and sign-in](/self-hosting/users-and-sign-in#creating-an-administrator-from-the-command-line). |

## Development

| Variable            | Description                                                                       |
| ------------------- | --------------------------------------------------------------------------------- |
| `CARMEL_SERVER_URL` | API address for the Vite dev server's proxy. Defaults to `http://localhost:8797`. |
| `CARMEL_DEV_HOSTS`  | Comma-separated extra hostnames the Vite dev server accepts, for LAN access.      |
| `PI_TELEMETRY`      | Set to `0` to disable Pi's provider attribution headers.                          |
