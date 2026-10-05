# Configuration

Carmel Agent reads `.env`, `.env.local`, `packages/server/.env`, and `packages/server/.env.local` before startup. Environment variables set directly (for example in Compose) work normally and take precedence over the files.

## Core Settings

- `HOST` — API bind host. Defaults to `127.0.0.1`; the container image sets `0.0.0.0`.
- `PORT` — API port. Defaults to `8797`.
- `NODE_ENV` — set to `production` in real deployments. Session cookies are marked secure only when it is.
- `DATABASE_URL` — Carmel metadata/auth SQLite path. Defaults to `data/carmel-agent.sqlite`.
- `CARMEL_PI_SESSION_DATABASE_URL` — legacy Pi SQLite path and base path for Durable storage. Defaults to `data/pi-sessions.sqlite`; native session databases live in its sibling `pi-sessions.sqlite.durable/` directory. See [Pi Durable storage](pi-durable.md).
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

The server applies secure headers, CORS for `/api/*`, cross-origin mutation checks, and cookie-based authentication (for password and single sign-on logins alike). Repeated failed logins for the same username and source are rate limited.

## Single Sign-On (OpenID Connect)

Carmel can sign people in through any OpenID Connect provider. It is tested against [Pocket ID](https://pocket-id.org), and anything that serves a standard discovery document (Authelia, Authentik, Keycloak, Zitadel, and so on) works the same way. OIDC is off until `CARMEL_OIDC_ISSUER` is set, and it is configured only through environment variables. A misconfigured variable stops the server at startup with a message naming it.

### Required

- `CARMEL_OIDC_ISSUER` — the provider's issuer URL, for example `https://id.example.com`. Carmel reads `<issuer>/.well-known/openid-configuration`.
- `CARMEL_OIDC_CLIENT_ID` — the client ID from the provider.
- `CARMEL_PUBLIC_URL` — the URL people open Carmel at, for example `https://carmel.example.com`. The redirect URI to register with the provider is `<CARMEL_PUBLIC_URL>/api/auth/oidc/callback`, and the server logs it at startup.

### Optional

- `CARMEL_OIDC_CLIENT_SECRET` — the client secret. Leave it unset for a public client, which then authenticates with PKCE only. PKCE (S256) is used either way.
- `CARMEL_OIDC_PROVIDER_NAME` — the name on the sign-in button ("Sign in with …"). Defaults to `SSO`.
- `CARMEL_OIDC_SCOPES` — space- or comma-separated scopes. Defaults to `openid profile email`, and `groups` is added when either group setting below is set. If you set this variable, your value is used exactly as given, so include `groups` yourself if you need it.
- `CARMEL_PASSWORD_LOGIN` — set to `false` to turn off username/password sign-in and the first-run setup form, so SSO is the only way in. Defaults to `true`. It can only be turned off when OIDC is configured.

### Account mapping

The first time someone signs in, Carmel decides which account they get. It links their provider identity (the issuer plus the `sub` claim) to that account. Every later sign-in uses that link, so changing a username or email at the provider cannot move them onto someone else's account.

- `CARMEL_OIDC_MATCH_BY` — how a first-time identity is matched to an **existing** Carmel account: `username`, `email`, `username,email`, or `email,username` (tried in that order), or `none` to never link to existing accounts. Defaults to `email,username`.
  - `username` compares the username claim with the Carmel username, ignoring case (Pocket ID only allows lowercase usernames).
  - `email` compares emails case-insensitively. It only uses an email the provider marks as verified (see below), and it never picks an account that is already linked to another identity.
  - If more than one account matches, or the username matches an account already linked to a different identity, sign-in is refused and nothing is guessed.
  - Matching trusts the provider's usernames and emails. If people can change their own username at the provider, someone could take a name that belongs to an existing, not-yet-linked Carmel account (an admin's, for example) before its owner first signs in with SSO. If that's a concern, turn off self-service account editing at the provider, or use `email` (verified only) or `none`.
  - With `none`, or a single field, a person who already has an account can end up with a second one. When a new account is created even though an unlinked account has the same username or email, the server logs a warning that names the variable to set. To fix an account created this way, delete it under **Settings → Users** (which also removes its SSO link), adjust the variable, and sign in again.
- `CARMEL_OIDC_AUTO_CREATE` — create a new account when nothing matches. Defaults to `true`. Set it to `false` to allow only accounts an administrator has created in advance (matched by username or email).
- `CARMEL_OIDC_REQUIRE_VERIFIED_EMAIL` — only match by email when the `email_verified` claim is true. Defaults to `true`. This applies to matching only: the email is still stored and shown either way.
- `CARMEL_OIDC_USERNAME_CLAIM`, `CARMEL_OIDC_EMAIL_CLAIM`, `CARMEL_OIDC_NAME_CLAIM`, `CARMEL_OIDC_GROUPS_CLAIM` — which claims to read. The defaults are `preferred_username`, `email`, `name`, and `groups`.

On every sign-in, the account's name and email are updated from the provider. The username is set once, when the account is created, and never changed afterwards, because it is also the password login name. If that username is already taken by a local account, the new account is created without one.

When nobody can sign in yet, the first account to sign in through OIDC is created as the administrator (unless `CARMEL_OIDC_ADMIN_GROUPS` is set). It takes over the default agent and model, exactly as the setup form does.

### Groups

- `CARMEL_OIDC_ALLOWED_GROUPS` — comma-separated. When set, only members of at least one of these groups can sign in.
- `CARMEL_OIDC_ADMIN_GROUPS` — comma-separated. When set, the provider controls roles: members are admins and everyone else is a regular user, checked again on every sign-in. Changing a role under **Settings → Users** only lasts until that person's next sign-in. The very first account also follows this rule, so make sure you are in one of these groups before you sign in.

### Pocket ID example

In Pocket ID, open **OIDC Clients → Add OIDC Client**, set the callback URL to `https://carmel.example.com/api/auth/oidc/callback`, and create a client secret. To use groups, create them under **User Groups** and add people to them.

```yaml
environment:
  CARMEL_PUBLIC_URL: https://carmel.example.com
  CARMEL_OIDC_ISSUER: https://id.example.com
  CARMEL_OIDC_CLIENT_ID: 00000000-0000-0000-0000-000000000000
  CARMEL_OIDC_CLIENT_SECRET: from-pocket-id
  CARMEL_OIDC_PROVIDER_NAME: Pocket ID
  CARMEL_OIDC_ADMIN_GROUPS: carmel-admins
```

Pocket ID reports `email_verified: false` until a user verifies their email in Pocket ID, so with the default settings Pocket ID users are matched by username. If your Pocket ID emails are admin-managed and trustworthy, set `CARMEL_OIDC_REQUIRE_VERIFIED_EMAIL=false` to match by email as well.

### Operational notes

- A sign-in in progress is remembered in server memory for up to 10 minutes. A restart during that window only means clicking the button again.
- An issuer on plain `http://` is accepted, but the server logs a warning. Use HTTPS for anything other than local testing.
- Signing out ends the Carmel session only. It does not sign you out of the provider.
- Accounts that only use SSO have no password. If one also needs password login and has a username, an administrator can set a password for it under **Settings → Users**.

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

## OpenAI-Compatible API

Every user can create API keys under **Settings → API Keys** and use them with any OpenAI-compatible client:

```text
Base URL: https://<your-carmel-host>/v1
Authorization: Bearer carmel-...
```

- `GET /v1/models` lists the models the key's user can pick in the app (their own, shared, and unbound ones). Model IDs are `provider/modelId`, e.g. `anthropic/claude-sonnet-5`; if two visible entries share that name, both are listed by their model entry ID instead.
- `POST /v1/chat/completions` supports streaming (`stream`, `stream_options.include_usage`), `tools`, `tool_choice` (`auto`/`none`; `required` and named functions fall back to `auto`), `temperature`, `top_p`, `max_tokens`/`max_completion_tokens`, and `reasoning_effort`. Reasoning text is returned as `reasoning_content`.
- **Tools are passed through.** Carmel does not run tool calls on this endpoint: they come back as `tool_calls`, and your client sends the results as `tool` messages on its next request, the same as with OpenAI.
- Requests go out through Pi with the model's server-side credentials, so the provider sees Pi's `User-Agent` and attribution headers. None of the caller's headers are forwarded, and the Carmel key never reaches the provider.
- Images must be base64 `data:` URLs; the server does not fetch remote image URLs. `n > 1` and structured `response_format` are rejected.
- Pi's session ID (used by some providers for prompt-cache routing) is derived from the conversation's system prompt and first user message. A client can send `x-session-id` to set it explicitly.

Keys are stored hashed and shown only once when created. Revoking a key, or deleting its user, takes effect immediately.

## Network Tools

- `EXA_API_KEY` — enables `exa_search`.

Network tools are only added to a run when the agent has the network permission.

`fetch_url` needs no key at all. It fetches the URL directly and, for its default `markdown` format, extracts the page's main content locally with [Defuddle](https://github.com/kepano/defuddle) — the extractor behind Obsidian Web Clipper — dropping navigation, ads, and boilerplate. Non-HTML responses and the `html`/`text` formats return the response body as sent. `exa_search` is the only network tool that reports a missing key.

## Bash Sandbox Settings

- `CARMEL_PODMAN_SOCKET` — path to the container API socket. Supports rootless Podman and rootful Podman/Docker; the name is historical. Rootless Docker and Docker with `userns-remap` are unsupported. Auto-detected in order from `DOCKER_HOST` (when it is a `unix://` path), `$XDG_RUNTIME_DIR/podman/podman.sock`, `/run/podman/podman.sock`, then `/var/run/docker.sock`.
- `CARMEL_HOST_UID` / `CARMEL_HOST_GID` — nonzero host UID/GID for runner commands and file ownership. Set both when the server is containerized; otherwise they default to the server process IDs. The server must also run as these IDs. Rootless Podman requires its daemon to run as this same host user and uses `keep-id` for runners.
- `CARMEL_BASH_IMAGE` — image used for bash sessions. Defaults to `localhost/carmel-agent-runner:latest`. Non-`localhost/` images are pulled on first use.
- `CARMEL_BASH_MEMORY_MB` — per-container memory cap in MB. Defaults to `512`.
- `CARMEL_BASH_CPUS` — per-container CPU limit. Defaults to `1`.
- `CARMEL_BASH_PIDS_LIMIT` — per-container PID cap. Defaults to `512`.
- `CARMEL_BASH_IDLE_MINUTES` — idle timeout before a sandbox container is reaped. Defaults to `15`.
- `CARMEL_BASH_GPU` — comma-separated CDI device ids to attach to runner containers, for example `nvidia.com/gpu=all`.
- `CARMEL_BASH_SELINUX_RELABEL` — relabel runner bind mounts for SELinux with `:z`. Defaults to `true`; set to `false` if relabeling is unwanted.
- `CARMEL_HOST_DATA_DIR` — host path backing `CARMEL_AGENT_DATA_DIR`. Required only when Carmel Agent itself runs in a container, because runner bind mounts are resolved by the host's container runtime.

The runner image defines the toolchain bash agents get. The default `Dockerfile.runner` includes:

- Shell and file tools: bash, git, ripgrep, `fd` (also available as `fdfind`), jq, file, less, tree, patch, and rsync.
- Network diagnostics and clients: curl, wget, `ip`, `ss`, netstat, dig, nslookup, `nc`, and the OpenSSH client.
- Process inspection: ps, top, pgrep, and lsof.
- Archives: tar, gzip, zip/unzip, xz, and zstd.
- Development: Node.js/npm, Python/pip/venv, C/C++ compilers, make, pkg-config, and Python development headers for native package builds.
- Browser and search: Chromium, `agent-browser`, and `qmd`.

Network utilities use the agent's existing network permission. Diagnostic tools run with the same non-root identity and dropped capabilities as other commands.

Commands run without root, including terminal and MCP commands. npm global installs use the persistent agent home; Python/pip default to a persistent virtual environment there. Custom runner images must provide Node, `/usr/bin/python3`, and working `python3 -m venv`. Startup checks identity, mounted directory access/ownership, and initializes the virtual environment before agent execution.

Compose-only settings: `CARMEL_USERNS_MODE` defaults to `keep-id`; use `host` for rootful runtimes. `CARMEL_RUNTIME_SOCKET` overrides the host socket bind, and `CARMEL_SOCKET_GID` adds its group to the server. These do not override runner runtime detection. See [deployment.md](deployment.md#using-docker).

## CLI Options

- `CARMEL_PASSWORD` — password for `pnpm --filter @carmel-agent/server user:create`, as an alternative to `--password`. See [deployment.md](deployment.md#creating-an-admin-from-the-cli).
