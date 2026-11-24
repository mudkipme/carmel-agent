# Security model

This page describes what Carmel Agent protects, how, and where the boundaries are. Read it before sharing agents with other people or giving agents access to sensitive systems.

To report a vulnerability, see [Reporting vulnerabilities](#reporting-vulnerabilities).

## Trust model

Carmel Agent treats these as **trusted**:

- **Administrators.** They manage accounts and provider credentials and can mount host folders into environments.
- **Configured MCP servers and custom skills.** They run with the agent's permissions and credentials.
- **The owner of a shared agent.** People using a shared agent act with the credentials its owner configured.

Agents themselves are **not** trusted with the host. They run with the permissions you give them, inside a container, and Carmel Agent enforces those boundaries regardless of what the model asks for.

## Accounts and authentication

Every account is an **administrator** or a **user** (see [Users and sign-in](/self-hosting/users-and-sign-in#roles)).

- The first-run setup endpoint refuses to run once any account has a password or a linked SSO identity, so it cannot be reused to create administrators.
- Browser sessions use cookies, marked secure in production. Mutating requests are checked against the server's origin and `CARMEL_ALLOWED_ORIGINS`. The server sets secure response headers.
- Repeated failed logins for the same username and source are rate limited. Forwarded client IPs are only trusted from `CARMEL_TRUSTED_PROXY`.
- API keys for the OpenAI-compatible endpoint are stored hashed, shown once, and revoked immediately.

### Single sign-on

OIDC uses the authorization code flow with PKCE, state, and nonce. Token and ID-token validation is done by [openid-client](https://github.com/panva/openid-client). A sign-in can only be finished in the browser that started it, and each attempt works once.

An identity is linked to its account by issuer and `sub`. Username or email is used only to find the account for a brand-new identity, and only as `CARMEL_OIDC_MATCH_BY` allows. Email matching requires a verified email and never picks an already-linked account. Errors redirect to the login page with a fixed error code, so a crafted link cannot inject its own text. See [How accounts are matched](/self-hosting/users-and-sign-in#how-accounts-are-matched) for the risks of username matching.

## Sharing and access

People can see agents they own and agents marked shared, and model entries they own, shared ones, and entries with no provider config behind them. Only owners can edit or delete their agents and model entries. Only administrators can change providers.

Sessions, Home, memory, tasks, schedules, and messaging-app integrations are always private to one person, even on a shared agent.

While a run is in progress, Carmel Agent refuses changes that would pull the ground out from under it: deleting or editing the model entry, provider, agent, or user account it depends on.

::: warning Sharing an agent shares its capabilities
A shared agent runs in its owner's environment. Everyone who can use it can make it use that environment's files, secrets, browser sign-ins, and MCP credentials — and ask it to print them. They cannot read secrets through Carmel Agent's interface, but the agent they drive can. Share an agent with secrets the way you would hand someone the credential.
:::

## Credentials at rest

Provider API keys, OAuth credentials, environment secrets, session credentials, and messaging-app credentials are encrypted with `CARMEL_SECRET_KEY` (AES-256-GCM for session credentials) before they are written to the database. Stored provider credentials and secrets are never returned by the API; the interface only reports whether they are present.

Without a key — which production startup refuses — these values are stored in plain text.

The `data/` directory remains sensitive even with encryption: it holds conversations, workspace files, browser profiles, and the encrypted credentials themselves.

## Sandbox isolation

Commands, terminals, browsers, and stdio MCP servers run in a runner container, not on the host:

- The container runs as your non-root host UID/GID, drops all capabilities, sets `no-new-privileges`, and has memory, CPU, and PID limits.
- Only the environment's workspace, home, scratch space, and configured mounts are mounted. The server's environment variables, databases, and container socket never are.
- Secret names that could redirect the shell or dynamic loader (`BASH_ENV`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, and similar) or that the sandbox sets itself (`HOME`, `PATH`, `TERM`, `LANG`) are rejected.
- Rootless Podman is recommended. Whoever can reach a rootful Docker socket effectively controls the host, which is a poor fit for agent workloads.

The isolation unit is the **environment**. Agents in one environment share one container, its files, browser, and secrets.

## File access

Server-side file tools run on the host but are confined to the environment's `/workspace`, `/tmp`, `/home/agent`, and mounts. Container paths are translated back to host paths before the server touches them, and absolute-path escapes are refused. Downloads and zip archives skip anything that resolves outside the workspace. The working folder's `.env` is read without following symlinks.

## Network access

Network access is explicit, at two levels:

- **Sandbox network access** (per environment) decides whether the runner container has a network at all. Without it, the container has no network.
- **Web access** (per agent) decides whether the agent gets `fetch_url`, `exa_search`, remote MCP servers, the built-in browser skill, and model downloads.

`fetch_url` extracts page content locally rather than through a third-party service. Some site-specific extractors may make additional requests (for example, a YouTube transcript or Reddit comments), so one call is not always exactly one request to exactly the requested host.

Messaging-app integrations run in the server process and only need outbound connections, independent of sandbox network settings.

## Environment secrets

Environment secrets are exported into sandbox commands and may be referenced by configured MCP connections. They are:

- **Write-only.** No endpoint returns a value. Only the environment's owner can add, replace, or delete them.
- **Read per command,** so rotation takes effect immediately and values never appear in the container's configuration.
- **Kept out of model context.** They are not given to `fetch_url` or `exa_search`, not substituted into prompts or templates, and only reach the model through something the agent itself runs.

### Output redaction

Secret values are replaced with `[redacted:NAME]` in command output before it is streamed or saved, and in tool results, details, diagnostics, and errors — including text read back from files. This stops an `env`, a `set -x`, or a verbose `curl` from writing a live credential into a transcript that is replayed to the model on every later turn. Values shorter than four characters are not matched.

Redaction is a guard against accidents, **not a containment boundary**. Code that has a secret can always encode or transmit it. A strict guarantee that agent code never sees a value would require a separate credential broker; environment injection deliberately gives the shell the value.

## Web terminal

The terminal is **owner-only** and requires the Run commands permission. It gives a shell with the environment's secrets and no redaction — nothing in it is saved or sent to a model, and rewriting a live terminal stream would corrupt it. Letting other users of a shared agent open it would let them read the owner's secrets with a single `echo`.

## Shared browser

The browser view is available to everyone who can use an agent with Run commands. Its profile belongs to the environment, so a sign-in grants every agent in the environment, and their users, access to that account.

Taking control pauses all agents in the environment: new tool calls wait, in-flight calls finish first, and stale calls queued across the handoff are discarded. This coordinates people and agents; it is not an isolation boundary against code running in the sandbox. No browser or debugging ports are published; frames and input are not stored in transcripts.

## Reporting vulnerabilities

Report vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/mudkipme/carmel-agent/security/advisories/new). Include the affected version or commit, reproduction steps using disposable credentials, and the impact. Keep live secrets and private transcripts out of public issues. See [SECURITY.md](https://github.com/mudkipme/carmel-agent/blob/main/SECURITY.md) for other contact options.

Security fixes target the current release and `main`.
